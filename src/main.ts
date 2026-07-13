/**
 * Cocos Creator 编辑器扩展入口
 *
 * 触发方式（在 package.json contributions 里都已声明）：
 *  · 资源面板右键 prefab → "ViewWeaver: 生成 PrefabView"      → generateFromAsset
 *  · 顶部菜单 Tools > ViewWeaver > 打开面板                  → openPanel
 *  · 顶部菜单 Tools > ViewWeaver > 全量重生                  → regenerateAll
 *  · 顶部菜单 Tools > ViewWeaver > 校验所有                  → validateAll
 *  · prefab 文件改动监听（默认关闭，开关在面板里）       → onAssetChange
 */

/// <reference path="../types/editor.d.ts" />

import * as path from "node:path";
import * as fs from "node:fs";

import { runOnce, type Logger, TOOL_VERSION } from "./core/RunOnce.ts";
import {
  resolvePrefabLayout,
  looksLikeCocosRoot,
  inferProjectRoot,
} from "./core/ProjectLayout.ts";
import { RegistryManager, type RegistryEntry } from "./core/RegistryManager.ts";
import { basenameNoExt } from "./utils/paths.ts";
import { parsePrefabFile, type ParsedNode, type ParsedPrefab } from "./parsers/PrefabParser.ts";
import {
  type BindConfig,
  type BindNodeEntry,
  loadBindConfig,
  makeDefaultBindConfig,
  saveBindConfig,
} from "./generators/BindJsonManager.ts";
import { ScriptTypeRegistry } from "./core/ScriptTypeRegistry.ts";

// =====================================================================
// Inspector ↔ main 跨进程数据契约
// =====================================================================

/** 序列化给 inspector 渲染的精简节点信息（不含父引用，避免循环） */
interface SerializedNode {
  rawId: number;
  name: string;
  path: string;
  active: boolean;
  /** 子节点 path 列表（按 _children 顺序） */
  children: SerializedNode[];
  /** 该节点上的组件，仅暴露给 inspector 的最少字段 */
  components: SerializedComponent[];
}

interface SerializedComponent {
  rawType: string;
  /** 解析后的 TS 类名；未解析时 undefined */
  tsName?: string;
  /** 解析后的 import 路径；undefined 表示 cc.* 内置或未解析 */
  importFrom?: string;
  /** 同节点同类组件的索引（0 起） */
  indexAmongSameType: number;
  /** 是 cc.* 内置组件 */
  builtin: boolean;
}

interface PrepareConfigResult {
  ok: true;
  prefabName: string;
  prefabAbsPath: string;
  prefabRelPath: string;
  bindJsonPath: string;
  genTsPath: string;
  /** 是否磁盘上已经有 bind.json（true → config 是已有的；false → 默认配置） */
  hasExistingBind: boolean;
  /** 用户当前应当看到的 config（已有 bind 优先；否则 default） */
  config: BindConfig;
  /** 即使有已有 bind 也算一份默认配置，便于面板里"重置为默认"按钮 */
  defaultConfig: BindConfig;
  /** 序列化的节点树，供面板渲染 */
  tree: SerializedNode;
  /** 解析后的总 unknown 组件实例数 / 已解析数（用于面板顶部展示） */
  scriptResolveStats?: { resolved: number; totalUnknown: number };
}

interface ApplyAndGenerateResult {
  ok: boolean;
  prefabName: string;
  outFile?: string;
  bindJsonPath?: string;
  durations?: { total: number; parse: number; resolve: number; generate: number; write: number };
  scriptResolve?: { resolved: number; totalUnknown: number };
  error?: { phase: string; message: string };
}

interface NodeStatusResult {
  /** prefab 是否找到 */
  prefabFound: boolean;
  /** 该 nodePath 是否在 bind.json 里 */
  exported: boolean;
  /** 已导出时返回字段名 */
  field?: string;
  /** 是否暴露 Node（false = 只暴露其上的组件） */
  exposeNode?: boolean;
  /** 已暴露的组件类型清单 */
  exposedComponents?: string[];
  /** 总组件数（含未暴露的） */
  totalComponents?: number;
  /** bind.json 是否存在 */
  hasBindJson: boolean;
  /** prefab 文件路径（debug 用） */
  prefabAbsPath?: string;
}

// =====================================================================
// 日志 helper
//
// 不依赖 Editor.Logger（不同版本 API 不一致，3.8.8 实测会抛 TypeError），
// 直接用 console.{log|warn|error} —— Cocos 控制台会按级别染色，
// 与项目里其他扩展（fg-tool-man / fg_zipbundle）的做法一致。
// =====================================================================

const log = {
  info: (...args: unknown[]): void => console.log("[viewweaver]", ...args),
  warn: (...args: unknown[]): void => console.warn("[viewweaver]", ...args),
  error: (...args: unknown[]): void => console.error("[viewweaver]", ...args),
};

// =====================================================================
// 结果弹窗封装
//
// 统一所有 Editor.Dialog 的入口，保证：
//   1. 只有一个「确定」按钮（历史上不传 buttons 时会渲染成 "Cancel"，语义不对）；
//   2. 手动触发（右键 / 菜单）才弹窗；AI / 自动化调用一律静默（只写 console）。
// =====================================================================

/** 单一确认按钮文案，避免默认渲染成 Cancel */
const OK_BUTTONS = ["确定"];

/** 只在非静默模式下弹结果窗；静默模式仅落 console。 */
function showDialog(
  kind: "info" | "warn" | "error",
  message: string,
  detail: string,
  opts?: { silent?: boolean }
): void {
  if (opts?.silent) return;
  Editor.Dialog[kind](message, { detail, buttons: OK_BUTTONS, default: 0 });
}

// =====================================================================
// 扩展运行时状态
// =====================================================================

interface ExtensionState {
  /** 是否启用「prefab 保存自动重生」的监听 */
  autoRegenOnSave: boolean;
  /** 上一次操作的项目根（缓存） */
  cachedProjectRoot?: string;
}

const state: ExtensionState = {
  autoRegenOnSave: false,
};

// =====================================================================
// 生命周期
// =====================================================================

export function load(): void {
  log.info(`v${TOOL_VERSION} loaded`);
  log.info(`  project = ${safeProjectRoot() ?? "<unknown>"}`);
}

export function unload(): void {
  log.info(`unloaded`);
}

// =====================================================================
// 消息处理（package.json#contributions.messages）
// =====================================================================

export const methods = {
  /** 资源面板右键 prefab 触发 */
  async generateFromAsset(...args: unknown[]): Promise<void> {
    try {
      const prefabAbs = await resolveSelectedPrefab(args);
      if (!prefabAbs) {
        warn("没有选中的 prefab。请在「资源管理器」中右键一个 .prefab 再触发本菜单。");
        return;
      }
      const result = await generateOne(prefabAbs, "extension");
      notifyResult(result);
    } catch (e) {
      log.error(`generateFromAsset error:`, (e as Error).stack ?? e);
      showDialog("error", "ViewWeaver 生成失败", (e as Error).message);
    }
  },

  /** 顶部菜单：打开面板（v0.2 阶段 2 才会真正实现 panel 内容） */
  openPanel(): void {
    Editor.Message.send("viewweaver", "open-panel");
    log.warn(`panel 尚未实现（v0.2 阶段 2）。当前可用：右键 prefab → 生成 PrefabView`);
  },

  /** 顶部菜单：全量重生（按 registry 里登记的所有 prefab） */
  async regenerateAll(): Promise<void> {
    try {
      const root = mustProjectRoot();
      const registry = new RegistryManager(root);
      const entries = registry.list();
      if (entries.length === 0) {
        showDialog(
          "info",
          "viewweaver",
          "registry 为空，没有可重生的 prefab。\n请先用右键菜单生成至少一个 prefab。"
        );
        return;
      }
      log.info(`regenerating ${entries.length} prefab(s) ...`);
      const results: { name: string; ok: boolean; msg: string }[] = [];
      for (const e of entries) {
        const prefabAbs = path.join(root, e.prefabPath);
        if (!fs.existsSync(prefabAbs)) {
          results.push({
            name: e.prefabName,
            ok: false,
            msg: `prefab missing: ${e.prefabPath}`,
          });
          continue;
        }
        const result = await generateOne(prefabAbs, "extension");
        results.push({
          name: e.prefabName,
          ok: result.ok,
          msg: result.ok
            ? `${result.durations.total}ms, ${result.code.length}B`
            : result.error?.message ?? "failed",
        });
      }
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      const detail = results
        .map((r) => `  ${r.ok ? "✓" : "✗"} ${r.name}  ${r.msg}`)
        .join("\n");
      showDialog(
        failCount > 0 ? "warn" : "info",
        `ViewWeaver 全量重生：${okCount} 成功 / ${failCount} 失败`,
        detail
      );
    } catch (e) {
      log.error(`regenerateAll error:`, (e as Error).stack ?? e);
      showDialog("error", "ViewWeaver 全量重生失败", (e as Error).message);
    }
  },

  /** 顶部菜单：校验所有 — 只看 bind.json 与当前 prefab 是否还匹配（不写盘） */
  async validateAll(): Promise<void> {
    try {
      const root = mustProjectRoot();
      const registry = new RegistryManager(root);
      const entries = registry.list();
      if (entries.length === 0) {
        showDialog("info", "viewweaver", "registry 为空");
        return;
      }
      const lines: string[] = [];
      for (const e of entries) {
        const prefabAbs = path.join(root, e.prefabPath);
        if (!fs.existsSync(prefabAbs)) {
          lines.push(`✗ ${e.prefabName}  prefab missing: ${e.prefabPath}`);
          continue;
        }
        const layout = resolvePrefabLayout({
          projectRoot: root,
          prefabName: e.prefabName,
        });
        const result = runOnce({
          prefabPath: prefabAbs,
          outDir: layout.outDir,
          bindPath: layout.bindJsonPath,
          mode: "dry-run",
          logger: silentLogger(),
        });
        if (!result.ok) {
          lines.push(`✗ ${e.prefabName}  ${result.error?.message ?? "failed"}`);
        } else if (result.issues.length > 0) {
          const errs = result.issues.filter((i) => i.level === "error");
          const warns = result.issues.length - errs.length;
          lines.push(`! ${e.prefabName}  ${errs.length} err / ${warns} warn`);
        } else {
          lines.push(`✓ ${e.prefabName}`);
        }
      }
      showDialog("info", `ViewWeaver 校验完成（${entries.length}）`, lines.join("\n"));
    } catch (e) {
      log.error(`validateAll error:`, (e as Error).stack ?? e);
      showDialog("error", "ViewWeaver 校验失败", (e as Error).message);
    }
  },

  /** 资源变化监听 — 仅在 autoRegenOnSave 启用时响应 */
  async onAssetChange(uuid: string): Promise<void> {
    if (!state.autoRegenOnSave) return;
    if (!uuid) return;
    try {
      const info = await queryAssetInfo(uuid);
      if (!info?.file?.endsWith(".prefab")) return;
      const root = mustProjectRoot();
      // 只重新生成已经在 registry 里登记过的 prefab，避免对未登记 prefab 误生成
      const reg = new RegistryManager(root);
      const prefabName = basenameNoExt(info.file);
      if (!reg.get(prefabName)) return;
      log.info(`auto-regen on save: ${prefabName}`);
      await generateOne(info.file, "auto-watch");
    } catch (e) {
      log.warn(`onAssetChange error: ${(e as Error).message}`);
    }
  },

  /** 由面板调用的 RPC：开关「保存自动重生」 */
  setAutoRegenOnSave(enabled: boolean): void {
    state.autoRegenOnSave = !!enabled;
    log.info(`auto-regen on save: ${state.autoRegenOnSave ? "ON" : "OFF"}`);
  },

  /**
   * AI / 自动化专用生成入口（无弹窗）。
   *
   * 与 `generateFromAsset`（手动右键）行为一致，但：
   *   · 全程不弹任何 Editor.Dialog，只写 console + 返回结构化结果；
   *   · 不依赖当前 selection，必须显式给出目标 prefab。
   *
   * 入参可为下列任一形式（按顺序尝试解析）：
   *   · prefab 的 uuid 字符串
   *   · prefab 的磁盘绝对路径（以 .prefab 结尾）
   *   · 对象 { uuid?, prefabPath?, file? }
   *
   * @returns 结构化结果，永不 throw（异常收敛进 error 字段）。
   */
  async generateForAI(...args: unknown[]): Promise<ApplyAndGenerateResult> {
    try {
      const prefabAbs = await resolvePrefabArg(args);
      if (!prefabAbs) {
        return {
          ok: false,
          prefabName: "?",
          error: {
            phase: "input",
            message:
              "未能解析目标 prefab。请传入 prefab 的 uuid、.prefab 绝对路径，或 { uuid | prefabPath }。",
          },
        };
      }
      const result = await generateOne(prefabAbs, "ai");
      // 静默：AI 调用不弹窗，仅日志已在 generateOne / notifyResult 内落 console
      notifyResult(result, { silent: true });
      return toApplyResult(result);
    } catch (e) {
      log.error(`generateForAI error:`, (e as Error).stack ?? e);
      return {
        ok: false,
        prefabName: "?",
        error: { phase: "fs", message: (e as Error).message },
      };
    }
  },

  // ===================================================================
  // Inspector ↔ main 通讯接口（v0.2 阶段 2B）
  // ===================================================================

  /**
   * Inspector 加载时拉数据：解析 prefab、加载/构造 bind config、
   * 序列化节点树。返回的 PrepareConfigResult 直接喂给面板渲染。
   */
  async preparePrefabConfig(uuid: string): Promise<PrepareConfigResult | { ok: false; message: string }> {
    try {
      const info = await queryAssetInfo(uuid);
      if (!info?.file?.endsWith(".prefab")) {
        return { ok: false, message: `not a prefab: ${uuid}` };
      }
      const prefabAbs = info.file;
      const root = mustProjectRoot();
      const prefabName = basenameNoExt(prefabAbs);
      const layout = resolvePrefabLayout({ projectRoot: root, prefabName });

      const parsed = parsePrefabFile(prefabAbs);
      runScriptTypeResolve(parsed, layout.genTsPath, root);

      const cwdRel = (abs: string) => path.relative(process.cwd(), abs).replace(/\\/g, "/");
      const defaultCfg = makeDefaultBindConfig(parsed, {
        prefabRelativePath: cwdRel(prefabAbs),
        outputPath: cwdRel(layout.genTsPath),
      });
      const existing = loadBindConfig(layout.bindJsonPath);

      return {
        ok: true,
        prefabName,
        prefabAbsPath: prefabAbs,
        prefabRelPath: relPosix(root, prefabAbs),
        bindJsonPath: layout.bindJsonPath,
        genTsPath: layout.genTsPath,
        hasExistingBind: !!existing,
        config: existing ?? defaultCfg,
        defaultConfig: defaultCfg,
        tree: serializeTree(parsed.root),
      };
    } catch (e) {
      log.error(`preparePrefabConfig error:`, (e as Error).stack ?? e);
      return { ok: false, message: (e as Error).message };
    }
  },

  /**
   * Inspector 点[生成]：用面板传来的 bindConfig 直接跑 runOnce
   */
  async applyAndGenerate(payload: {
    uuid: string;
    bindConfig: BindConfig;
  }): Promise<ApplyAndGenerateResult> {
    try {
      const info = await queryAssetInfo(payload.uuid);
      if (!info?.file?.endsWith(".prefab")) {
        return { ok: false, prefabName: "?", error: { phase: "fs", message: `not a prefab` } };
      }
      const prefabAbs = info.file;
      const root = mustProjectRoot();
      const prefabName = basenameNoExt(prefabAbs);
      const layout = resolvePrefabLayout({ projectRoot: root, prefabName });

      log.info(`apply-and-generate: ${prefabName} (from inspector)`);
      const result = runOnce({
        prefabPath: prefabAbs,
        outDir: layout.outDir,
        bindPath: layout.bindJsonPath,
        bindConfigOverride: payload.bindConfig,
        mode: "write",
        logger: editorLogger(),
      });
      if (!result.ok) {
        return {
          ok: false,
          prefabName,
          error: result.error,
          durations: { total: result.durations.total, parse: result.durations.parse, resolve: result.durations.resolve, generate: 0, write: 0 },
        };
      }
      // 更新 registry
      const reg = new RegistryManager(root);
      reg.upsert({
        prefabName,
        prefabPath: relPosix(root, prefabAbs),
        genTsPath: relPosix(root, result.outFile),
        bindJsonPath: relPosix(root, result.bindPath),
        viewTsPath: relPosix(root, result.viewFile),
        viewClassName: result.config.viewClassName,
        lastGenAt: new Date().toISOString(),
        lastGenBy: "inspector",
      });
      refreshAssetDb(layout.outDir);

      return {
        ok: true,
        prefabName,
        outFile: result.outFile,
        bindJsonPath: result.bindPath,
        durations: {
          total: result.durations.total,
          parse: result.durations.parse,
          resolve: result.durations.resolve,
          generate: result.durations.generate,
          write: result.durations.write,
        },
        scriptResolve: result.scriptResolve
          ? { resolved: result.scriptResolve.resolved, totalUnknown: result.scriptResolve.totalUnknown }
          : undefined,
      };
    } catch (e) {
      log.error(`applyAndGenerate error:`, (e as Error).stack ?? e);
      return { ok: false, prefabName: "?", error: { phase: "fs", message: (e as Error).message } };
    }
  },

  /**
   * Inspector 点[仅保存 bind]：把 bindConfig 写到磁盘但不生成 .gen.ts
   */
  async saveBindOnly(payload: {
    uuid: string;
    bindConfig: BindConfig;
  }): Promise<{ ok: boolean; bindJsonPath?: string; message?: string }> {
    try {
      const info = await queryAssetInfo(payload.uuid);
      if (!info?.file?.endsWith(".prefab")) {
        return { ok: false, message: `not a prefab` };
      }
      const root = mustProjectRoot();
      const prefabName = basenameNoExt(info.file);
      const layout = resolvePrefabLayout({ projectRoot: root, prefabName });
      saveBindConfig(layout.bindJsonPath, payload.bindConfig);
      refreshAssetDb(layout.outDir);
      log.info(`saved bind only: ${layout.bindJsonPath}`);
      return { ok: true, bindJsonPath: layout.bindJsonPath };
    } catch (e) {
      log.error(`saveBindOnly error:`, (e as Error).stack ?? e);
      return { ok: false, message: (e as Error).message };
    }
  },

  /**
   * 节点 inspector 用：根据当前选中节点的 prefab + path，
   * 查询在 bind.json 里是否被导出。
   */
  async queryNodeStatus(payload: {
    prefabUuid: string;
    nodePath: string;
  }): Promise<NodeStatusResult> {
    try {
      const info = await queryAssetInfo(payload.prefabUuid);
      if (!info?.file?.endsWith(".prefab")) {
        return { prefabFound: false, exported: false, hasBindJson: false };
      }
      const root = mustProjectRoot();
      const prefabName = basenameNoExt(info.file);
      const layout = resolvePrefabLayout({ projectRoot: root, prefabName });
      const bind = loadBindConfig(layout.bindJsonPath);
      if (!bind) {
        return {
          prefabFound: true,
          exported: false,
          hasBindJson: false,
          prefabAbsPath: info.file,
        };
      }
      const entry = bind.nodes.find((n) => n.path === payload.nodePath);
      return {
        prefabFound: true,
        exported: !!entry,
        field: entry?.field,
        exposeNode: entry?.exposeNode ?? true,
        exposedComponents: entry?.components?.map((c) => c.field ?? c.rawType) ?? [],
        totalComponents: entry?.components?.length ?? 0,
        hasBindJson: true,
        prefabAbsPath: info.file,
      };
    } catch (e) {
      log.warn(`queryNodeStatus error: ${(e as Error).message}`);
      return { prefabFound: false, exported: false, hasBindJson: false };
    }
  },

  /**
   * 节点 inspector 用：把当前选中节点切换为「已导出 / 未导出」。
   * expose=true 且 bind.json 不存在时，自动创建一份默认配置再修改。
   */
  async toggleNodeExport(payload: {
    prefabUuid: string;
    nodePath: string;
    expose: boolean;
  }): Promise<{ ok: boolean; bindJsonPath?: string; message?: string }> {
    try {
      const info = await queryAssetInfo(payload.prefabUuid);
      if (!info?.file?.endsWith(".prefab")) return { ok: false, message: "not a prefab" };
      const root = mustProjectRoot();
      const prefabName = basenameNoExt(info.file);
      const layout = resolvePrefabLayout({ projectRoot: root, prefabName });
      const cwdRel = (abs: string) => path.relative(process.cwd(), abs).replace(/\\/g, "/");
      const parsed = parsePrefabFile(info.file);
      runScriptTypeResolve(parsed, layout.genTsPath, root);

      let bind = loadBindConfig(layout.bindJsonPath);
      const defaultCfg = makeDefaultBindConfig(parsed, {
        prefabRelativePath: cwdRel(info.file),
        outputPath: cwdRel(layout.genTsPath),
      });
      if (!bind) bind = defaultCfg;

      if (payload.expose) {
        if (!bind.nodes.find((n) => n.path === payload.nodePath)) {
          // 从 default 里抄一份过来；否则新建一个最小条目
          const fromDefault = defaultCfg.nodes.find((n) => n.path === payload.nodePath);
          bind.nodes.push(
            fromDefault ?? {
              path: payload.nodePath,
              field: pathFallbackField(payload.nodePath),
              exposeNode: true,
              components: [],
            }
          );
        }
      } else {
        bind.nodes = bind.nodes.filter((n) => n.path !== payload.nodePath);
      }
      saveBindConfig(layout.bindJsonPath, bind);
      refreshAssetDb(layout.outDir);
      log.info(`toggle-node-export ${payload.expose ? "+" : "-"} ${payload.nodePath} → ${layout.bindJsonPath}`);
      return { ok: true, bindJsonPath: layout.bindJsonPath };
    } catch (e) {
      log.error(`toggleNodeExport error:`, (e as Error).stack ?? e);
      return { ok: false, message: (e as Error).message };
    }
  },
};

// =====================================================================
// 内部工具
// =====================================================================

function safeProjectRoot(): string | undefined {
  try {
    if (state.cachedProjectRoot && looksLikeCocosRoot(state.cachedProjectRoot)) {
      return state.cachedProjectRoot;
    }
    if (typeof Editor !== "undefined" && Editor.Project?.path) {
      state.cachedProjectRoot = Editor.Project.path;
      return state.cachedProjectRoot;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function mustProjectRoot(): string {
  const r = safeProjectRoot();
  if (!r) throw new Error("project root unknown — Editor.Project.path 不可用");
  return r;
}

/** 把右键传入的参数 / 当前 selection 解析为 prefab 绝对路径 */
async function resolveSelectedPrefab(args: unknown[]): Promise<string | undefined> {
  // 1) 直接传入 uuid 字符串
  for (const a of args) {
    if (typeof a === "string" && a.length > 0) {
      const info = await queryAssetInfo(a);
      if (info?.file?.endsWith(".prefab")) return info.file;
    }
  }
  // 2) selection
  try {
    const selectedUuids = Editor.Selection.getSelected("asset");
    for (const uuid of selectedUuids) {
      const info = await queryAssetInfo(uuid);
      if (info?.file?.endsWith(".prefab")) return info.file;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * AI / 自动化入口用的 prefab 解析：不看 selection，只认显式入参。
 * 支持 uuid 字符串、.prefab 绝对路径、或 { uuid | prefabPath | file } 对象。
 */
async function resolvePrefabArg(args: unknown[]): Promise<string | undefined> {
  const tryPath = (p?: unknown): string | undefined =>
    typeof p === "string" && p.endsWith(".prefab") && fs.existsSync(p) ? p : undefined;

  for (const a of args) {
    if (typeof a === "string" && a.length > 0) {
      // 先当磁盘路径，再当 uuid
      const asPath = tryPath(a);
      if (asPath) return asPath;
      const info = await queryAssetInfo(a);
      if (info?.file?.endsWith(".prefab")) return info.file;
    } else if (a && typeof a === "object") {
      const o = a as { uuid?: string; prefabPath?: string; file?: string };
      const asPath = tryPath(o.prefabPath) ?? tryPath(o.file);
      if (asPath) return asPath;
      if (o.uuid) {
        const info = await queryAssetInfo(o.uuid);
        if (info?.file?.endsWith(".prefab")) return info.file;
      }
    }
  }
  return undefined;
}

/** 把内部 GenerateResult 收敛成对外（AI / inspector）稳定的结构化结果 */
function toApplyResult(r: GenerateResult): ApplyAndGenerateResult {
  if (!r.ok) {
    return { ok: false, prefabName: r.prefabName, error: r.error };
  }
  return {
    ok: true,
    prefabName: r.prefabName,
    outFile: r.outFile,
    durations: r.durations,
    scriptResolve: r.scriptResolve
      ? { resolved: r.scriptResolve.resolved, totalUnknown: r.scriptResolve.totalUnknown }
      : undefined,
  };
}

async function queryAssetInfo(uuid: string): Promise<AssetInfo | undefined> {
  try {
    const info = await Editor.Message.request<AssetInfo | null>(
      "asset-db",
      "query-asset-info",
      uuid
    );
    return info ?? undefined;
  } catch {
    return undefined;
  }
}

interface GenerateResult {
  ok: boolean;
  prefabName: string;
  outFile: string;
  durations: { total: number; parse: number; resolve: number; generate: number; write: number };
  code: string;
  scriptResolve?: { resolved: number; totalUnknown: number; stillUnknown: string[] };
  error?: { phase: string; message: string };
}

async function generateOne(
  prefabAbs: string,
  source: "extension" | "auto-watch" | "ai"
): Promise<GenerateResult> {
  const root = mustProjectRoot();
  const prefabName = basenameNoExt(prefabAbs);
  const layout = resolvePrefabLayout({ projectRoot: root, prefabName });

  log.info(`generating ${prefabName} ...`);

  const result = runOnce({
    prefabPath: prefabAbs,
    outDir: layout.outDir,
    bindPath: layout.bindJsonPath,
    mode: "write",
    logger: editorLogger(),
  });

  if (!result.ok) {
    log.error(`failed: ${result.error?.message ?? "unknown"}`);
    return {
      ok: false,
      prefabName,
      outFile: result.outFile,
      durations: {
        total: result.durations.total,
        parse: result.durations.parse,
        resolve: result.durations.resolve,
        generate: result.durations.generate,
        write: result.durations.write,
      },
      code: "",
      error: result.error,
    };
  }

  // 更新 registry
  const reg = new RegistryManager(root);
  const entry: RegistryEntry = {
    prefabName: layout.prefabName,
    prefabPath: relPosix(root, prefabAbs),
    genTsPath: relPosix(root, result.outFile),
    bindJsonPath: relPosix(root, result.bindPath),
    viewTsPath: relPosix(root, result.viewFile),
    viewClassName: result.config.viewClassName,
    lastGenAt: new Date().toISOString(),
    lastGenBy: source,
  };
  reg.upsert(entry);

  // 通知 asset-db 刷新（让 Cocos 知道我们写了新文件）
  refreshAssetDb(layout.outDir);

  return {
    ok: true,
    prefabName,
    outFile: result.outFile,
    durations: {
      total: result.durations.total,
      parse: result.durations.parse,
      resolve: result.durations.resolve,
      generate: result.durations.generate,
      write: result.durations.write,
    },
    code: result.code,
    scriptResolve: result.scriptResolve
      ? {
          resolved: result.scriptResolve.resolved,
          totalUnknown: result.scriptResolve.totalUnknown,
          stillUnknown: result.scriptResolve.stillUnknown,
        }
      : undefined,
  };
}

function notifyResult(r: GenerateResult, opts?: { silent?: boolean }): void {
  if (r.ok) {
    log.info(`✓ ${r.prefabName}  ${r.durations.total}ms  ${r.code.length}B  → ${r.outFile}`);
    showDialog(
      "info",
      `ViewWeaver 生成成功`,
      `${r.prefabName}\n  ${r.durations.total}ms\n  ${r.code.length} bytes\n  ${r.outFile}`,
      opts
    );
  } else {
    showDialog(
      "error",
      "ViewWeaver 生成失败",
      `${r.prefabName}\n  ${r.error?.phase}: ${r.error?.message}`,
      opts
    );
  }
}

function refreshAssetDb(absPath: string): void {
  try {
    Editor.Message.request("asset-db", "refresh-asset", absPath).catch(() => {
      /* asset-db 拒绝刷新无需阻塞 */
    });
  } catch {
    /* ignore */
  }
}

function relPosix(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, "/");
}

function editorLogger(): Logger {
  return {
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    error: (m) => log.error(m),
  };
}

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function warn(msg: string): void {
  log.warn(msg);
  showDialog("warn", "viewweaver", msg);
}

// =====================================================================
// Inspector 用的工具函数
// =====================================================================

/**
 * 在 main 进程里跑一次 ScriptTypeRegistry.resolve，把 parsed 里的自定义脚本组件
 * 全部就地补上 typeInfo（与 RunOnce 内的逻辑一致，只不过 inspector 流程里
 * 我们想在跑 runOnce 之前就先看到完整 typeInfo）。
 */
function runScriptTypeResolve(parsed: ParsedPrefab, genTsAbsPath: string, projectRoot: string): void {
  if (parsed.stats.unknownComponents <= 0) return;
  const reg = new ScriptTypeRegistry(projectRoot);
  for (const c of parsed.allComponents) {
    if (c.typeInfo) continue;
    const info = reg.resolve(c.rawType, { genTsAbsPath });
    if (info) c.typeInfo = info;
  }
}

/** 把 ParsedNode 树压成 inspector 友好的纯数据（无父引用、无函数） */
function serializeTree(node: ParsedNode): SerializedNode {
  return {
    rawId: node.rawId,
    name: node.name,
    path: node.path,
    active: node.active,
    children: node.children.map(serializeTree),
    components: node.components.map((c) => ({
      rawType: c.rawType,
      tsName: c.typeInfo?.tsName,
      importFrom: c.typeInfo?.importFrom,
      indexAmongSameType: c.indexAmongSameType,
      builtin: c.typeInfo?.builtin ?? false,
    })),
  };
}

/**
 * `toggleNodeExport(expose=true)` 用兜底字段名：
 * 如果 default config 里没找到目标节点，就用一个不太好看但稳定的派生名。
 */
function pathFallbackField(nodePath: string): string {
  if (!nodePath) return "$root";
  return nodePath
    .replace(/\([0-9]+\)/g, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .join("_")
    .replace(/[^A-Za-z0-9_]/g, "_") || "node";
}
