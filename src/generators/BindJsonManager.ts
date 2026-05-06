import * as path from "node:path";
import { type ParsedNode, type ParsedPrefab } from "../parsers/PrefabParser.ts";
import { readJsonIfExists, writeFileSafe } from "../utils/paths.ts";
import { pathToIdentifier } from "../utils/name-converter.ts";

/** 单条节点导出项 */
export interface BindNodeEntry {
  /** 节点路径，相对根（根节点 path 为 ""） */
  path: string;
  /** 生成代码里的字段名（合法 TS 标识符），不能与同 prefab 内其它项重名 */
  field: string;
  /** 是否在生成的 PrefabView 上暴露 Node 本体；默认 true */
  exposeNode?: boolean;
  /** 选择性导出节点上的某些组件类型（rawType，如 "cc.Sprite"） */
  components?: BindComponentEntry[];
  /** 备注（仅文档用） */
  comment?: string;
}

/** 单条组件导出项 */
export interface BindComponentEntry {
  /** prefab 中原始 __type__（如 "cc.Sprite" / "207c0UWgI9K67r2vPiUzVso"） */
  rawType: string;
  /** 生成代码里的字段名；缺省时由工具按 `${nodeField}_${typeName}` 生成 */
  field?: string;
  /** 同节点同类型的索引（默认 0） */
  index?: number;
  comment?: string;
}

/** bind.json 文件 schema */
export interface BindConfig {
  /** schema 版本 */
  $schema: 1;
  /** 该绑定对应的 prefab 路径，相对项目 assets/ */
  prefab: string;
  /** prefab 名（仅元数据，源是 prefab） */
  prefabName: string;
  /** 生成出的 PrefabView 类名 */
  viewClassName: string;
  /** 生成 .gen.ts 的输出路径（相对项目根） */
  outputPath: string;
  /** 节点导出列表 */
  nodes: BindNodeEntry[];
  /** 工具版本 / 时间戳，纯元数据 */
  generatedAt?: string;
  toolVersion?: string;
}

export interface MakeDefaultOptions {
  /** prefab 文件相对 assets/ 的路径 */
  prefabRelativePath: string;
  /** 生成 .gen.ts 的输出路径（相对项目根） */
  outputPath: string;
  /** 是否包含未命名节点（_name 为空），默认 false */
  includeUnnamed?: boolean;
  /** 是否包含根节点本身，默认 false（根节点常常没有意义） */
  includeRoot?: boolean;
  /**
   * 「触发」内置组件 —— 节点必须挂有其中之一才会进入默认导出。
   * 默认 `["cc.Button"]`：默认只为按钮节点产出绑定，不污染界面里其它节点。
   *
   * 传 `null` 表示取消触发限制（任何节点都可能进入），用于"全量默认"模式。
   */
  triggerBuiltinTypes?: ReadonlySet<string> | null;
  /**
   * 在被触发的节点上，要暴露的内置组件白名单。
   * 默认 = `triggerBuiltinTypes`（即按钮触发就暴露 Button 本身）。
   * 设为更大的集合可让按钮节点同时把 Sprite / Label 等也带出来。
   */
  exposedBuiltinTypes?: ReadonlySet<string>;
  /**
   * 是否在「触发节点」上把所有自定义脚本（非 cc.* 内置）也连带暴露。
   * 默认 true —— 这样按钮节点上挂的 ButtonScale / ButtonChildrenColor / ButtonSound
   * 这类业务侧的"按钮增强"脚本会自动导出。
   */
  exposeCustomScriptsOnTriggers?: boolean;
  /**
   * 是否把 Node 本身也暴露到 PrefabView 里（成为 view.xxx: Node）。
   * 默认 false —— 触发节点只暴露其上的组件；需要 Node 时业务侧用 `view.btn.node`。
   */
  exposeTriggerNode?: boolean;
}

/** 默认触发集合：只有按钮节点会进入默认导出 */
const DEFAULT_TRIGGER_BUILTIN: ReadonlySet<string> = new Set([
  "cc.Button",
]);

/** 把 prefab 名生成 ViewClass 名 */
function prefabNameToClass(prefabName: string): string {
  const id = pathToIdentifier(prefabName, { camel: true });
  // PrefabView -> 首字母大写 + 后缀 PrefabView
  const pascal = id.charAt(0).toUpperCase() + id.slice(1);
  return `${pascal}PrefabView`;
}

/**
 * 默认导出策略（v0.2 起）：
 *  1. 节点必须挂有 `triggerBuiltinTypes` 中任一组件（默认 cc.Button）才进入默认导出
 *  2. 触发节点上：内置组件只暴露 `exposedBuiltinTypes` 里列出的；自定义脚本默认全暴露
 *  3. Node 本体默认不暴露（业务侧用 `view.btn.node` 即可）
 *
 * 这样美术的 prefab 长再多 Sprite/Label/Layout/Widget，工具默认只抓出按钮——
 * 把"哪些节点要程序员抓"这个决策权握在程序员手里，由 Inspector 勾选扩展。
 */
export function makeDefaultBindConfig(parsed: ParsedPrefab, opts: MakeDefaultOptions): BindConfig {
  const triggerSet =
    opts.triggerBuiltinTypes === null
      ? null // 取消触发限制 = 走"任何节点都可能被默认导出"
      : opts.triggerBuiltinTypes ?? DEFAULT_TRIGGER_BUILTIN;
  // exposed 默认 = trigger 本身（按钮触发就暴露 Button），允许显式覆盖
  const exposed = opts.exposedBuiltinTypes ?? triggerSet ?? new Set<string>();
  const includeCustom = opts.exposeCustomScriptsOnTriggers ?? true;
  const exposeNodeFlag = !!opts.exposeTriggerNode;

  const nodes: BindNodeEntry[] = [];
  const usedFields = new Set<string>();

  function uniqueField(suggested: string): string {
    let name = suggested;
    let i = 2;
    while (usedFields.has(name)) {
      name = `${suggested}_${i}`;
      i++;
    }
    usedFields.add(name);
    return name;
  }

  /** 该节点是否被「触发组件」勾中？triggerSet === null 视为"任意节点都触发" */
  function isTriggerNode(node: ParsedNode): boolean {
    if (triggerSet === null) return true;
    for (const c of node.components) {
      if (c.typeInfo?.builtin && triggerSet.has(c.rawType)) return true;
    }
    return false;
  }

  /**
   * 对触发节点，生成排好序的可导出组件列表：
   *   - 内置组件：仅 exposed 集合里允许的
   *   - 自定义脚本：includeCustom=true 时全部带上
   * 返回顺序：内置（trigger 中的优先）→ 自定义脚本（按 tsName 字典序），便于第一项作为基础字段名。
   */
  function pickExposedComponents(node: ParsedNode): typeof node.components {
    const trigComps = [];
    const otherBuiltin = [];
    const customs = [];
    for (const c of node.components) {
      if (!c.typeInfo) continue; // 类型未解析，无法生成代码 → 跳过
      if (c.typeInfo.builtin) {
        if (!exposed.has(c.rawType)) continue;
        if (triggerSet && triggerSet.has(c.rawType)) trigComps.push(c);
        else otherBuiltin.push(c);
      } else {
        if (!includeCustom) continue;
        customs.push(c);
      }
    }
    // 自定义脚本按类名字典序，保持稳定 diff
    customs.sort((a, b) =>
      (a.typeInfo!.tsName).localeCompare(b.typeInfo!.tsName)
    );
    return [...trigComps, ...otherBuiltin, ...customs];
  }

  function visit(node: ParsedNode, isRoot: boolean): void {
    const skipBecauseUnnamed =
      !opts.includeUnnamed && (!node.name || node.name.startsWith("<"));

    if (!skipBecauseUnnamed) {
      const trigger = isTriggerNode(node);
      // 根节点特殊：includeRoot=true 时强制纳入；否则按是否触发来决定
      const includeThisNode = isRoot ? !!opts.includeRoot : trigger;

      if (includeThisNode) {
        const exposedComps = pickExposedComponents(node);
        // 没东西可暴露 → 这个 entry 没意义，跳过
        if (exposedComps.length > 0 || (exposeNodeFlag && !isRoot)) {
          const baseField = isRoot
            ? uniqueField("$root")
            : uniqueField(pathToIdentifier(node.path || node.name, { camel: true }));

          const components: BindComponentEntry[] = [];
          for (let i = 0; i < exposedComps.length; i++) {
            const c = exposedComps[i];
            const tsName = c.typeInfo!.tsName.replace(/[^A-Za-z0-9_]/g, "_");
            // 第一个组件复用 baseField（最好看的名字）；后续追加 tsName 后缀
            // baseField 已经 reserve 在 usedFields 里了，所以同名安全
            const compFieldName =
              i === 0 ? baseField : uniqueField(`${baseField}_${tsName}`);
            components.push({
              rawType: c.rawType,
              field: compFieldName,
              index: c.indexAmongSameType,
            });
          }

          nodes.push({
            path: node.path,
            field: baseField,
            // 默认不暴露 Node；用户可在 Inspector 里勾选打开
            exposeNode: !isRoot && exposeNodeFlag,
            components,
          });
        }
      }
    }

    for (const ch of node.children) visit(ch, false);
  }
  visit(parsed.root, true);

  return {
    $schema: 1,
    prefab: opts.prefabRelativePath,
    prefabName: parsed.name,
    viewClassName: prefabNameToClass(parsed.name),
    outputPath: opts.outputPath,
    nodes,
    generatedAt: new Date().toISOString(),
    toolVersion: "0.1.0",
  };
}

export function loadBindConfig(filePath: string): BindConfig | undefined {
  return readJsonIfExists<BindConfig>(filePath);
}

export function saveBindConfig(filePath: string, config: BindConfig): void {
  // 保留稳定的 key 顺序，便于 diff
  const ordered: BindConfig = {
    $schema: config.$schema,
    prefab: config.prefab,
    prefabName: config.prefabName,
    viewClassName: config.viewClassName,
    outputPath: config.outputPath,
    nodes: config.nodes.map((n) => ({
      path: n.path,
      field: n.field,
      exposeNode: n.exposeNode ?? true,
      components: (n.components ?? []).map((c) => ({
        rawType: c.rawType,
        field: c.field,
        index: c.index ?? 0,
        comment: c.comment,
      })),
      comment: n.comment,
    })),
    generatedAt: config.generatedAt,
    toolVersion: config.toolVersion,
  };
  writeFileSafe(filePath, JSON.stringify(ordered, null, 2) + "\n");
}

/** 将 prefab 路径推算为相邻 .bind.json 的路径 */
export function deriveBindJsonPath(prefabFilePath: string): string {
  const dir = path.dirname(prefabFilePath);
  const base = path.basename(prefabFilePath, path.extname(prefabFilePath));
  return path.join(dir, `${base}.bind.json`);
}

/** 校验 bind.json 是否还能在当前 prefab 上落地（节点是否仍然存在、组件类型是否还在） */
export interface BindValidationIssue {
  level: "error" | "warning";
  message: string;
  path?: string;
  field?: string;
}

export function validateBindAgainstPrefab(
  config: BindConfig,
  parsed: ParsedPrefab
): BindValidationIssue[] {
  const issues: BindValidationIssue[] = [];
  const fieldSet = new Set<string>();

  for (const entry of config.nodes) {
    if (fieldSet.has(entry.field)) {
      issues.push({
        level: "error",
        message: `duplicate field "${entry.field}"`,
        field: entry.field,
      });
    }
    fieldSet.add(entry.field);

    const node = parsed.nodesByPath.get(entry.path);
    if (!node) {
      issues.push({
        level: "error",
        message: `node path "${entry.path}" not found in prefab`,
        path: entry.path,
        field: entry.field,
      });
      continue;
    }
    for (const c of entry.components ?? []) {
      const matches = node.components.filter((nc) => nc.rawType === c.rawType);
      if (matches.length === 0) {
        issues.push({
          level: "error",
          message: `component "${c.rawType}" not found on node "${entry.path}"`,
          path: entry.path,
          field: entry.field,
        });
        continue;
      }
      const idx = c.index ?? 0;
      if (idx >= matches.length) {
        issues.push({
          level: "error",
          message: `component index ${idx} out of range on node "${entry.path}"`,
          path: entry.path,
          field: entry.field,
        });
      }
    }
  }
  return issues;
}
