/**
 * ViewWeaver 核心执行入口（无外部 IO 依赖，可被 CLI / Cocos 扩展 / 测试共用）
 *
 * 设计要点：
 * - 不直接 process.exit / console.log，所有可观察行为通过 logger 回调
 * - 所有路径在调用前已被解析为绝对路径（由调用方负责）
 * - 写文件采用 writeFileSafe（atomic-ish），并发同 prefab 由调用方串行
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { dumpTree, parsePrefabFile, type ParsedPrefab } from "../parsers/PrefabParser.ts";
import {
  type BindConfig,
  type BindValidationIssue,
  deriveBindJsonPath,
  loadBindConfig,
  makeDefaultBindConfig,
  saveBindConfig,
  validateBindAgainstPrefab,
} from "../generators/BindJsonManager.ts";
import { generateGenTs } from "../generators/GenTsGenerator.ts";
import { generateViewTs } from "../generators/ViewTsGenerator.ts";
import { writeFileSafe, basenameNoExt } from "../utils/paths.ts";
import { ScriptTypeRegistry } from "./ScriptTypeRegistry.ts";
import { inferProjectRoot } from "./ProjectLayout.ts";

export const TOOL_VERSION = "0.2.0";

/** 调用方意图：dry-run 模式下不写盘，便于"diff 预览" */
export type RunMode = "write" | "dry-run";

export interface RunOptions {
  /** prefab 文件绝对路径 */
  prefabPath: string;
  /** 生成文件输出目录（绝对路径）。若未提供：调用方必须自己决定，core 不再 fallback 到 prefab 同级 */
  outDir: string;
  /** bind.json 绝对路径。若未提供则放在 outDir/<prefabName>.bind.json */
  bindPath?: string;
  /** 即使 bind.json 已存在，也用默认配置覆盖（强制重生） */
  regenBind?: boolean;
  /** 没有 bind.json 时是否自动落盘默认配置（默认 true） */
  saveBindIfMissing?: boolean;
  /** 写盘模式 / 仅预览 */
  mode?: RunMode;
  /** 日志回调（CLI 打 stdout，扩展打 Cocos 控制台） */
  logger?: Logger;
  /** 工具自报版本号（默认 TOOL_VERSION） */
  toolVersion?: string;
  /**
   * 项目根目录（含 assets/）。用于解析 unknown 自定义组件的 UUID → 类名。
   * 未传则从 prefabPath 自动推断；推断失败则跳过自定义脚本解析。
   */
  projectRoot?: string;
  /** 关闭自定义脚本类型解析（v0.2 默认开启） */
  disableScriptTypeResolve?: boolean;
  /**
   * 直接传入 bindConfig（用于面板/Inspector 编辑后立即生成的场景）。
   * 设置后忽略磁盘上的 bind.json，也不会再走 makeDefaultBindConfig。
   * 仍按 mode === "write" 落盘 bind.json。
   */
  bindConfigOverride?: BindConfig;
}

export interface Logger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface RunResult {
  ok: boolean;
  prefabPath: string;
  outFile: string;
  bindPath: string;
  /** view.ts 绝对路径（即使没新生成，也是预期路径） */
  viewFile: string;
  /** 解析得到的 prefab 树 */
  parsed: ParsedPrefab;
  /** 实际使用的 bind 配置（已存在加载 / 否则按默认生成） */
  config: BindConfig;
  /** 是否使用了默认（即首次生成或被 regen 覆盖） */
  usedDefault: boolean;
  /**
   * view.ts 处理结果：
   *  - "created": 本次新建（首次生成）
   *  - "skipped-exists": 已存在，按"只生成一次"策略跳过
   *  - "dry-run": dry-run 模式不写盘
   */
  viewStatus: "created" | "skipped-exists" | "dry-run";
  /** view.ts 内容（无论是否真写盘都会渲染，便于 diff 预览） */
  viewCode: string;
  /** 校验结果（仅在加载已有 bind.json 时非空） */
  issues: BindValidationIssue[];
  /** 生成的 .gen.ts 代码（dry-run 也会有） */
  code: string;
  /** 耗时分段（毫秒） */
  durations: {
    parse: number;
    validate: number;
    /** 自定义脚本类型解析 */
    resolve: number;
    generate: number;
    write: number;
    total: number;
  };
  /** dry-run / write */
  mode: RunMode;
  /** 错误（错误时 ok=false，结构化暴露给调用方） */
  error?: { phase: "validate" | "fs" | "parse"; message: string; details?: BindValidationIssue[] };
  /** 自定义脚本类型解析统计（v0.2 阶段 3） */
  scriptResolve?: ScriptResolveStats;
}

export interface ScriptResolveStats {
  /** 总扫描的 .ts.meta 文件数 */
  tsMetaFiles: number;
  /**
   * 历史字段（保留向下兼容）：
   * 解析前 prefab 中"unknown 组件实例"数。
   * 等同于 `resolvedInstances + stillUnresolvedInstances`
   */
  totalUnknown: number;
  /** 已解析的 unknown 组件实例数 */
  resolved: number;
  /** 未解析的 unknown 组件实例数 */
  stillUnresolvedInstances: number;
  /** 已识别成业务脚本类型的 *unique 类型* 数 */
  uniqueResolvedTypes: number;
  /** 仍未识别的 *unique 类型* 数 */
  uniqueUnresolvedTypes: number;
  /** 仍未解析的 raw type 列表（去重，方便 debug） */
  stillUnknown: string[];
  /** 项目根（解析时使用的） */
  projectRoot?: string;
  /** 扫描耗时 */
  scanMs: number;
}

/**
 * 核心一次性生成流程：解析 → 加载/生成 bind → 校验 → 生成 .gen.ts → 落盘
 *
 * 调用方传入绝对路径与具体 outDir，core 不再做"如果没传就用 prefab 同级"这种 fallback，
 * 保持单一职责，让"输出策略"由调用方（CLI / Extension）决定。
 */
export function runOnce(options: RunOptions): RunResult {
  const log = makeSafeLogger(options.logger);
  const mode: RunMode = options.mode ?? "write";
  const t0 = Date.now();

  const prefabPath = options.prefabPath;
  if (!fs.existsSync(prefabPath)) {
    return earlyError(prefabPath, options.outDir, "fs", `prefab not found: ${prefabPath}`);
  }
  if (!path.isAbsolute(prefabPath)) {
    return earlyError(prefabPath, options.outDir, "fs", `prefabPath must be absolute: ${prefabPath}`);
  }
  if (!path.isAbsolute(options.outDir)) {
    return earlyError(prefabPath, options.outDir, "fs", `outDir must be absolute: ${options.outDir}`);
  }

  log.info(`parsing ${prefabPath} ...`);
  const tParse0 = Date.now();
  const parsed = parsePrefabFile(prefabPath);
  const tParse = Date.now() - tParse0;
  log.info(
    `parsed in ${tParse}ms: ` +
      `${parsed.stats.totalRaw} entries → ${parsed.stats.totalNodes} nodes, ` +
      `${parsed.stats.totalComponents} components ` +
      `(${parsed.stats.unknownComponents} unknown instances of ${parsed.stats.unknownTypeNames.length} unique types)`
  );

  const prefabName = basenameNoExt(prefabPath);
  const outFile = path.join(options.outDir, `${prefabName}.gen.ts`);
  const bindPath = options.bindPath ?? path.join(options.outDir, `${prefabName}.bind.json`);
  // view.ts 路径与 gen.ts 同目录、同 prefab 名，扩展名为 .view.ts。该文件 "只首次生成"。
  const viewFile = path.join(options.outDir, `${prefabName}.view.ts`);

  // 自定义脚本类型解析（v0.2 阶段 3）：把 unknown 组件的 UUID 解析为业务类型
  let scriptResolve: ScriptResolveStats | undefined;
  let tResolve = 0;
  if (!options.disableScriptTypeResolve && parsed.stats.unknownComponents > 0) {
    const tR0 = Date.now();
    const projectRoot = options.projectRoot ?? inferProjectRoot(prefabPath);
    if (projectRoot) {
      const registry = new ScriptTypeRegistry(projectRoot);
      const scan = registry.scan();
      const totalUnknownInstances = parsed.stats.unknownComponents;
      let resolvedInstances = 0;
      let stillUnresolvedInstances = 0;
      const stillUnknownSet = new Set<string>();
      const resolvedTypeSet = new Set<string>();
      for (const comp of parsed.allComponents) {
        if (comp.typeInfo) continue; // 已是 cc.* 内置组件，不动
        const info = registry.resolve(comp.rawType, { genTsAbsPath: outFile });
        if (info) {
          comp.typeInfo = info;
          resolvedInstances++;
          resolvedTypeSet.add(comp.rawType);
        } else {
          stillUnresolvedInstances++;
          stillUnknownSet.add(comp.rawType);
        }
      }
      parsed.stats.unknownComponents = stillUnresolvedInstances;
      parsed.stats.unknownTypeNames = Array.from(stillUnknownSet);
      tResolve = Date.now() - tR0;
      scriptResolve = {
        tsMetaFiles: scan.count,
        totalUnknown: totalUnknownInstances,
        resolved: resolvedInstances,
        stillUnresolvedInstances,
        uniqueResolvedTypes: resolvedTypeSet.size,
        uniqueUnresolvedTypes: stillUnknownSet.size,
        stillUnknown: Array.from(stillUnknownSet),
        projectRoot,
        scanMs: scan.elapsedMs,
      };
      log.info(
        `script-type-resolve: scanned ${scan.count} ts.meta in ${scan.elapsedMs}ms, ` +
          `resolved ${resolvedInstances}/${totalUnknownInstances} component instances ` +
          `(${resolvedTypeSet.size}/${resolvedTypeSet.size + stillUnknownSet.size} unique types)`
      );
    } else {
      log.warn(
        `script-type-resolve: cannot infer project root, skipping. Pass projectRoot explicitly.`
      );
    }
  }

  let config: BindConfig;
  let usedDefault = false;
  let issues: BindValidationIssue[] = [];

  // Inspector / Panel 传进来的 inline config 优先级最高
  if (options.bindConfigOverride) {
    log.info(`using inline bindConfigOverride from caller`);
    config = options.bindConfigOverride;
    const tVal0 = Date.now();
    issues = validateBindAgainstPrefab(config, parsed);
    const tVal = Date.now() - tVal0;
    const errs = issues.filter((i) => i.level === "error");
    if (errs.length > 0) {
      for (const e of errs) log.error(`  - ${e.message}`);
      return {
        ok: false,
        prefabPath,
        outFile,
        bindPath,
        viewFile,
        parsed,
        config,
        usedDefault: false,
        viewStatus: "skipped-exists",
        viewCode: "",
        issues,
        code: "",
        durations: { parse: tParse, validate: tVal, resolve: tResolve, generate: 0, write: 0, total: Date.now() - t0 },
        mode,
        error: {
          phase: "validate",
          message: `bind config has ${errs.length} error(s)`,
          details: errs,
        },
      };
    }
    for (const w of issues) log.warn(w.message);
    if (mode === "write") {
      saveBindConfig(bindPath, config);
      log.info(`wrote bind config: ${bindPath}`);
    }
  } else {

  const existing = !options.regenBind ? loadBindConfig(bindPath) : undefined;
  if (existing) {
    log.info(`loaded bind config: ${bindPath}`);
    config = existing;
    const tVal0 = Date.now();
    issues = validateBindAgainstPrefab(config, parsed);
    const tVal = Date.now() - tVal0;
    const errs = issues.filter((i) => i.level === "error");
    if (errs.length > 0) {
      for (const e of errs) log.error(`  - ${e.message}`);
      return {
        ok: false,
        prefabPath,
        outFile,
        bindPath,
        viewFile,
        parsed,
        config,
        usedDefault: false,
        viewStatus: "skipped-exists",
        viewCode: "",
        issues,
        code: "",
        durations: { parse: tParse, validate: tVal, resolve: 0, generate: 0, write: 0, total: Date.now() - t0 },
        mode,
        error: {
          phase: "validate",
          message: `bind config has ${errs.length} error(s)`,
          details: errs,
        },
      };
    }
    for (const w of issues) log.warn(w.message);
  } else {
    log.info(`no bind config found, creating default ...`);
    usedDefault = true;
    const cwdRel = (abs: string) => path.relative(process.cwd(), abs).replace(/\\/g, "/");
    config = makeDefaultBindConfig(parsed, {
      prefabRelativePath: cwdRel(prefabPath),
      outputPath: cwdRel(outFile),
    });
    const saveBind = options.saveBindIfMissing ?? true;
    if (saveBind && mode === "write") {
      saveBindConfig(bindPath, config);
      log.info(`wrote default bind config: ${bindPath}`);
    }
  }

  } // end of else (no bindConfigOverride)

  const tGen0 = Date.now();
  const bindRelForHeader = path
    .relative(process.cwd(), bindPath)
    .replace(/\\/g, "/");
  const code = generateGenTs(config, parsed, {
    toolVersion: options.toolVersion ?? TOOL_VERSION,
    bindRelativePath: bindRelForHeader,
  });
  // view.ts 也在 generate 阶段渲染（dry-run 也能看到内容）；写盘策略另算。
  const viewCode = generateViewTs(config, {
    toolVersion: options.toolVersion ?? TOOL_VERSION,
  });
  const tGen = Date.now() - tGen0;

  let tWrite = 0;
  let viewStatus: RunResult["viewStatus"] = "dry-run";
  if (mode === "write") {
    const tW0 = Date.now();
    writeFileSafe(outFile, code);
    // view.ts 只在不存在时写入：开发者首次生成后可放心改业务代码，不会被覆盖。
    if (fs.existsSync(viewFile)) {
      viewStatus = "skipped-exists";
      log.info(`view.ts already exists, kept user copy: ${viewFile}`);
    } else {
      writeFileSafe(viewFile, viewCode);
      viewStatus = "created";
      log.info(`wrote ${viewFile} (${viewCode.length} bytes, first time only)`);
    }
    tWrite = Date.now() - tW0;
    log.info(`wrote ${outFile} (${code.length} bytes)`);
  } else {
    log.info(`dry-run: would write ${outFile} (${code.length} bytes)`);
    log.info(
      `dry-run: ${
        fs.existsSync(viewFile) ? "would keep existing" : "would create"
      } ${viewFile} (${viewCode.length} bytes)`
    );
  }

  const total = Date.now() - t0;
  log.info(`done in ${total}ms${usedDefault ? " (default config)" : ""}`);

  return {
    ok: true,
    prefabPath,
    outFile,
    bindPath,
    viewFile,
    parsed,
    config,
    usedDefault,
    viewStatus,
    viewCode,
    issues,
    code,
    durations: { parse: tParse, validate: 0, resolve: tResolve, generate: tGen, write: tWrite, total },
    mode,
    scriptResolve,
  };
}

/** 仅打印解析后节点树（CLI --dump-tree 复用） */
export function runDumpTree(prefabPath: string): string {
  const parsed = parsePrefabFile(prefabPath);
  return dumpTree(parsed.root);
}

function makeSafeLogger(l?: Logger): Required<Logger> {
  return {
    info: l?.info ?? noop,
    warn: l?.warn ?? noop,
    error: l?.error ?? noop,
  };
}
function noop(_msg: string): void {
  /* discard */
}

function earlyError(
  prefabPath: string,
  outDir: string,
  phase: "fs" | "parse" | "validate",
  message: string
): RunResult {
  return {
    ok: false,
    prefabPath,
    outFile: "",
    bindPath: "",
    viewFile: "",
    parsed: undefined as unknown as ParsedPrefab,
    config: undefined as unknown as BindConfig,
    usedDefault: false,
    viewStatus: "skipped-exists",
    viewCode: "",
    issues: [],
    code: "",
    durations: { parse: 0, validate: 0, resolve: 0, generate: 0, write: 0, total: 0 },
    mode: "write",
    error: { phase, message },
  };
}
