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
  /** 自动暴露的内置组件类型（白名单），未列出的则只暴露 Node */
  exposedBuiltinTypes?: ReadonlySet<string>;
}

/** 默认暴露的内置组件类型 */
const DEFAULT_EXPOSED_BUILTIN: ReadonlySet<string> = new Set([
  "cc.Label",
  "cc.RichText",
  "cc.Sprite",
  "cc.Button",
  "cc.Toggle",
  "cc.EditBox",
  "cc.ProgressBar",
  "cc.Slider",
  "cc.ScrollView",
  "cc.PageView",
  "cc.Animation",
  "cc.AnimationController",
  "sp.Skeleton",
]);

/** 把 prefab 名生成 ViewClass 名 */
function prefabNameToClass(prefabName: string): string {
  const id = pathToIdentifier(prefabName, { camel: true });
  // PrefabView -> 首字母大写 + 后缀 PrefabView
  const pascal = id.charAt(0).toUpperCase() + id.slice(1);
  return `${pascal}PrefabView`;
}

/** 根据 ParsedPrefab 生成「全部命名节点 + 白名单组件」的默认配置 */
export function makeDefaultBindConfig(parsed: ParsedPrefab, opts: MakeDefaultOptions): BindConfig {
  const exposed = opts.exposedBuiltinTypes ?? DEFAULT_EXPOSED_BUILTIN;
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

  function visit(node: ParsedNode, isRoot: boolean): void {
    // 「跳过」分两层语义：
    //   skipEntry  = 整个 entry 都不输出（无名节点 / 无意义节点）
    //   skipNodeField = 只是不暴露 Node 字段，但组件还是要保留
    //
    // 根节点的特殊性：
    //   - bind(root: Node) 已经把 root 作为入参，再暴露一个 view.root 是冗余字段；
    //   - 但根节点上常常挂主控脚本（如 common_ui 的 CommonUI），必须能访问到。
    // 所以根节点默认 skipNodeField=true，但只要它有可暴露的组件，就保留 entry。
    const skipEntryBecauseUnnamed =
      !opts.includeUnnamed && (!node.name || node.name.startsWith("<"));

    if (!skipEntryBecauseUnnamed) {
      const baseField = isRoot
        ? uniqueField("$root") // 一个不会冲突的占位字段名
        : uniqueField(pathToIdentifier(node.path || node.name, { camel: true }));
      const components: BindComponentEntry[] = [];
      for (const c of node.components) {
        if (!c.typeInfo) continue; // 仍然 unknown 的（脚本被删/没源代码）跳过
        // 白名单逻辑：
        //  · 内置 cc.* 组件：只暴露白名单里的（避免把 UITransform/Widget 等大量基础组件全导出）
        //  · 自定义业务脚本：默认全部暴露（typeInfo.builtin === false）
        if (c.typeInfo.builtin && !exposed.has(c.rawType)) continue;
        const compFieldName = isRoot
          ? uniqueField(c.typeInfo.tsName.charAt(0).toLowerCase() + c.typeInfo.tsName.slice(1))
          : uniqueField(`${baseField}_${c.typeInfo.tsName.replace(/[^A-Za-z0-9_]/g, "_")}`);
        components.push({
          rawType: c.rawType,
          field: compFieldName,
          index: c.indexAmongSameType,
        });
      }
      // 决定是否输出节点字段：
      //   - 普通节点：opts.includeRoot/默认行为
      //   - 根节点：默认不输出节点字段，但若 includeRoot=true 则输出
      const exposeNode = isRoot ? !!opts.includeRoot : true;
      // 仅当这个 entry 还有意义（暴露 Node 或者至少一个组件）才输出
      if (exposeNode || components.length > 0) {
        nodes.push({
          path: node.path,
          field: baseField,
          exposeNode,
          components,
        });
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
