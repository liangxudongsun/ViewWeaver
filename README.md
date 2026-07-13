# ViewWeaver

Cocos Creator 编辑器扩展，根据 prefab 自动生成强类型的 View 绑定代码 (`*.gen.ts`)，配合手写 View (`*.ts`) 形成可编译校验的「prefab 契约」。

> 设计初稿见 `proj-l-client/ui-framework-design.md` §3.5。

## 核心思路

```
xxx.prefab                            (美术维护，节点结构自由)
        │
        │  程序员通过编辑器面板勾选要导出的节点
        ▼
assets/scripts/views/xxx/
  xxx.bind.json                       (导出契约，进 Git，独立于 prefab)
        │
        │  扩展或 CLI 自动生成
        ▼
  xxx.gen.ts                          (内部基类 _XxxView，自动生成、禁止手改)
        │
        │  首次自动生成；之后由开发者维护
        ▼
  xxx.view.ts                         (业务 View 类 XxxView，extends _XxxView)
```

每个 prefab 同目录下生成一对文件：
- `xxx.gen.ts`：内部基类 `_XxxView`，包含字段、`bind()`、所有 button 的 `onClickXxx()` 默认空实现。每次都重写。
- `xxx.view.ts`：开发者类 `XxxView extends _XxxView`，**只在首次生成**，之后业务方修改、工具不会再覆盖。

## 输出布局（v0.2 起约定）

```
<project>/assets/scripts/views/
  __registry.json                     全局索引：prefab → gen.ts / view.ts 映射
  common_ui/
    common_ui.gen.ts                  内部基类 _Common_uiView（自动生成）
    common_ui.view.ts                 开发者类 Common_uiView（仅首次生成、可手改）
    common_ui.bind.json               节点契约配置
  maingame/
    maingame.gen.ts
    maingame.view.ts
    maingame.bind.json
  ...
```

所有生成产物**扁平归档**到 `_genbot/<prefabName>/`，不跟随 prefab 原路径。
prefab 移动 / 重命名时只需改 `__registry.json` 里的 `prefabPath`，业务代码不受影响。

## 进度

### v0.1 ✓（CLI 雏形）

- [x] PrefabParser：解析 Cocos prefab JSON 为节点树（含同名兄弟消歧）
- [x] ComponentTypeMap：内置 cc.\* / sp.\* / dragonBones.\* 常用组件识别
- [x] BindJsonManager：默认 bind 配置生成 / 加载 / 保存 / 校验
- [x] GenTsGenerator：根据 bind 输出 `.gen.ts`，含 `NODE_PATHS` 常量与 `bind()` 方法
- [x] CLI 入口（Node 22 strip-types，零依赖跑通）
- [x] 用 `common_ui.prefab`（524 节点 / 1160 组件）端到端验证

### v0.2 进行中（Cocos 编辑器集成）

**阶段 1（已完成）— 扩展骨架**

- [x] 抽出 `runOnce(...)` 纯函数，CLI / 扩展 / 测试三方共享
- [x] 输出路径自动写到 `<project>/assets/scripts/views/<prefabName>/`
- [x] `__registry.json` 全局索引，原子写入
- [x] `tsconfig.build.json` + npm 脚本（build / watch / clean / cli / test）
- [x] 自带 `types/editor.d.ts` 最小 Cocos Editor API 类型声明（不依赖 npm 包就能编码）
- [x] 完整 contributions 声明：右键菜单 + 顶部 Tools 菜单 + 资源变更监听
- [x] `main.ts` 实现：`generateFromAsset` / `regenerateAll` / `validateAll` / `onAssetChange`
- [x] i18n（中英文菜单）
- [x] 23 个 smoke 测试（parser / config / runOnce / ProjectLayout / RegistryManager / UuidCompress / TsClassExtractor / ScriptTypeRegistry / 真实项目集成）

**阶段 3（已完成）— 自定义脚本类型识别**

- [x] **UUID 压缩/解压**：cocos prefab `__type__`（23 字符 base64）↔ `.ts.meta` UUID（标准 36 字符）双向转换
- [x] **TsMetaScanner**：递归扫描 `assets/` + `extensions/`，建立 UUID → ts 路径索引（实测 194 文件 / 13ms）
- [x] **TsClassExtractor**：正则解析 `.ts` 抓 `@ccclass` 类名，识别 `export` / `export default` 形式
- [x] **ScriptTypeRegistry**：组合上述模块，提供 `resolve(uuid)` → `{ tsName, importFrom, isDefaultExport }`
- [x] **跨目录 import 路径**：自动计算 `_genbot/<x>/x.gen.ts` 到 `assets/...` 或 `extensions/...` 下脚本的相对路径
- [x] **default / named import 区分**：`import CommonUI from "..."` vs `import { Foo } from "..."`
- [x] **根节点组件暴露**：根节点上的脚本（如 CommonUI 挂在 prefab root）也能生成访问字段
- [x] **实测 common_ui.prefab：60/60 实例 4/4 类型 100% 解析**（CommonUI / L10nLabel / ButtonChildrenColor / ButtonScale）

**阶段 2B（已完成）— Inspector 注入**

> 设计变更：放弃独立 Panel，改为把导出配置 UI 直接挂到 Cocos 自带 Inspector
> 面板里。通过 `contributions.inspector.section` 注入，不开新窗口、不改 prefab。

- [x] **package.json**：注册 `inspector.section.asset.prefab` + `inspector.section.node.cc.UITransform`
- [x] **prefab inspector**：单击 `.prefab` 文件 → Inspector 面板出现节点树 / 折叠 / 复选框 / 父子联动 / 组件列表 / 搜索
- [x] **prefab inspector 操作按钮**：`[重置为默认]` / `[仅保存 bind.json]` / `[生成]`，带状态条提示耗时和错误
- [x] **node-uitransform inspector**：选中含 UITransform 的节点 → 底部出现 `✓ 导出为 xxx` / `☐ 未导出 [+ 加入 bind.json]` 迷你状态条
- [x] **runOnce 扩展**：新增 `bindConfigOverride` 选项，支持面板把 bind 配置直接传进生成流程，绕过磁盘读取
- [x] 5 个新跨进程消息：`prepare-prefab-config` / `apply-and-generate` / `save-bind-only` / `query-node-status` / `toggle-node-export`

**阶段 4（计划中）— 工作流打磨**

- [ ] prefab 保存 → dry-run 后通知差异
- [ ] 节点冲突高亮
- [ ] 错误展示 UI

## 使用

### CLI（开发期 / 没装 Cocos 时也能用）

```bash
# 跑生成（自动找项目根 + 写到 assets/scripts/views/<name>/）
node --experimental-strip-types src/cli.ts <prefab-path>

# 强制重置 bind 配置
node --experimental-strip-types src/cli.ts <prefab-path> --regen-bind

# 仅预览不写盘
node --experimental-strip-types src/cli.ts <prefab-path> --dry-run

# 显式指定项目根
node --experimental-strip-types src/cli.ts <prefab-path> --project D:/work/myproject

# 跑测试
node --experimental-strip-types tests/smoke.test.ts
```

CLI 行为：
1. 解析 prefab，构建节点树
2. 找到 Cocos 项目根（含 `assets/` + `settings/` 的最近祖先目录）
3. 输出到 `<project>/assets/scripts/views/<prefabName>/`
4. 加载已有 `bind.json` 或生成默认配置
5. 生成 `*.gen.ts`，更新 `__registry.json`

### Cocos 编辑器（v0.2 阶段 1 起）

需要先 `npm install && npm run build`（仅在装了 Node + npm 的机器上）：

```bash
cd extensions/genbot
npm install
npm run build      # → dist/main.js
```

然后在 Cocos Creator 里启用扩展（Extension Manager）。可用入口：

| 入口 | 功能 |
|------|------|
| **资源面板 → 单击 prefab 文件 → Inspector 面板** | ⭐ 主入口：可视化勾选要导出的节点 / 组件，一键生成 |
| 资源面板 → 右键 prefab → "ViewWeaver：生成 PrefabView" | 用当前磁盘 bind.json（或默认规则）直接生成，不开 UI |
| 进入 prefab 编辑模式 → 选中任意 UI 节点 → Inspector | 看到 `✓ 导出为 xxx` 或 `[+ 加入 bind.json]` 迷你状态 |
| 顶部菜单 Tools > ViewWeaver > 全量重生 | 按 `__registry.json` 重生所有已注册 prefab |
| 顶部菜单 Tools > ViewWeaver > 校验所有 | 仅检查 bind.json 与 prefab 是否还匹配（不写盘） |

#### 主流程（推荐）

1. 在 Cocos Assets 面板里**单击**一个 `.prefab` 文件
2. 右侧 Inspector 面板里出现 `ViewWeaver · 导出配置` 区段，自动列出节点树
3. 勾选 / 取消你要导出的节点和组件（默认勾选规则见下文「默认导出策略」）
4. 点 **[生成]** —— 同时落盘 `bind.json` 和 `gen.ts`
5. 之后业务里 `import { Common_uiPrefabView } from "...common_ui.gen.ts"` 即可

> ⚠️ 注意：勾选某个节点的 `Node` 复选框 = 在 PrefabView 里暴露 `Node` 引用；勾选其上的具体组件复选框 = 暴露该组件引用（如 `view.title : Label`）。两者可独立勾选。

### 默认导出策略

为了避免一个 prefab 把上百个 Sprite/Label/UITransform 全暴露出来污染 PrefabView，
v0.2 起的默认规则只挑「按钮」相关：

| 规则 | 说明 |
|------|------|
| **触发集合** | 节点必须挂有 `cc.Button` **或 `extends Button` 的自定义脚本**才进入默认导出 |
| **暴露组件** | 仅暴露 `cc.Button` + Button 子类。**`ButtonScale` / `ButtonChildrenColor` 这类同节点辅助脚本默认不再连带导出**（业务侧需要时用 `view.btn.node.getComponent(ButtonScale)` 即可） |
| **Node 引用** | 默认 `exposeNode: false`（业务侧用 `view.btn.node` 即可），需要 Node 时在 Inspector 里手动勾选 |
| **字段命名** | 第一个组件复用节点路径派生名（如 `portraitBottomUIInfoBet`），后续追加 `_TsName` 后缀 |
| **onClick 自动绑定** | 每个导出的 Button / Button 子类，gen.ts 都会自动定义 `protected onClickXxx(): void {}` 钩子，并在 `bind()` 里注册 `Button.EventType.CLICK`。业务侧只在 view.ts 里 override 想要响应的钩子即可 |
| **view.ts 一次性** | 首次生成 view.ts 骨架（`extends _XxxView`），**之后工具永不覆盖**；新增 button 仅追加 gen.ts 中的空 hook，需要响应时再手动到 view.ts 里 override |

实测 `common_ui.prefab`（524 节点 / 1160 组件）：

| 项目 | v0.1 全暴露规则 | v0.2 button-only 规则 |
|------|--------------|--------------------|
| 节点 entry 数 | 400+ | **74** |
| 组件 entry 数 | ~800 | **74**（每个 button 节点一个 Button） |
| `gen.ts` 行数 | 3589 | ~600（约 1/6） |

需要恢复全暴露行为时（脚本 / 自动化场景），调用 `makeDefaultBindConfig` 时传：

```ts
makeDefaultBindConfig(parsed, {
  ...
  triggerBuiltinTypes: null,             // 取消触发限制
  exposedBuiltinTypes: new Set([...]),   // 自己列要暴露的内置组件
  exposeOtherCustomOnTriggers: true,     // 把其它自定义脚本也带上（ButtonScale 等）
  exposeTriggerNode: true,               // 同时把 Node 也暴露出来
});
```

Inspector 里依然可以**勾选任何非默认节点**——树永远是完整的，默认勾选只是基线，
任何节点 / 组件都能手动加进 bind.json。

### 业务侧使用生成的代码

业务方挂的是 view.ts 里的开发者类（不是 gen.ts 内部基类）。
gen.ts 已经把 Button 的 click 事件预先注册到了同名 `onClickXxx` 钩子，业务只 override 想响应的：

```ts
// common_ui.view.ts —— genbot 只在第一次生成这个文件，之后由你维护。
import { _decorator } from "cc";
import { _Common_uiView } from "./common_ui.gen";

const { ccclass } = _decorator;

@ccclass("Common_uiView")
export class Common_uiView extends _Common_uiView {
  // override gen.ts 中已声明的钩子
  protected onClickPortraitBottomUIInfoBet(): void {
    console.log("[view] bet button clicked");
  }

  // 同节点的 ButtonScale 等辅助脚本，按需自取
  start() {
    const scale = this.portraitBottomUIInfoBet.node.getComponent("ButtonScale");
    if (scale) scale.zoomScale = 1.2;
  }
}
```

```ts
// 业务侧调用方
import { Common_uiView } from "../_genbot/common_ui/common_ui.view";

const view = prefabRoot.addComponent(Common_uiView);
view.bind(prefabRoot);   // 来自 _Common_uiView，自动注册所有 button 的 CLICK
```

## 仓库结构

```
src/
  cli.ts                          CLI 入口（Node 22 strip-types 直接跑）
  main.ts                         Cocos 扩展入口（消息处理 + 菜单触发器）
  package.json                    type=module（让 strip-types 走 ESM）
  core/
    RunOnce.ts                    无 IO 副作用的核心生成流程，CLI/扩展共享
    ProjectLayout.ts              输出布局规则、项目根推断
    RegistryManager.ts            __registry.json 读写
  parsers/
    PrefabTypes.ts                prefab JSON 类型声明 & 类型守卫
    PrefabParser.ts               JSON → NodeTree（含路径推算、同名兄弟消歧）
    ComponentTypeMap.ts           cc.* / sp.* 组件类型映射
  generators/
    BindJsonManager.ts            bind.json I/O、默认配置、校验
    GenTsGenerator.ts             NodeTree + bind → .gen.ts
  utils/
    name-converter.ts             节点名 → 合法 TS 标识符
    paths.ts                      fs/path 小工具（含原子写入）
types/
  editor.d.ts                     Cocos Editor API 最小化类型声明
i18n/
  zh.js / en.js                   菜单 i18n
tests/
  smoke.test.ts                   14 个 smoke 测试
  check-gen-syntax.ts             生成代码语法校验工具
  fixtures/                       测试 fixture（不入仓）
  output/                         临时输出（不入仓）
package.json                      Cocos 扩展 manifest（contributions 声明）
tsconfig.json                     dev / strip-types 用
tsconfig.build.json               tsc 编译到 dist/（CommonJS，给 Cocos 加载）
```

## 远程

```
https://gitlab.fingergame.com/h5_game_sh_tpe/extension-tools/genbot
```

仓库工作目录嵌入在 `proj-l-client/extensions/genbot/`，使用真实 prefab 调试，但 `.git` 指向 GitLab。
