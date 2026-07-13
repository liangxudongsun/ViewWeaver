/**
 * Cocos Creator Inspector 注入 — `.prefab` 资源选中时
 *
 * 在用户点击 Assets 面板里的 .prefab 文件时，本脚本会被 cocos 加载到 inspector
 * 渲染进程里，把 ViewWeaver 的「导出配置 UI」追加到 inspector 默认内容下方。
 *
 * 核心交互：
 *  1. update(assetList, metaList) → 拉远端 main 的 prepare-prefab-config
 *  2. 渲染节点树（折叠 / 复选框 / 父子联动）
 *  3. 点 [生成] / [仅保存 bind] / [重置为默认] → 发消息回 main
 *
 * 类型说明：
 *   - 这个文件运行在 inspector 渲染进程，全局拿到的 Editor 同样可用
 *   - cocos 会把 `this` 绑到 inspector section 实例（含 $ 引用映射）
 *   - 严格类型不容易做（cocos 自己的 ui-* 元素是动态注入），故大量使用 any
 */

/// <reference path="../../../types/editor.d.ts" />

// ===== Editor 跨进程协议（必须和 main.ts 保持同步）=====

interface AssetInfoLite {
  uuid: string;
  url: string;
  file?: string;
  importer?: string;
  isDirectory?: boolean;
}

interface SerializedComponent {
  rawType: string;
  tsName?: string;
  importFrom?: string;
  indexAmongSameType: number;
  builtin: boolean;
}

interface SerializedNode {
  rawId: number;
  name: string;
  path: string;
  active: boolean;
  children: SerializedNode[];
  components: SerializedComponent[];
}

interface BindComponentEntry {
  rawType: string;
  field?: string;
  index?: number;
  comment?: string;
}

interface BindNodeEntry {
  path: string;
  field: string;
  exposeNode?: boolean;
  components?: BindComponentEntry[];
  comment?: string;
}

interface BindConfig {
  $schema: 1;
  prefab: string;
  prefabName: string;
  viewClassName: string;
  outputPath: string;
  nodes: BindNodeEntry[];
  generatedAt?: string;
  toolVersion?: string;
}

interface PrepareConfigOk {
  ok: true;
  prefabName: string;
  prefabAbsPath: string;
  prefabRelPath: string;
  bindJsonPath: string;
  genTsPath: string;
  hasExistingBind: boolean;
  config: BindConfig;
  defaultConfig: BindConfig;
  tree: SerializedNode;
}
type PrepareConfigResult = PrepareConfigOk | { ok: false; message: string };

interface ApplyResult {
  ok: boolean;
  prefabName: string;
  outFile?: string;
  bindJsonPath?: string;
  durations?: { total: number; parse: number; resolve: number; generate: number; write: number };
  scriptResolve?: { resolved: number; totalUnknown: number };
  error?: { phase: string; message: string };
}

// ===== Cocos panel-style exports =====

export const $ = {
  root: ".viewweaver-section",
  status: ".viewweaver-status",
  summary: ".viewweaver-summary",
  treeContainer: ".viewweaver-tree",
  search: ".viewweaver-search",
  expandAll: ".viewweaver-expand-all",
  collapseAll: ".viewweaver-collapse-all",
  selectDefault: ".viewweaver-select-default",
  selectNone: ".viewweaver-select-none",
  generate: ".viewweaver-generate",
  saveBindOnly: ".viewweaver-save-bind",
  reset: ".viewweaver-reset",
};

// 内联模板：单 ui-prop 占位，自身 DOM 全自己撑。
// 注意：用 `<ui-section>` 让 cocos 自带可折叠样式
// CSS 直接写在 template 里，避免 inspector section 是否支持顶层 style 导出
// 在不同 Cocos 版本里有差异。
export const template = `
<style>
.viewweaver-section { padding: 4px 6px; margin-top: 6px; }
.viewweaver-section .viewweaver-status { font-size: 11px; opacity: 0.85; padding: 2px 0 6px; }
.viewweaver-section .muted { opacity: 0.65; font-size: 11px; }
.viewweaver-toolbar { display: flex; flex-direction: row; align-items: center; gap: 4px; padding: 2px 0; }
.viewweaver-toolbar .spacer { flex: 1; }
.viewweaver-search { flex: 1; }
.viewweaver-tree-wrap {
  max-height: 360px; overflow-y: auto; overflow-x: hidden;
  border: 1px solid var(--color-normal-border, #555);
  border-radius: 3px;
  margin: 4px 0;
  padding: 4px 0;
  background: var(--color-normal-fill-emphasis, rgba(0,0,0,0.15));
}
.viewweaver-tree { font-size: 12px; }
.viewweaver-row { display: flex; align-items: center; gap: 4px; padding: 1px 4px; min-height: 18px; cursor: default; }
.viewweaver-row:hover { background: var(--color-info-fill, rgba(255,255,255,0.04)); }
.viewweaver-row.is-hidden { display: none; }
.viewweaver-row.dim { opacity: 0.55; }
.viewweaver-row .arrow { width: 10px; text-align: center; cursor: pointer; user-select: none; opacity: 0.7; }
.viewweaver-row .arrow.placeholder { opacity: 0; cursor: default; }
.viewweaver-row input[type=checkbox] { margin: 0; }
.viewweaver-row .name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.viewweaver-row.node-row.is-root .name::before { content: "● "; opacity: 0.6; }
.viewweaver-row .badge {
  font-size: 10px; padding: 0 4px; border-radius: 8px;
  background: var(--color-info-fill, rgba(80,160,220,0.4)); color: #fff; opacity: 0.9;
}
.viewweaver-row.comp-row { padding-left: 22px; }
.viewweaver-row.comp-row .name { color: var(--color-success-fill, #6dc06d); }
.viewweaver-row.comp-row .name.is-builtin { color: var(--color-info-fill, #7ab9ff); }
.viewweaver-row.comp-row .name.is-unknown { color: var(--color-warn-fill, #d6a13a); }
.viewweaver-actions { display: flex; flex-direction: row; align-items: center; gap: 4px; padding-top: 4px; border-top: 1px solid var(--color-normal-border, rgba(255,255,255,0.08)); margin-top: 4px; }
.viewweaver-actions .spacer { flex: 1; }
.viewweaver-actions ui-button.primary { font-weight: 600; }
</style>
<ui-prop class="viewweaver-prop" type="dump" hidden></ui-prop>
<ui-section class="viewweaver-section" header="ViewWeaver · 导出配置" expand>
  <div class="viewweaver-status">— 加载中 —</div>
  <div class="viewweaver-toolbar">
    <ui-input class="viewweaver-search" placeholder="按节点名过滤"></ui-input>
    <span class="spacer"></span>
    <ui-button class="viewweaver-expand-all small">全展开</ui-button>
    <ui-button class="viewweaver-collapse-all small">全折叠</ui-button>
  </div>
  <div class="viewweaver-toolbar">
    <ui-button class="viewweaver-select-default small">勾选默认</ui-button>
    <ui-button class="viewweaver-select-none small">全取消</ui-button>
    <span class="spacer"></span>
    <span class="viewweaver-summary muted"></span>
  </div>
  <div class="viewweaver-tree-wrap">
    <div class="viewweaver-tree"></div>
  </div>
  <div class="viewweaver-actions">
    <ui-button class="viewweaver-reset" tooltip="把配置重置为按默认规则生成的样子">重置为默认</ui-button>
    <span class="spacer"></span>
    <ui-button class="viewweaver-save-bind" tooltip="只把 bind.json 写盘，不重新生成 .gen.ts">仅保存 bind.json</ui-button>
    <ui-button class="viewweaver-generate primary" tooltip="保存 bind.json 并重新生成 .gen.ts">生成</ui-button>
  </div>
</ui-section>
`;


// =====================================================================
// 内部状态（panel 单例上下文，cocos 会保持 ready/update 复用同一个对象）
// =====================================================================

type PanelThis = {
  /**
   * Cocos 在 ready/update 调用前会把 `$` 表里的 CSS selector 字符串替换为对应
   * DOM 元素引用（template 渲染完成后）；这里直接声明为 HTMLElement 即可。
   */
  $: Record<keyof typeof $, HTMLElement | null>;
  state: PanelState | null;
};

interface PanelState {
  uuid: string;
  prepared: PrepareConfigOk;
  /** 当前编辑中的 bind config（用户勾选会改这个对象） */
  config: BindConfig;
  /** path → 是否暴露 Node */
  nodeChecked: Map<string, boolean>;
  /** path → Set<rawType+#index> 是否暴露组件 */
  compChecked: Map<string, Set<string>>;
  /** path → 是否折叠（true = 折叠） */
  collapsed: Map<string, boolean>;
  searchKeyword: string;
}

function compKey(rawType: string, index: number): string {
  return `${rawType}#${index}`;
}

// =====================================================================
// 渲染主体
// =====================================================================

function renderTree(panel: PanelThis): void {
  const st = panel.state;
  const container = panel.$.treeContainer as HTMLElement | null;
  if (!st || !container) return;
  container.innerHTML = "";

  const keyword = st.searchKeyword.trim().toLowerCase();
  // 先建立 path → 节点 + 是否命中（搜索）的辅助
  const visit = (node: SerializedNode, depth: number, parentVisible: boolean): void => {
    const matched =
      !keyword ||
      node.name.toLowerCase().includes(keyword) ||
      node.path.toLowerCase().includes(keyword);
    const isCollapsed = !!st.collapsed.get(node.path);
    const visible = parentVisible;

    const isRoot = node.path === "";
    const exposed = !!st.nodeChecked.get(node.path);
    // root 的 exposeNode 永远 false（runtime root 是 bind 的入参）
    const showNodeCheckbox = !isRoot;

    // 节点行
    const row = document.createElement("div");
    row.className = "viewweaver-row node-row" + (isRoot ? " is-root" : "");
    if (!visible) row.classList.add("is-hidden");
    if (!matched && keyword) row.classList.add("dim");
    row.style.paddingLeft = `${depth * 12 + 4}px`;

    // 折叠箭头
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    if (node.children.length === 0) {
      arrow.classList.add("placeholder");
      arrow.textContent = "·";
    } else {
      arrow.textContent = isCollapsed ? "▶" : "▼";
      arrow.onclick = (): void => {
        st.collapsed.set(node.path, !isCollapsed);
        renderTree(panel);
      };
    }
    row.appendChild(arrow);

    // 节点复选框（root 不暴露 Node 但可以挂组件，所以也保留行）
    if (showNodeCheckbox) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = exposed;
      cb.onchange = (): void => {
        const newVal = cb.checked;
        st.nodeChecked.set(node.path, newVal);
        // 关闭节点导出时，并不连带取消组件 —— 组件可独立暴露
        // 反之打开节点也不强制选组件
        updateConfigFromState(panel);
        updateSummary(panel);
      };
      row.appendChild(cb);
    } else {
      const placeholder = document.createElement("span");
      placeholder.style.width = "13px";
      placeholder.style.display = "inline-block";
      row.appendChild(placeholder);
    }

    // 名字
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    nameEl.textContent = isRoot ? `${node.name || "<root>"}  (prefab root)` : node.name || "<unnamed>";
    row.appendChild(nameEl);

    // 子节点 / 组件计数 badge
    const childComp = node.components.filter((c) => c.tsName).length;
    if (node.children.length || childComp) {
      const badge = document.createElement("span");
      badge.className = "muted";
      const parts: string[] = [];
      if (node.children.length) parts.push(`${node.children.length}子`);
      if (childComp) parts.push(`${childComp}件`);
      badge.textContent = parts.join(" / ");
      row.appendChild(badge);
    }

    container.appendChild(row);

    // 渲染该节点上的组件子行（即使节点本身没勾选，也允许独立选择组件）
    if (!isCollapsed) {
      for (const comp of node.components) {
        if (!comp.tsName) continue; // 没解析出来的就不展示了，免得用户勾不动
        const ckey = compKey(comp.rawType, comp.indexAmongSameType);
        const checked = st.compChecked.get(node.path)?.has(ckey) ?? false;

        const crow = document.createElement("div");
        crow.className = "viewweaver-row comp-row";
        if (!visible) crow.classList.add("is-hidden");
        crow.style.paddingLeft = `${(depth + 1) * 12 + 4}px`;

        const placeholder = document.createElement("span");
        placeholder.className = "arrow placeholder";
        placeholder.textContent = "·";
        crow.appendChild(placeholder);

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked;
        cb.onchange = (): void => {
          let set = st.compChecked.get(node.path);
          if (!set) {
            set = new Set();
            st.compChecked.set(node.path, set);
          }
          if (cb.checked) set.add(ckey);
          else set.delete(ckey);
          updateConfigFromState(panel);
          updateSummary(panel);
        };
        crow.appendChild(cb);

        const nm = document.createElement("span");
        nm.className = "name " + (comp.builtin ? "is-builtin" : "");
        const idxStr = comp.indexAmongSameType > 0 ? `#${comp.indexAmongSameType}` : "";
        nm.textContent = `${comp.tsName}${idxStr}`;
        crow.appendChild(nm);

        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = comp.builtin ? "cc" : "script";
        badge.title = comp.importFrom ?? "";
        crow.appendChild(badge);

        container.appendChild(crow);
      }

      for (const child of node.children) {
        visit(child, depth + 1, visible);
      }
    }
  };

  visit(st.prepared.tree, 0, true);
  updateSummary(panel);
}

function updateSummary(panel: PanelThis): void {
  const st = panel.state;
  const el = panel.$.summary as HTMLElement | null;
  if (!st || !el) return;
  let nodes = 0;
  let comps = 0;
  for (const v of st.nodeChecked.values()) if (v) nodes++;
  for (const set of st.compChecked.values()) comps += set.size;
  el.textContent = `已选 ${nodes} 节点 · ${comps} 组件`;
}

function updateConfigFromState(panel: PanelThis): void {
  const st = panel.state;
  if (!st) return;
  const stNonNull: PanelState = st;
  // 从 state 重建 BindConfig.nodes
  // 仅对 nodeChecked / compChecked 中"有任一为真"的 path 输出 entry，
  // 其余路径完全不出现在 bind 里（保持文件最小）
  const oldNodes = stNonNull.config.nodes;
  const oldByPath = new Map(oldNodes.map((n) => [n.path, n] as const));
  const defaultNodes = stNonNull.prepared.defaultConfig.nodes;
  const defaultByPath = new Map(defaultNodes.map((n) => [n.path, n] as const));
  const nextNodes: BindNodeEntry[] = [];

  // 按节点路径稳定排序，保证 diff 整齐：用默认 config 的顺序作为基准
  const allPaths = new Set<string>();
  for (const p of stNonNull.nodeChecked.keys()) if (stNonNull.nodeChecked.get(p)) allPaths.add(p);
  for (const [p, set] of stNonNull.compChecked.entries()) if (set.size > 0) allPaths.add(p);

  // 优先按 default config 的 path 顺序输出
  const seen = new Set<string>();
  for (const n of defaultNodes) {
    if (!allPaths.has(n.path)) continue;
    seen.add(n.path);
    nextNodes.push(buildEntry(n.path));
  }
  // 默认配置里没有的（用户手动加的）追加在后面
  for (const p of allPaths) {
    if (seen.has(p)) continue;
    nextNodes.push(buildEntry(p));
  }

  stNonNull.config.nodes = nextNodes;

  function buildEntry(p: string): BindNodeEntry {
    const old = oldByPath.get(p);
    const def = defaultByPath.get(p);
    const exposeNode = !!stNonNull.nodeChecked.get(p);
    const wantedComps = stNonNull.compChecked.get(p) ?? new Set<string>();
    const seenComp = new Set<string>();
    const components: BindComponentEntry[] = [];
    // 保留原顺序：先看 old 里有的、再看 default 里有的、再看勾选里全部
    const orderSources = [old?.components ?? [], def?.components ?? []];
    for (const list of orderSources) {
      for (const c of list) {
        const k = compKey(c.rawType, c.index ?? 0);
        if (!wantedComps.has(k) || seenComp.has(k)) continue;
        seenComp.add(k);
        components.push({ ...c });
      }
    }
    // 勾选里有但 old/default 都没的（罕见）：手工补一条最简的
    for (const k of wantedComps) {
      if (seenComp.has(k)) continue;
      const m = /^(.+)#(\d+)$/.exec(k);
      if (!m) continue;
      const rawType = m[1];
      const index = parseInt(m[2], 10);
      components.push({ rawType, index });
    }
    // 优先级：old → default → 由 path 派生 → "$root"
    const fieldFromOld =
      old?.field ?? def?.field ?? (p.replace(/[^A-Za-z0-9_]/g, "_") || "$root");
    return {
      path: p,
      field: fieldFromOld,
      exposeNode,
      components,
    };
  }
}

function configToState(prepared: PrepareConfigOk, config: BindConfig): {
  nodeChecked: Map<string, boolean>;
  compChecked: Map<string, Set<string>>;
} {
  const nodeChecked = new Map<string, boolean>();
  const compChecked = new Map<string, Set<string>>();
  for (const n of config.nodes) {
    if (n.exposeNode !== false) nodeChecked.set(n.path, true);
    if (n.components && n.components.length) {
      const set = new Set<string>();
      for (const c of n.components) set.add(compKey(c.rawType, c.index ?? 0));
      compChecked.set(n.path, set);
    }
  }
  return { nodeChecked, compChecked };
}

function setStatus(panel: PanelThis, msg: string, level: "info" | "warn" | "error" = "info"): void {
  const el = panel.$.status as HTMLElement | null;
  if (!el) return;
  el.textContent = msg;
  el.style.color =
    level === "warn"
      ? "var(--color-warn-fill, #d6a13a)"
      : level === "error"
      ? "var(--color-danger-fill, #d6595a)"
      : "";
}

// =====================================================================
// cocos 生命周期
// =====================================================================

export function ready(this: PanelThis): void {
  this.state = null;
  // 顶部工具条按钮
  const expandAll = this.$.expandAll as HTMLElement | null;
  const collapseAll = this.$.collapseAll as HTMLElement | null;
  const selectDefault = this.$.selectDefault as HTMLElement | null;
  const selectNone = this.$.selectNone as HTMLElement | null;
  const reset = this.$.reset as HTMLElement | null;
  const save = this.$.saveBindOnly as HTMLElement | null;
  const gen = this.$.generate as HTMLElement | null;
  const search = this.$.search as HTMLElement | null;

  expandAll?.addEventListener("confirm", () => {
    if (!this.state) return;
    this.state.collapsed.clear();
    renderTree(this);
  });
  collapseAll?.addEventListener("confirm", () => {
    if (!this.state) return;
    walkAllPaths(this.state.prepared.tree, (p, hasChildren) => {
      if (hasChildren) this.state!.collapsed.set(p, true);
    });
    // 始终保持 root 展开
    this.state.collapsed.set("", false);
    renderTree(this);
  });
  selectDefault?.addEventListener("confirm", () => {
    if (!this.state) return;
    const re = configToState(this.state.prepared, this.state.prepared.defaultConfig);
    this.state.nodeChecked = re.nodeChecked;
    this.state.compChecked = re.compChecked;
    updateConfigFromState(this);
    renderTree(this);
    setStatus(this, "已重置为默认勾选");
  });
  selectNone?.addEventListener("confirm", () => {
    if (!this.state) return;
    this.state.nodeChecked.clear();
    this.state.compChecked.clear();
    updateConfigFromState(this);
    renderTree(this);
    setStatus(this, "已全部取消勾选");
  });
  reset?.addEventListener("confirm", () => {
    if (!this.state) return;
    const re = configToState(this.state.prepared, this.state.prepared.defaultConfig);
    this.state.nodeChecked = re.nodeChecked;
    this.state.compChecked = re.compChecked;
    this.state.config = JSON.parse(JSON.stringify(this.state.prepared.defaultConfig));
    updateConfigFromState(this);
    renderTree(this);
    setStatus(this, "已重置为默认配置");
  });
  save?.addEventListener("confirm", async () => {
    if (!this.state) return;
    setStatus(this, "正在保存 bind.json …");
    const r = (await Editor.Message.request("viewweaver", "save-bind-only", {
      uuid: this.state.uuid,
      bindConfig: this.state.config,
    })) as { ok: boolean; bindJsonPath?: string; message?: string };
    if (r.ok) {
      setStatus(this, `已保存 bind.json：${r.bindJsonPath}`, "info");
    } else {
      setStatus(this, `保存失败：${r.message ?? "?"}`, "error");
    }
  });
  gen?.addEventListener("confirm", async () => {
    if (!this.state) return;
    setStatus(this, "正在生成 .gen.ts …");
    const r = (await Editor.Message.request("viewweaver", "apply-and-generate", {
      uuid: this.state.uuid,
      bindConfig: this.state.config,
    })) as ApplyResult;
    if (r.ok) {
      const ms = r.durations?.total ?? 0;
      const sr = r.scriptResolve;
      const srTip = sr ? ` · 自定义脚本 ${sr.resolved}/${sr.totalUnknown}` : "";
      setStatus(this, `✓ 已生成 ${r.outFile}  (${ms}ms${srTip})`, "info");
    } else {
      setStatus(this, `生成失败：${r.error?.phase}: ${r.error?.message}`, "error");
    }
  });

  search?.addEventListener("input", () => {
    if (!this.state) return;
    // ui-input 触发的实际 value 在 .value 上
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.state.searchKeyword = String((search as any).value ?? "");
    renderTree(this);
  });
}

export async function update(
  this: PanelThis,
  assetList: AssetInfoLite[]
): Promise<void> {
  // 多选时只看第一个；非 prefab 直接什么都不显示
  const target = assetList?.[0];
  if (!target?.uuid) {
    setStatus(this, "（未选中 prefab）");
    (this.$.treeContainer as HTMLElement).innerHTML = "";
    return;
  }
  setStatus(this, "解析中 …");

  const result = (await Editor.Message.request(
    "viewweaver",
    "prepare-prefab-config",
    target.uuid
  )) as PrepareConfigResult;

  if (!result.ok) {
    setStatus(this, `解析失败：${result.message}`, "error");
    (this.$.treeContainer as HTMLElement).innerHTML = "";
    this.state = null;
    return;
  }

  // 构造 state
  const checks = configToState(result, result.config);
  this.state = {
    uuid: target.uuid,
    prepared: result,
    // deep clone config 以避免改到 prepared.config 这份"快照"
    config: JSON.parse(JSON.stringify(result.config)),
    nodeChecked: checks.nodeChecked,
    compChecked: checks.compChecked,
    collapsed: new Map<string, boolean>(),
    searchKeyword: "",
  };
  // 初始：只展开第一/二层，其余折叠
  walkAllPaths(result.tree, (p, hasChildren, depth) => {
    if (hasChildren && depth >= 2) this.state!.collapsed.set(p, true);
  });

  setStatus(
    this,
    result.hasExistingBind
      ? `已加载 bind.json（${result.config.nodes.length} 节点条目）`
      : `首次配置：使用默认规则预选（${result.defaultConfig.nodes.length} 节点条目）`,
    result.hasExistingBind ? "info" : "warn"
  );
  updateConfigFromState(this);
  renderTree(this);
}

export function close(this: PanelThis): void {
  this.state = null;
}

// =====================================================================
// 工具
// =====================================================================

function walkAllPaths(
  node: SerializedNode,
  cb: (path: string, hasChildren: boolean, depth: number) => void,
  depth = 0
): void {
  cb(node.path, node.children.length > 0, depth);
  for (const ch of node.children) walkAllPaths(ch, cb, depth + 1);
}
