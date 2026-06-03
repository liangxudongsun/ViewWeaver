# 99 — Decision Log

> 决策日志：记录各个关键技术选择的备选方案、理由、推翻条件。  
> 顺序：从早到晚（在底部追加新决策）。

格式：

```
### Decision-NN: <主题>
- 决定：……
- 备选方案：A / B / C
- 选 X 的理由：……
- 推翻条件：……（什么情况下要回头改）
```

---

### Decision-01: 动画库基础选型 — cc.tween 而非 GSAP

**决定**：基于 Cocos 内置 `cc.tween` 构建 IAnim，不引入 GSAP。

**备选方案**：
- A. **cc.tween**：Cocos 引擎自带，与 director 调度系统集成，0 体积成本；
- B. **GSAP**：业界最强动画库，API 优雅、性能极致、生态丰富；
- C. **Tween.js**：轻量第三方库；
- D. **Velocity.js / popmotion / 其他**。

**选 A 的理由**：

1. **零依赖**：cc.tween 已在 cc 包里，不用额外引入；
2. **Director 集成**：天然受 `director.pause()` 影响，跟游戏暂停一致；
3. **TweenSystem 统一**：和 cc.Animation / Skeleton 共享同一个调度时间线；
4. **GSAP 商业许可问题**：GSAP 的 club 插件（Spring/MorphSVG/SplitText 等）有商业许可成本，普通用法虽然可以 free，但是项目想用高级特性时会卡；
5. **GSAP 体积**：~50-150KB（看用了哪些插件），对手游包体不友好；
6. **性能差异不显著**：在 Cocos 渲染瓶颈下（贴图、合批、shader），动画驱动的 CPU 开销基本不是瓶颈，cc.tween 的常数项开销已经够低；
7. **API 上 IAnim 已经把 cc.tween 包起来**：业务侧不直接用 cc.tween，而是用 IAnim 的 `tweenTo / fadeIn / scaleTo / ...`，缓动函数可以扩展（Phase 6），因此底层换不换 GSAP 业务无感。

**推翻条件**：
- cc.tween 在某些 easing / 性能 / API 上出现严重 bug 阻塞；
- GSAP 出免费、轻量、可商用版本（不太可能）；
- 项目转型 H5/CSS 动画密集型，GSAP 的 DOM 优势能用上。

---

### Decision-02: 不为本项目实现 prefab 缓存

**决定**：当前 slots 项目场景下不引入 prefab 缓存层；每次需要时 instantiate，使用完 destroy。

**备选方案**：
- A. **每次 instantiate / 用完 destroy**：简单，无状态；
- B. **池化**：保留一定数量的 prefab 实例供复用；
- C. **延迟 destroy**：destroy 时延后到 N 帧后真正释放，期间可被复用。

**选 A 的理由**：

1. **slots 游戏特点**：UI 弹窗频次不高，主要是周期性结算 / 少量操作面板，不像射击/RTS 那样每秒生成几十个特效；
2. **复杂度成本高**：池化要管理 reset 状态、归还时机、对象生命周期，bug 多；
3. **内存换 CPU 的取舍**：slots 设备主要 RAM 紧张（手机端老旧机器），prefab 缓存常驻内存得不偿失；
4. **创建成本可接受**：单次 instantiate 一个 UI prefab 通常 < 16ms，玩家不感知。

**推翻条件**：
- 性能 profile 显示 instantiate 是热点（连续 frame drops）；
- 某个 prefab 创建成本异常高（含大量 spine / 特效）且高频出现。

---

### Decision-03: GameReel 不入 V1 范围

**决定**：anim V1 不包含 GameReel 重构。GameReel 是 IAnim 的**消费者**，不是 IAnim 的一部分。

**用户原话**："GameReel 动画不用装入。我们只保证最小动画单元我们都支持就可以。我們的設計目標就是用于重構舊動畫"

**备选方案**：
- A. **不动 GameReel**：anim V1 仅提供原语，GameReel 后续单独项目重构；
- B. **GameReel 用 IAnim 包一层**：保持其内部状态机不动，只把动画部分接到 IAnim；
- C. **彻底重构 GameReel 为 ReelLogic + ReelView + SlotController**（之前讨论的 MVC 拆分）。

**选 A 的理由**：

1. **GameReel 是 god class**：~3000 行，状态机 + 动画 + 节点操作 + 业务逻辑混合，重构是一个独立项目；
2. **风险隔离**：anim V1 的目标是"提供最小动画单元"，不应受 GameReel 重构的牵连；
3. **更小可验证的范围**：先确保 IAnim 在小型动画上稳定，再考虑大型重构；
4. **未来路径开放**：等 IAnim 稳定了，GameReel 可以渐进迁移（先把动画部分换成 IAnim，再拆状态机，再拆 view）。

**推翻条件**：
- IAnim 设计能完美承载 reel 的所有动画形态，且 GameReel 重构有强业务需求（如新功能要求）。

---

### Decision-04: Timeline 可视化编辑器不入 V1

**决定**：不在 V1 阶段做 Cocos Editor 扩展级别的时间轴编辑器。

**备选方案**：
- A. **不做**（当前选择）；
- B. **简单导出 JSON 编辑器**（只编辑数值，不可视化）；
- C. **完整时间轴**（可视化拖块编排）。

**选 A 的理由**：

1. **过早投入**：当前没有客户实际要求；
2. **体量大**：Editor 扩展 + 自定义 Inspector + 序列化格式 + 反序列化解释器，至少 2 周；
3. **ROI 低**：项目里需要复杂动画的地方不多（Spine 做了一部分），代码描述足够；
4. **代码即设计**：seq/par/race 这种命令式描述在程序员手里其实比拖拽更高效。

**推翻条件**：当代码描述的动画超过 50 处且复杂度持续上升时，再考虑 V3 引入。

---

### Decision-05: 不做运行时 Anim Monitor

**决定**：不做"游戏运行时显示当前 anim 树"的可视化监视器。

**备选方案**：
- A. **不做**；
- B. **简单 console.log 输出当前 anim 状态**；
- C. **完整 overlay UI 显示 anim 树 + 进度条**。

**选 A 的理由**：

1. 调试方便但不影响功能；
2. 实现需要 IAnim 实例订阅 / UI overlay / 可能要侵入 Anim 基类加更多生命周期 hook；
3. console.warn / console.log + breakpoint 调试在 V1 阶段够用。

**推翻条件**：anim 树规模上 100+ 节点、肉眼调试困难时，V1.5 加进来。

---

### Decision-06: IRepeatableAnim 接口而非分裂 InfiniteAnim

**决定**：用同一个 `IAnim` 接口 + `readonly isInfinite: boolean` 元属性 + `IRepeatableAnim extends IAnim` 添加 `gracefulStop()`，**不分裂出独立的 `InfiniteAnim` 接口**。

**备选方案**：
- A. **统一 IAnim + isInfinite 标志**（当前选择）；
- B. **分裂 IAnim（finite）+ IInfiniteAnim**：两个独立接口，play() 返回 Promise vs Handle；
- C. **联合类型 IAnim = IFiniteAnim | IInfiniteAnim**。

**选 A 的理由**：

1. **API 一致性**：业务侧不用关心是有限/无限，都用 `play() / cancel() / reset()`；
2. **编排算子可统一处理**：seq/par/race 接受任意 IAnim 数组，自己根据 isInfinite 推算整体属性；
3. **类型分裂的代价高**：A 和 B 两套接口意味着 par/race 等要写双签名（finite vs infinite），代码爆炸；
4. **运行时元属性足够**：`isInfinite` 是 readonly 字段，构造时确定，TS 类型守卫不太需要。

**取舍**：
- 牺牲了"用类型禁止 await infinite anim"的安全性，靠文档+约定弥补；
- 风险有限：`forever / loop(Infinity, ...)` 是显式的，业务侧不会无意中"误把有限当无限 await"。

**推翻条件**：实际开发中"误 await infinite"成为高频 bug 来源。

---

### Decision-07: gracefulStop 走 completed 而非新状态

**决定**：`IRepeatableAnim.gracefulStop()` 让动画在当前轮结束后走 `completed` 状态（Promise resolve），不引入新的 "stopping" 状态。

**备选方案**：
- A. **复用 completed**（当前选择）：gracefulStop → 当前轮结束 → completed → resolve；
- B. **加 stopping 状态**：gracefulStop → stopping → 当前轮结束 → completed；
- C. **独立 resolve/reject 之外的第三种结果**：让 caller 显式区分。

**选 A 的理由**：

1. **保持状态机精简**：4 个状态足够表达，加 stopping 增加复杂度；
2. **gracefulStop 是请求而非状态**：从外部观测来看，gracefulStop → 一段时间后 completed，中间状态无业务意义；
3. **resolve 语义自洽**："播完一轮停"是业务正常流程的一部分，不是错误；
4. **简化测试**：少一个状态少一组转换规则。

**推翻条件**：实际使用中需要"区分自然完成 vs gracefulStop 完成"（比如统计/日志/动画分析），届时加 onComplete 钩子带原因码即可，仍不需要新状态。

---

### Decision-08: 节点 destroy 自动取消默认开

**决定**：所有节点级原语（Phase 3+）在 onStart 内部自动调 `_autoCancelOnDestroy(node)`，无 opt-out。

**备选方案**：
- A. **默认开**（当前选择）；
- B. **默认关，opt-in**：构造选项 `{ autoCancelOnDestroy: true }`；
- C. **完全手动**：业务自己负责。

**选 A 的理由**：

1. **脏 tween 是项目历史 bug 来源**：节点 destroy 后还有 tween 改属性，引发各种奇怪问题；
2. **关 + opt-in 心智负担大**：业务侧每次都要记得加，否则有泄漏；
3. **关闭场景极少**：唯一可能用到"持续到节点销毁后还想用动画"的是不依赖节点的纯标量 anim（animateValue 不绑节点的形式），这种 anim 自然不会调 `_autoCancelOnDestroy`。

**推翻条件**：业务侧出现合法的"我就要 anim 比节点活得久"用例（罕见）。

---

### Decision-09: compose 算子启动子 anim 前 reset

**决定**：seq/par/race 在启动每个子 anim 前，如果子 anim 状态不是 idle，就先 reset()。

**理由**：防御"实例被外部用过、现在是 completed/cancelled 终态"导致 play() 立即 resolve/reject 引发的悬挂或秒赢。

**取舍**：
- 子 anim 实例的所有权约定为"交给 compose 后归 compose 管"；
- 不能把同一个 anim 实例同时塞进两个 compose（会互相 reset 进度，行为未定义）；
- 复用动画"模板"用工厂函数（每次 fresh 一个实例）。

**推翻条件**：实际使用中复用同一实例的需求频繁出现（不太可能）。

---

### Decision-10: console.warn 而非 throw 处理不合理 compose

**决定**：`seq(infiniteFirst, ...)`、`loop(n, infiniteChild)`、`forever(infiniteChild)` 等不合理组合走 `console.warn`，不抛错。

**备选方案**：
- A. **console.warn**（当前选择）；
- B. **throw Error**：阻塞执行；
- C. **silent**：什么都不做。

**选 A 的理由**：

1. **不阻塞业务**：开发期看到 warn 修；线上即使有 warn 也不崩；
2. **可发现**：开发期 warn 在 console 一定看到；
3. **比 silent 强**：silent 让 bug 永久潜伏；
4. **比 throw 友好**：业务侧 typo 不会让游戏白屏；
5. **报警一次就停**：seq 的 warn 用 `break`，避免刷屏。

**推翻条件**：CI 集成时希望 warn → error 阻断 PR，可加 lint 工具单独扫源码。

---

### Decision-11: doc 放在 anim 库内部

**决定**：本系列文档放在 `assets/scripts/common/anim/docs/`，紧贴代码；不放在项目顶层 `docs/` 或 submodule 顶层。

**理由**：

1. anim 库自带文档便于查阅和维护；
2. submodule 顶层 `doc/` 已被项目其他用途占用（含 PNG 图片资源），不混；
3. 项目顶层目前没有 `docs/`，独立维护成本高。

**推翻条件**：项目级文档体系建立后，可能会把跨模块的"05-context.md"上提；anim 自身的 contract / compose / cookbook 仍留在 anim/docs/。

---

### Decision-12: Timeline event 走 AnimEventScope，而非 ctx 散 callback

**决定**：play() 内部的命名时刻用 `AnimEventId` + `AnimEventScope.emit()` + `bindAnimEventHandlers()`；**不在** `IAnimBuildContext` 上挂 `onXxx?: () => void` 匿名 callback。

**备选方案**：
- A. **AnimEventScope + spec 表**（当前选择）；
- B. **ctx 上 optional callback**（wheelboard 现状：`onSymbolDrop?`）；
- C. **全局 EventBus**（跨 anim 会话，难追踪生命周期）。

**选 A 的理由**：

1. **可发现**：event id 常量 + `AnimEventSpec` + grep handler 注册块；
2. **motion 层业务无关**：只 `emit(id, payload)`，不知拖尾/smart 是什么；
3. **与 compose 边界清晰**：起止用 seq/par，过程 marker 用 event；
4. **类型可扩展**：业务域 `Record<AnimEventId, Payload>` 而不污染 common。

**推翻条件**：event 数量极少且永不增长，spec 表维护成本高于闭包（unlikely）。

