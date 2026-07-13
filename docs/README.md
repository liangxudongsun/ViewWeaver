# Framework Docs

> **关于命名**：本仓最初叫 `genbot`，是因为第一版只做了 prefab → view 自动生成。但实际职责正在快速扩张为整个项目的**新一代基础框架**。可以把这个仓库理解为：
>
> - **新的 common 库**（取代部分散落在 project-l-common 里的工具职责）
> - 或者 **base framework**（贯穿编辑器扩展 / 代码生成 / 运行时契约 / 动画 / UI 流程的全栈框架）
>
> 仓名暂时不动，但**心智上要按 framework 来理解**。所有跨模块的设计讨论、契约定义、架构演进文档都汇聚到这里。

## 目录布局

```
extensions/genbot/
├── src/                    # 编辑器扩展：prefab → view 代码生成器（"viewweaver" 本职）
├── assets/                 # 扩展资源（panel UI、菜单图标等）
├── tests/                  # 扩展逻辑的单元测试
├── docs/                   # ← 框架级设计文档（你现在在这里）
│   ├── README.md           # 本文
│   ├── anim/               # 动画系统 IAnim（运行时代码在 project-l-common）
│   └── (后续：iview/, presenter/, lifecycle/, ...)
└── ...
```

## 目录索引

### [docs/anim/](./anim/) — 动画系统 IAnim

用一套统一的 IAnim 抽象覆盖项目里所有动画形态（cc.tween / cc.Animation / sp.Skeleton / ParticleSystem / 自定义工具）。提供 seq/par/race/loop/forever 等编排算子和统一的 cancel 协议。

**代码**：在 project-l-common submodule 的 `assets/scripts/common/anim/`（runtime 路径硬约束）。
**主要 docs**：本目录下 7 篇 markdown，从契约 → 编排 → cookbook → roadmap → 上下文 → 决策日志。

V1 范围：核心契约 + 编排 + 无限动画支持（已完成）；后续 phase 推进属性 tween 原语、节点 sugar、Cocos 系统包装、遗留工具适配、easing 扩展、单元测试。

### ViewWeaver 自身（prefab → view 代码生成器）

入口：仓根的 `README.md`（即 `extensions/genbot/README.md`）。

提供：

- 扫描 `.prefab` → 生成 `__registry.json` 全局索引；
- 在 Cocos 编辑器 Inspector 注入"勾选要导出哪些节点"的 UI；
- 写出节点契约 `*.bind.json` + 自动生成的 `*.gen.ts` 内部基类 + 首次生成的 `*.view.ts` 业务类；
- `IView` 运行时契约（在 `assets/scripts/views/IView.ts`），所有 `*.gen.ts` 自动 `implements IView`；
- 默认导出规则：仅导出 `cc.Button` 子类型，自动生成 `onClickXxx()` 处理器并绑定。

### （计划中）docs/iview/ — IView 运行时契约

`assets/scripts/views/IView.ts` 里定义的视图运行时契约：

```typescript
interface IView { bind(root: Node): void; }
interface IAnimatedView extends IView {
  playEnter(): IAnim;
  playExit(): IAnim;
}
```

待 phase：把 IView / IAnimatedView 设计动机、与 IAnim 的桥接方式、ad-hoc duck typing 的退场过程整理到 `docs/iview/`。当前在 `docs/anim/05-context.md` 里有一节关于 IView 与 IAnim 关系的讨论可作起点。

### （计划中）docs/presenter/ — UI 加载 / 生命周期 / 栈

异步加载与显示分离、Presenter 栈、push/pop 语义、async-transparent API 长期愿景。当前在 `docs/anim/05-context.md` 里有讨论起点。

### （计划中）docs/lifecycle/ — Cocos 生命周期 vs 业务生命周期

setParent → onLoad/onEnable/start 的隐式触发、`visibleOnBind` 临时方案、Widget 与动画的 transform 通道冲突、节点分层模式。

---

## 跨仓一致性

由于物理约束，框架代码分布在多个 git 仓：

| 仓 | 角色 | 包含 |
|---|---|---|
| `extension-tools/genbot.git`（本仓） | 编辑器扩展 + 框架文档主源 | genbot 扩展代码 / framework 设计文档 |
| `common/project-l-common.git`（submodule） | runtime 公共代码 | anim 库代码 + docs 镜像 |
| `seth2/proj-l-client.git`（外层项目） | 项目主仓 | 业务代码、prefab、生成产物（`_genbot/`）、submodule 指针 |

**docs 同步策略**：framework 设计文档以本仓 `docs/` 为单一真源；放在 project-l-common 里的副本仅为 runtime 代码旁的便利 mirror。每次设计变动两边都更新，提交两次（先 project-l-common，再本仓）。

后续如果框架成熟、docs 数量大、drift 风险高，可考虑：

- 用 git submodule 反向引用：让 project-l-common 的 `anim/docs/` 指向本仓某个目录；
- 或在 CI 里加 docs sync 检查。

V1 阶段先用人工双写。

---

## 命名建议（如果以后有重命名机会）

`genbot` 这个名字过窄，听起来像一个生成器小工具。如果未来有机会重命名，候选：

- `proj-l-framework`
- `proj-l-base`
- `proj-l-newcommon`
- `proj-l-baseframework`

但仓库重命名涉及所有 clone 链路调整，暂不优先做。**通过文档来正名**：本 README 已经把心智模型说清楚，后续讨论按 framework 范畴来即可。
