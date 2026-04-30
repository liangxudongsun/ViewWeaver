/**
 * Cocos Creator prefab JSON 数据结构。
 *
 * Prefab 文件本身是一个数组，数组中每个元素是一个对象，对象之间通过
 *   { "__id__": <数组下标> }
 * 互相引用。第一个元素一定是 `cc.Prefab`，第二个通常是根 `cc.Node`。
 *
 * 参考：Cocos 内部序列化结构（不在公开 API 中，可能随版本调整）。
 */

/** 引用其他对象（数组下标） */
export interface IdRef {
  __id__: number;
}

export type MaybeIdRef<T> = T | IdRef | null | undefined;

/** prefab 文件顶层数组 */
export type PrefabRaw = PrefabObject[];

/** 任意 prefab 内对象都至少带有 __type__ */
export interface PrefabObject {
  __type__: string;
  [k: string]: unknown;
}

/** cc.Prefab 头节点（数组第 0 项） */
export interface PrefabHeader extends PrefabObject {
  __type__: "cc.Prefab";
  _name: string;
  data: IdRef;
}

/** cc.Node */
export interface PrefabNode extends PrefabObject {
  __type__: "cc.Node";
  _name: string;
  _parent: IdRef | null;
  _children: IdRef[];
  _components: IdRef[];
  _active: boolean;
}

/** 任意挂在节点上的组件（cc.* 或自定义脚本 UUID） */
export interface PrefabComponent extends PrefabObject {
  /** 反向指回所属 node 的 __id__ */
  node: IdRef;
  _enabled?: boolean;
}

/** 一些已知的非组件元数据类型，处理时直接忽略 */
export const NON_COMPONENT_TYPES: ReadonlySet<string> = new Set([
  "cc.Prefab",
  "cc.Node",
  "cc.PrefabInfo",
  "cc.CompPrefabInfo",
  "cc.PrefabInstance",
  "CCPropertyOverrideInfo",
  "CCTargetInfo",
  "cc.SceneAsset",
]);

/** 类型守卫 */
export function isPrefabNode(obj: PrefabObject | undefined | null): obj is PrefabNode {
  return !!obj && obj.__type__ === "cc.Node";
}

export function isPrefabComponent(
  obj: PrefabObject | undefined | null
): obj is PrefabComponent {
  if (!obj) return false;
  if (NON_COMPONENT_TYPES.has(obj.__type__)) return false;
  // 组件必带 node 反向引用
  return typeof (obj as PrefabComponent).node === "object" && (obj as PrefabComponent).node !== null;
}

export function resolveRef(
  raw: PrefabRaw,
  ref: IdRef | null | undefined
): PrefabObject | undefined {
  if (!ref || typeof ref.__id__ !== "number") return undefined;
  return raw[ref.__id__];
}
