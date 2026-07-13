# 05 — Architectural Context

> 本文记录 IAnim 设计**为什么会以现在这个样子出现**：项目动画现状扫描、与其他系统（IView / Presenter / Widget）的关系、未来"async-transparent UI 框架"的长期愿景。
>
> 这一系列设计讨论是 anim V1 的**因**，IAnim 的契约与 API 是**果**。

## 目录

- [项目动画现状扫描](#项目动画现状扫描)
- [IView 契约关系](#iview-契约关系)
- [View / Presenter 加载流程分析](#view--presenter-加载流程分析)
- [Widget vs 动画冲突](#widget-vs-动画冲突)
- [fadeIn/fadeOut 拆分：onShow/playEnter](#fadeinfadeout-拆分onshowplayenter)
- [async-transparent API 长期愿景](#async-transparent-api-长期愿景)

---

## 项目动画现状扫描

设计 IAnim 之前对项目的扫描结果（基于 `assets/scripts/` 下所有 `.ts` 文件）：

### cc.tween 用法

- 主要属性：opacity（UIOpacity）/ scale / position / color；
- 节奏：大量 `await Utils.delay(ms)` 充当步骤分隔（隐式串联）；
- 并发：少量 `.parallel(...)` 用法；
- easing：约 90% 用 `linear / sineIn / sineOut`，剩余主要是 `quadIn`、`bounceOut`；
- cancel：散落的 `Tween.stopAllByTarget(node)` 调用，没有统一约定。

### cc.Animation / AnimationController

- 角色 / 特效大量用 AnimationController + `setValue("trigger", true)`；
- 等待完成主要靠 `setTimeout(durationMs)` 兜底（不是 FINISHED 事件）；
- 某些场景同一 controller 上重复 trigger 没去重，导致动画重叠。

### sp.Skeleton (Spine)

- 用 `setAnimation(0, name, loop)` + `setCompleteListener` 等待；
- 多动画切换有少量手写状态机；
- cancel 几乎不存在（spine 自己有一套 trackEntry，没接到外部 cancel 体系）。

### ParticleSystem

- 直接 `play()` / `stopEmitting()`；
- 完成时机：业务自己估算时长或者用 timer 兜底；
- 没有"等粒子全部消失"的统一等待。

### 自定义工具（项目原有）

| 工具 | 实现风格 | 现状 |
|---|---|---|
| `ShakeTool` | `setTimeout(do, intervalMs)` | 不接 director.pause；难 cancel |
| `RollingScore` | `cc.tween + onUpdate` 自实现 | 风格独立 |
| `CustomizeTween` | 手写帧驱动 + RealCurve | 性能 OK 但没 IAnim 接口 |
| `BezierCurve` | 手算曲线点 | 没 cancel；调用方式不统一 |

### 痛点总结

1. **接口风格碎片化**：每种动画一套 API，业务侧记不全；
2. **cancel 机制不统一**：脏 tween、timer 泄漏、节点 destroy 后还在改属性的问题反复出现；
3. **编排靠 await 字符串拼接**：`await playA(); await Utils.delay(300); await playB();` 这种代码缺乏结构；
4. **节点生命周期与动画生命周期没绑定**：一旦 prefab 销毁，零散资源（tween / timer / spine 监听）必须手动逐一释放。

→ **IAnim 的设计正是这些痛点的回应**：

- 痛点 1 → 单一 IAnim 接口
- 痛点 2 → CancelledError + 统一的 cancel/reset
- 痛点 3 → seq/par/race/loop/forever 编排算子
- 痛点 4 → `_autoCancelOnDestroy` 默认开

---

## IView 契约关系

### IView 是什么

`assets/scripts/views/IView.ts` 定义的视图运行时契约：

```typescript
export interface IView {
  bind(root: Node): void;
}

export interface IAnimatedView extends IView {
  playEnter(): Promise<void>;
  playExit(): Promise<void>;
}

export type IViewComponent = Component & IView;
export type IAnimatedViewComponent = Component & IAnimatedView;
```

由 `genbot` 工具自动生成的 `<prefab>.gen.ts` 自动 `implements IView`，业务派生的 `<prefab>.view.ts` 可选 `implements IAnimatedView`。

### IView 与 IAnim 的分工

| 层 | 关注什么 | 用什么 |
|---|---|---|
| IView | "视图怎么和 prefab 节点连起来" | bind(root: Node) → 保留对 button/label/sprite 等节点的引用 |
| IAnim | "视图怎么动" | 描述时间结构 + 取消语义 |
| IAnimatedView | 桥接两者 | playEnter/playExit 返回 IAnim（或 Promise） |

**关键设计点**：`IAnimatedView.playEnter()` 的实现**应当**返回 IAnim：

```typescript
// 推荐：返回 IAnim，让 Presenter 能链式编排或 race
export class CommonUiView extends _Common_uiView implements IAnimatedView {
  public playEnter(): IAnim {
    return par(
      fadeIn(this.root, 0.2),
      scaleTo(this.root, v3(1, 1, 1), 0.3),
    );
  }
  public playExit(): IAnim {
    return fadeOut(this.root, 0.2);
  }
}
```

这样 Presenter 层就能：

```typescript
await race(
  view.playEnter(),
  delay(2.0),       // 强制 2 秒后超时
).play();
```

而不是：

```typescript
await view.playEnter();   // 不能取消，不能编排
```

### 当前现实 vs 长期目标

当前的 `IAnimatedView` 接口签名是 `playEnter(): Promise<void>` 而不是 `: IAnim`，因为 IAnim 当时还没设计。等 anim 库 V2 整合阶段，可以考虑把签名升级为返回 IAnim（向下兼容：返回 `IAnim` 自动带 Promise，`await` 仍能用）。

---

## View / Presenter 加载流程分析

之前对项目当前 UI 体系的扫描结果（部分关键发现）：

### 当前流程（简化）

```
Presenter 构造（同步）
  ↓
Presenter.show() ← 业务侧调用
  ↓
UISys.load(prefabName) ← 异步：可能从 bundle / remote 加载
  ↓                       多个 Presenter 同时加载会竞争
prefab 加载完成
  ↓
UISys 触发 instantiate
  ↓
Node addComponent(View 类)
  ↓
view.bind(root)
  ↓
Presenter._bindingP resolve
  ↓
Presenter.fadeIn() ← 这是动画 + onShow 事件钩子混合体
```

### 发现的问题（已记录在分析报告里）

1. **多个 Presenter 同时 show()**：异步加载竞争 → 显示顺序可能错乱（不一定是构造顺序）；
2. **Presenter 没有"栈"概念**：UISys 只是一个加载器，缺少 push/pop 语义；
3. **fadeIn/fadeOut 是 leaky abstraction**：混合了"播放动画"和"触发 onShow 钩子"和"占位扩展点"三种职责；
4. **Widget 与动画冲突**：fadeIn 期间如果同时 widget.updateAlignment() 会打架（详见下一节）；
5. **没有"加载完但还不可见"中间态**：addChild 即触发 onLoad/onEnable，要么改成"挂上但 active=false"再 show，要么接受闪现。

`GenbotViewTester` 的 `visibleOnBind` 属性就是为了缓解第 5 点的临时方案：

```typescript
@property public visibleOnBind: boolean = false;

private async bindOnce(...) {
  // ...
  inst.active = this.visibleOnBind;  // 先关 active 再 setParent
  inst.parent = this.node;
  // ...
}
```

### 长期方向

V2 整合阶段考虑：

- Presenter 引入 push/pop 栈（每层 UI 一帧；切层时上一层 playExit 完成才下一层 playEnter）；
- 加载/绑定/上屏三阶段分离：`load() → bind() → show()`；
- `show()` 内部用 IAnim 编排 `playEnter`，业务侧不直接看到 `await`。

---

## Widget vs 动画冲突

### 问题本质

Cocos Node 只有**一个 transform 通道**：position / scale / rotation / size。Widget 组件每帧（或在 ALIGN 时机）写这个通道，目的是"贴左 100px、贴顶 50px、宽度跟父 80%"这样的布局。动画也写这个通道。

冲突场景：

```typescript
// 节点上挂 Widget（贴左 100、垂直居中）
// 业务想做一个"从右边滑入"的进场动画
moveFrom(node, v3(800, 0, 0), 0.3).play();
// 第 0 帧：动画把 position 设为 (800, 0, 0)
// 第 1 帧：Widget 看到 position 不符合贴左 100 → 强行覆盖
// 动画失效
```

### 推荐解决方案：节点分层

```
container Node (Widget 在这里：决定常态位置)
  └─ panel Node (动画作用在这里：进场/退场/反馈)
       └─ ... 实际 UI 内容
```

- container 只做布局，永不被动画动；
- panel 的常态位置 = (0,0,0) 相对 container；
- 进场动画把 panel 从 (800, 0, 0) tween 到 (0, 0, 0)；
- Widget 看到 container 没动，不掺和。

### ViewWeaver 的 lint 想法

未来 genbot 可以扫描 prefab：当一个节点同时挂 Widget 和被动画引用时报警，提示分层。这是 V2/V3 的功能。

---

## fadeIn/fadeOut 拆分：onShow/playEnter

### 当前 UIBasePresenter 的 fadeIn/fadeOut

读了项目的 `UIBasePresenter`，发现 `fadeIn` 和 `fadeOut` 这两个方法实际上塞了 3 件不同的事：

1. **播放进/退场动画**（视觉效果）；
2. **触发 onShow / onHide 业务钩子**（事件回调，业务逻辑）；
3. **作为子类扩展点**（可被覆盖以做额外初始化）。

这是典型的 leaky abstraction：业务子类要 override 时不知道改 fadeIn 是会破坏动画还是仅破坏钩子，时间点也不对（onShow 应该在动画**开始前**还是**结束后**？）。

### 建议拆分

```typescript
interface IAnimatedView extends IView {
  // 同步事件钩子：UI 要被显示出来 / 被隐藏前
  // 不返回 Promise，业务做轻量同步初始化（拉数据通常在 Presenter 层而非 View 层）
  onShow?(): void;
  onHide?(): void;

  // 异步动画：返回 IAnim
  // 与 onShow 调用顺序：onShow → playEnter → 完成 → 用户可交互
  // 与 onHide 调用顺序：playExit → 完成 → onHide → destroy
  playEnter(): IAnim;
  playExit(): IAnim;
}
```

签名上区分清楚：
- `onShow / onHide` 不返回 Promise → 不能 await → 暗示这里只能做同步小事；
- `playEnter / playExit` 返回 IAnim → 可 cancel、可编排、明确异步语义。

V2 阶段做这个迁移。当前 V1 anim 库提供了 IAnim，IAnimatedView 接口已经预留 playEnter/playExit。

---

## async-transparent API 长期愿景

### 用户的诉求

原话："其实我是希望设计一个 逻辑上不需要处理异步等待的框架"。

意思：业务侧写代码不需要满地 `await` —— 调 `presenter.show()`、`reel.spin()`、`ui.popup()` 等都是同步签名，框架内部自动序列化执行。

### 实现思路：两级队列

```
业务侧：
  ui.show("loading");       // 同步调用
  ui.show("battle");        // 同步调用
  ui.popup("levelUp");      // 同步调用

框架侧：
  layer "main":
    [show(loading), show(battle)] → 串行执行（实例级队列）
  layer "popup":
    [popup(levelUp)] → 串行执行
  layer 间：并行
```

每个 UI 实例 / 每个 layer 都有命令队列。push 命令是同步的；执行是异步的、按队列顺序的。

### 与 IAnim 的接口

每条命令最终落到一段 IAnim。命令调度器拿 IAnim 一个一个 play()，前一个完成才启动下一个；遇到 cancel 就 cancel 当前。

```typescript
// 框架内部伪代码
class LayerScheduler {
  private _queue: IAnim[] = [];
  private _current?: IAnim;

  enqueue(anim: IAnim) {
    this._queue.push(anim);
    if (!this._current) this._tick();
  }

  private async _tick() {
    while (this._queue.length > 0) {
      this._current = this._queue.shift();
      try { await this._current.play(); }
      catch (e) { /* CancelledError 吃掉 */ }
    }
    this._current = undefined;
  }
}
```

业务侧 `ui.show("foo")` 内部就是：

```typescript
class UISys {
  show(name: string) {
    const anim = this._buildShowAnim(name);
    this._mainScheduler.enqueue(anim);   // 同步入队
    return anim;                          // 想 await 也可以
  }
}
```

### 这是 V3 才会做的事

需要先把 V1 anim 库稳定下来、Presenter 重构完成（V2），再考虑这个全局调度器（V3）。

但 IAnim 的设计已经把"接入点"留好了：

- 命令是 IAnim → 调度器只需消费 IAnim，不需了解动画类型；
- cancel 协议统一 → 切层、跳过、超时都可以编排；
- isInfinite → 调度器知道哪些命令需要"主动停"（gracefulStop）才能让队列推进。

---

## 结语

IAnim V1 是一个相对独立的工具层：它不强制改变 Presenter / UISys / GameReel 的现有结构，而是提供一个"更好的零件"。

短期：业务侧用 IAnim 写新动画、迁移最痛的旧动画。
中期（V2）：IView / Presenter 与 IAnim 整合，fadeIn/fadeOut 拆分。
长期（V3）：async-transparent 调度器，全局 push/pop 栈，可视化工具。
