/**
 * Cocos Creator Inspector 注入 — 选中含 `cc.UITransform` 的节点时
 *
 * 这个文件挂在 cc.UITransform 这个"几乎所有 UI 节点都有"的组件下，作为
 * "选中任何 UI 节点都会出现"的曲线救国实现。它会做的事：
 *
 *  1. 通过 `scene > query-node` 拿到当前节点信息，找到它所属的 prefab uuid
 *     与从 prefab 根算起的 path
 *  2. 调用 main 的 `query-node-status` 查询该 path 是否在 bind.json 里
 *  3. 渲染一行 mini 指示：
 *      ✓ 已导出为 commonUI（带组件个数）
 *      ☐ 未导出  [+ 加入 bind.json]
 *      …  当前不在 prefab 编辑模式
 *
 * 目前不试图渲染该节点上的逐组件复选框 — 那个在主 prefab inspector 里有。
 *
 * 注意：
 *  - 在普通 scene 里选中节点时，nodePrefabUuid 通常为空，这种情况什么都不显示
 *    （CSS hidden 整块）
 *  - 这个 inspector 是 cc.UITransform 的子区段，渲染会"接管"原始 UITransform UI；
 *    所以我们的 template 里第一行先把 dump 自动渲染回来，再叠加自己那一行。
 */

/// <reference path="../../../types/editor.d.ts" />

interface NodeStatusResult {
  prefabFound: boolean;
  exported: boolean;
  field?: string;
  exposeNode?: boolean;
  exposedComponents?: string[];
  totalComponents?: number;
  hasBindJson: boolean;
  prefabAbsPath?: string;
}

interface ToggleResult {
  ok: boolean;
  bindJsonPath?: string;
  message?: string;
}

/**
 * Cocos 组件 dump 的简化形状：
 *
 * {
 *   value: {
 *     contentSize: { value: { width:100, height:50 }, name:..., type:..., visible: true/false, ... },
 *     anchorX: { value: 0.5, ... },
 *     ...
 *   },
 *   ...
 * }
 *
 * 我们对内部字段不感兴趣，只关心是否 visible 用来过滤。
 */
interface PropDump {
  visible?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}
interface UITransformDumpLite {
  value: Record<string, PropDump>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export const $ = {
  // 用一块 host 容器，由我们把 UITransform 各字段一个一个 ui-prop 渲染回去
  fieldHost: ".viewweaver-fields",
  hint: ".viewweaver-node-hint",
  hintText: ".viewweaver-node-text",
  toggleBtn: ".viewweaver-node-toggle",
  openBtn: ".viewweaver-node-open",
};

// 注意：cocos 一旦看到我们 register 了 cc.UITransform 的 inspector，
// 默认渲染就会让渡给我们；为了不丢原本的 contentSize / anchorX / priority 等输入，
// 我们必须自己把每个属性 dump 用一个 <ui-prop type="dump"> 渲染回来。
// 这里采用「动态遍历 dump.value 的所有可见字段」的方式，对未来 Cocos 给
// UITransform 加新字段是稳健的。
export const template = `
<style>
.viewweaver-fields { display: block; }
.viewweaver-node-hint {
  display: flex; flex-direction: row; align-items: center; gap: 4px;
  font-size: 11px; padding: 4px 6px; margin-top: 6px;
  border-top: 1px dashed var(--color-normal-border, rgba(255,255,255,0.12));
  border-radius: 0;
  opacity: 0.95;
}
.viewweaver-node-hint .viewweaver-node-text { flex: 1; opacity: 0.85; }
.viewweaver-node-hint .spacer { flex: 1; }
.viewweaver-node-hint.exported .viewweaver-node-text { color: var(--color-success-fill, #6dc06d); }
.viewweaver-node-hint.warn .viewweaver-node-text { color: var(--color-warn-fill, #d6a13a); }
.viewweaver-node-hint.dim { opacity: 0.55; }
</style>
<div class="viewweaver-fields"></div>
<div class="viewweaver-node-hint">
  <span class="viewweaver-node-text">…</span>
  <span class="spacer"></span>
  <ui-button class="viewweaver-node-toggle small" hidden></ui-button>
  <ui-button class="viewweaver-node-open small" hidden>定位 prefab</ui-button>
</div>
`;

type PanelThis = {
  $: Record<keyof typeof $, HTMLElement | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dump: any;
  context: NodeContext | null;
  /**
   * 已创建的 ui-prop 元素表（按字段 key 索引）。
   * Cocos 在用户拖输入框时不希望我们重建 DOM（会丢焦点），
   * 故我们缓存元素，仅在 keys 集合发生变化时才重建。
   */
  fieldElements: Map<string, HTMLElement>;
  fieldOrder: string[];
};

interface NodeContext {
  /** prefab asset uuid（来自所属 prefab 节点的 prefabInfo） */
  prefabUuid: string;
  /** 从 prefab 根开始的相对 path（与 ParsedPrefab 内 path 一致的格式） */
  nodePath: string;
  /** 当前节点 uuid，用于触发刷新 */
  nodeUuid: string;
}

// =====================================================================
// cocos 生命周期
// =====================================================================

export function ready(this: PanelThis): void {
  this.context = null;
  this.fieldElements = new Map();
  this.fieldOrder = [];
  const toggle = this.$.toggleBtn as HTMLElement | null;
  const open = this.$.openBtn as HTMLElement | null;
  toggle?.addEventListener("confirm", async () => {
    if (!this.context) return;
    // 当前 button 文案是 "+ 加入 bind.json" 时 expose=true，否则取消导出
    const currentlyExported = toggle.getAttribute("data-exported") === "1";
    const r = (await Editor.Message.request("viewweaver", "toggle-node-export", {
      prefabUuid: this.context.prefabUuid,
      nodePath: this.context.nodePath,
      expose: !currentlyExported,
    })) as ToggleResult;
    if (!r.ok) {
      const text = this.$.hintText as HTMLElement;
      text.textContent = `ViewWeaver: 操作失败 ${r.message ?? ""}`;
    } else {
      // 重新拉一次状态
      await refreshStatus(this);
    }
  });
  open?.addEventListener("confirm", async () => {
    if (!this.context) return;
    // 让 Assets 面板选中并展示 prefab，以便用户跳到主 inspector 编辑
    Editor.Message.send("assets", "twinkle", this.context.prefabUuid);
    Editor.Selection.select("asset", this.context.prefabUuid);
  });
}

export async function update(this: PanelThis, dump: UITransformDumpLite): Promise<void> {
  this.dump = dump;

  // 1. 把 UITransform 自身字段还原回去（一个属性一个 ui-prop type=dump）
  renderFields(this, dump);

  // 2. 查询当前节点的 prefab 归属与 path
  const ctx = await resolveNodeContext(dump);
  this.context = ctx;
  await refreshStatus(this);
}

export function close(this: PanelThis): void {
  this.context = null;
  this.fieldElements?.clear();
  this.fieldOrder = [];
}

// =====================================================================
// UITransform 字段渲染
// =====================================================================

/**
 * 把 dump.value 里每个 visible 字段动态映射成一个 <ui-prop type="dump">。
 *
 * 难点：
 *  - 用户在输入框内拖动数值时，cocos 会以高频率连续触发 update()。
 *    如果我们 innerHTML='' 重建 DOM，就会丢焦点 → 拖不动。
 *  - 因此我们缓存 ui-prop 元素，在字段集合不变时只调用 .render() 更新值。
 *  - 仅在字段集合（keys + 顺序）变了时才重建。
 */
function renderFields(panel: PanelThis, dump: UITransformDumpLite): void {
  const host = panel.$.fieldHost as HTMLElement | null;
  if (!host) return;
  const value = dump?.value ?? {};
  const visibleKeys: string[] = [];
  for (const k of Object.keys(value)) {
    const pd = value[k];
    // visible === false 或 没有 type 字段（伪属性）就跳过
    if (!pd) continue;
    if (pd.visible === false) continue;
    visibleKeys.push(k);
  }

  // 集合或顺序有变 → 重建（罕见：UITransform 字段集是稳定的）
  const sameOrder =
    visibleKeys.length === panel.fieldOrder.length &&
    visibleKeys.every((k, i) => k === panel.fieldOrder[i]);

  if (!sameOrder) {
    host.innerHTML = "";
    panel.fieldElements.clear();
    for (const k of visibleKeys) {
      const el = document.createElement("ui-prop");
      el.setAttribute("type", "dump");
      host.appendChild(el);
      panel.fieldElements.set(k, el as HTMLElement);
    }
    panel.fieldOrder = [...visibleKeys];
  }

  // 给每个元素 push 当前 dump
  for (const k of visibleKeys) {
    const el = panel.fieldElements.get(k);
    if (!el) continue;
    // ui-prop 实现里 render(propDump) / .dump = propDump 都可用，
    // 不同 cocos 版本表现略不同，这里两条路都走一下
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyEl = el as any;
    if (typeof anyEl.render === "function") {
      try {
        anyEl.render(value[k]);
      } catch {
        anyEl.dump = value[k];
      }
    } else {
      anyEl.dump = value[k];
    }
  }
}

// =====================================================================
// 内部
// =====================================================================

async function refreshStatus(panel: PanelThis): Promise<void> {
  const hint = panel.$.hint as HTMLElement | null;
  const text = panel.$.hintText as HTMLElement | null;
  const toggle = panel.$.toggleBtn as HTMLElement | null;
  const open = panel.$.openBtn as HTMLElement | null;
  if (!hint || !text || !toggle || !open) return;

  hint.classList.remove("exported", "warn", "dim");
  toggle.setAttribute("hidden", "");
  open.setAttribute("hidden", "");

  if (!panel.context) {
    hint.classList.add("dim");
    text.textContent = "ViewWeaver: 不在 prefab 编辑模式 — 双击 prefab 进入或在 Assets 面板选中 prefab";
    return;
  }

  const status = (await Editor.Message.request("viewweaver", "query-node-status", {
    prefabUuid: panel.context.prefabUuid,
    nodePath: panel.context.nodePath,
  })) as NodeStatusResult;

  open.removeAttribute("hidden");

  if (!status.hasBindJson) {
    hint.classList.add("warn");
    text.textContent = `ViewWeaver: bind.json 不存在 (${shortPath(panel.context.nodePath)})`;
    toggle.removeAttribute("hidden");
    toggle.textContent = "+ 加入 bind.json";
    toggle.setAttribute("data-exported", "0");
    return;
  }

  if (status.exported) {
    hint.classList.add("exported");
    const compCount = status.exposedComponents?.length ?? 0;
    const compTip = compCount ? ` · 含 ${compCount} 组件` : "";
    text.textContent = `ViewWeaver: ✓ 导出为 ${status.field ?? "?"}${compTip}`;
    toggle.removeAttribute("hidden");
    toggle.textContent = "− 取消导出";
    toggle.setAttribute("data-exported", "1");
  } else {
    text.textContent = `ViewWeaver: ☐ 未导出 (${shortPath(panel.context.nodePath)})`;
    toggle.removeAttribute("hidden");
    toggle.textContent = "+ 加入 bind.json";
    toggle.setAttribute("data-exported", "0");
  }
}

/**
 * 由 dump 推出 (prefabUuid, nodePath, nodeUuid)。
 * 失败返回 null，对应"不在 prefab 编辑模式或不属于 prefab"。
 *
 * 实现思路：
 *  1. dump.value.node.value.uuid → 当前节点 uuid
 *  2. scene.query-node(uuid) → INode：包含 prefab 信息（如果该节点是 prefab 实例的一部分）
 *  3. 从 INode.prefab.assetUuid 拿 prefab 资源 uuid
 *  4. 计算 path：从 prefab 根（找 INode.prefab.rootUuid）走链
 */
async function resolveNodeContext(dump: UITransformDumpLite): Promise<NodeContext | null> {
  try {
    const nodeUuid =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dump as any)?.value?.node?.value?.uuid ?? (dump as any)?.value?.node?.uuid;
    if (!nodeUuid || typeof nodeUuid !== "string") return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = (await Editor.Message.request("scene", "query-node", nodeUuid)) as any;
    if (!node) return null;

    // 不同 cocos 版本 prefab 信息字段不同，做兼容
    const prefabInfo = node.__prefab__ ?? node.prefab ?? node.prefabInfo ?? null;
    const prefabAssetUuid: string | undefined =
      prefabInfo?.assetUuid ?? prefabInfo?.uuid ?? node.prefabAssetUuid;
    const rootUuid: string | undefined =
      prefabInfo?.rootUuid ?? prefabInfo?.root ?? prefabInfo?.fileId;
    if (!prefabAssetUuid) return null;

    // path：尝试用 query-node-tree() 拿到当前编辑视图根
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root = (await Editor.Message.request("scene", "query-node-tree")) as any;
    const path = computePathInTree(root, nodeUuid, rootUuid);
    if (path === null) return null;

    return { prefabUuid: prefabAssetUuid, nodePath: path, nodeUuid };
  } catch {
    return null;
  }
}

/**
 * 在 INode 树里搜目标 nodeUuid，返回从 (rootUuid 标记的节点 / 或者 root) 起算的 path。
 * path 与 ParsedPrefab 一致：根节点 path === ""，其余按 "/" 拼接 name + 同名兄弟编号。
 */
function computePathInTree(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  treeNode: any,
  targetUuid: string,
  preferredRootUuid?: string
): string | null {
  if (!treeNode) return null;
  // 如果指定了 preferredRootUuid，优先把搜索范围限制在那个子树
  if (preferredRootUuid) {
    const sub = findNodeByUuid(treeNode, preferredRootUuid);
    if (sub) {
      return walk(sub, "");
    }
  }
  return walk(treeNode, "");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(node: any, accPath: string): string | null {
    if (!node) return null;
    if (getUuid(node) === targetUuid) return accPath;
    const children: unknown = node.children ?? node.subNodes ?? [];
    if (!Array.isArray(children)) return null;
    // 同名兄弟编号
    const seen = new Map<string, number>();
    for (const ch of children) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c: any = ch;
      const name = String(c?.name ?? "");
      const idx = seen.get(name) ?? 0;
      seen.set(name, idx + 1);
      const seg = idx > 0 ? `${name}(${idx})` : name;
      const childPath = accPath ? `${accPath}/${seg}` : seg;
      const r = walk(c, childPath);
      if (r !== null) return r;
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function findNodeByUuid(node: any, uuid: string): any {
    if (!node) return null;
    if (getUuid(node) === uuid) return node;
    const children = node.children ?? node.subNodes ?? [];
    if (Array.isArray(children)) {
      for (const ch of children) {
        const r = findNodeByUuid(ch, uuid);
        if (r) return r;
      }
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getUuid(node: any): string | undefined {
    return node?.uuid?.value ?? node?.uuid ?? undefined;
  }
}

function shortPath(p: string): string {
  if (!p) return "<root>";
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-2).join("/")}`;
}
