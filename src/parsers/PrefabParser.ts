import * as fs from "node:fs";
import {
  type IdRef,
  NON_COMPONENT_TYPES,
  type PrefabComponent,
  type PrefabHeader,
  type PrefabNode,
  type PrefabObject,
  type PrefabRaw,
  isPrefabComponent,
  isPrefabNode,
} from "./PrefabTypes.ts";
import { type ComponentTypeInfo, lookupComponentType } from "./ComponentTypeMap.ts";

/** 解析后的组件信息 */
export interface ParsedComponent {
  /** 在 prefab 数组中的下标 */
  rawId: number;
  /** prefab 原始 __type__（cc.* 或 UUID） */
  rawType: string;
  /** 来自 ComponentTypeMap 的 TS 信息；未识别则 undefined */
  typeInfo?: ComponentTypeInfo;
  /** 同节点上同类型组件的索引（0 起），用于 "Sprite#1" 区分 */
  indexAmongSameType: number;
}

/** 解析后的节点 */
export interface ParsedNode {
  /** 在 prefab 数组中的下标 */
  rawId: number;
  /** _name */
  name: string;
  /** 相对根节点的层级路径（不包含根名字本身），例如 "portrait/spin/spin_btn" */
  path: string;
  /** 在父节点 _children 中的索引（同名节点区分） */
  siblingIndex: number;
  /** _active */
  active: boolean;
  /** 父节点；根节点为 null */
  parent: ParsedNode | null;
  /** 子节点列表（按 _children 顺序） */
  children: ParsedNode[];
  /** 节点上的组件 */
  components: ParsedComponent[];
}

export interface ParsedPrefab {
  name: string;
  /** 根节点 */
  root: ParsedNode;
  /** 路径 → 节点 索引（同名兄弟会变成 "name", "name(1)", "name(2)"...） */
  nodesByPath: Map<string, ParsedNode>;
  /** rawId → ParsedNode */
  nodesById: Map<number, ParsedNode>;
  /** 所有解析出的组件（含未知类型） */
  allComponents: ParsedComponent[];
  /** 解析过程中发现但跳过的对象统计 */
  stats: {
    totalRaw: number;
    totalNodes: number;
    totalComponents: number;
    unknownComponents: number;
    /** 未识别的 __type__ 列表（去重） */
    unknownTypeNames: string[];
  };
}

/**
 * 把 cocos prefab JSON 解析成节点树。
 *
 * - 不修改原始数据；
 * - 路径以根节点为相对起点，根节点 path === ""；
 * - 同名兄弟用 "(N)" 区分（与 cocos 编辑器选择路径行为接近，但不等价）。
 */
export function parsePrefab(raw: PrefabRaw): ParsedPrefab {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Invalid prefab: top-level is not a non-empty array");
  }

  const header = raw[0] as PrefabHeader;
  if (header.__type__ !== "cc.Prefab") {
    throw new Error(
      `Invalid prefab: first element must be cc.Prefab, got ${header.__type__}`
    );
  }
  if (!header.data || typeof header.data.__id__ !== "number") {
    throw new Error("Invalid prefab: header.data missing __id__");
  }

  const rootRawId = header.data.__id__;
  const rootObj = raw[rootRawId];
  if (!isPrefabNode(rootObj)) {
    throw new Error(
      `Invalid prefab: root referenced by header is not cc.Node (got ${rootObj?.__type__})`
    );
  }

  // 1. 先索引：rawId → component 数组（每个 node 后面跟着自己的组件，按 _components 顺序）
  // 直接按需通过 _components ref 解析即可。

  const nodesById = new Map<number, ParsedNode>();
  const nodesByPath = new Map<string, ParsedNode>();
  const allComponents: ParsedComponent[] = [];
  const unknownTypeSet = new Set<string>();

  /**
   * 处理同名兄弟节点：
   *   首个 -> "name"
   *   第二个 -> "name(1)"
   *   ...
   */
  function disambiguateChildPath(parentPath: string, childName: string, takenNames: Map<string, number>): string {
    const safeName = childName || "<unnamed>";
    const seen = takenNames.get(safeName) ?? 0;
    takenNames.set(safeName, seen + 1);
    const display = seen === 0 ? safeName : `${safeName}(${seen})`;
    return parentPath === "" ? display : `${parentPath}/${display}`;
  }

  function buildNode(
    nodeObj: PrefabNode,
    rawId: number,
    parent: ParsedNode | null,
    siblingIndex: number,
    pathStr: string
  ): ParsedNode {
    const node: ParsedNode = {
      rawId,
      name: nodeObj._name ?? "",
      path: pathStr,
      siblingIndex,
      active: nodeObj._active ?? true,
      parent,
      children: [],
      components: [],
    };
    nodesById.set(rawId, node);
    nodesByPath.set(pathStr, node);

    const compTypeCounter = new Map<string, number>();
    for (const cref of nodeObj._components ?? []) {
      if (!cref || typeof cref.__id__ !== "number") continue;
      const cobj = raw[cref.__id__] as PrefabObject | undefined;
      if (!cobj) continue;
      if (NON_COMPONENT_TYPES.has(cobj.__type__)) continue;
      if (!isPrefabComponent(cobj)) continue;

      const typeInfo = lookupComponentType(cobj.__type__);
      if (!typeInfo) unknownTypeSet.add(cobj.__type__);

      const idx = compTypeCounter.get(cobj.__type__) ?? 0;
      compTypeCounter.set(cobj.__type__, idx + 1);

      const parsed: ParsedComponent = {
        rawId: cref.__id__,
        rawType: cobj.__type__,
        typeInfo,
        indexAmongSameType: idx,
      };
      node.components.push(parsed);
      allComponents.push(parsed);
    }

    const childTakenNames = new Map<string, number>();
    let i = 0;
    for (const cref of nodeObj._children ?? []) {
      if (!cref || typeof cref.__id__ !== "number") {
        i++;
        continue;
      }
      const cobj = raw[cref.__id__] as PrefabObject | undefined;
      if (!isPrefabNode(cobj)) {
        i++;
        continue;
      }
      const childPath = disambiguateChildPath(pathStr, cobj._name ?? "", childTakenNames);
      const child = buildNode(cobj, cref.__id__, node, i, childPath);
      node.children.push(child);
      i++;
    }

    return node;
  }

  const root = buildNode(rootObj, rootRawId, null, 0, "");

  return {
    name: rootObj._name ?? "Prefab",
    root,
    nodesByPath,
    nodesById,
    allComponents,
    stats: {
      totalRaw: raw.length,
      totalNodes: nodesById.size,
      totalComponents: allComponents.length,
      unknownComponents: allComponents.filter((c) => !c.typeInfo).length,
      unknownTypeNames: Array.from(unknownTypeSet),
    },
  };
}

/** 便利：从文件路径加载并解析 */
export function parsePrefabFile(filePath: string): ParsedPrefab {
  const text = fs.readFileSync(filePath, "utf8");
  let raw: PrefabRaw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse prefab JSON: ${filePath}: ${(e as Error).message}`);
  }
  return parsePrefab(raw);
}

/** 便利：以缩进格式打印节点树（debug 用） */
export function dumpTree(node: ParsedNode, depth = 0, lines: string[] = []): string {
  const indent = "  ".repeat(depth);
  const compStr =
    node.components.length === 0
      ? ""
      : "  [" +
        node.components
          .map((c) => (c.typeInfo ? c.typeInfo.tsName : `?${c.rawType.slice(0, 6)}`))
          .join(", ") +
        "]";
  lines.push(`${indent}${node.name || "<unnamed>"}${compStr}`);
  for (const ch of node.children) dumpTree(ch, depth + 1, lines);
  return lines.join("\n");
}

// silence unused export-helper warning when consumed by tests:
export type _Unused = IdRef;
