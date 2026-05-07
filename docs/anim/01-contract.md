# 01 — IAnim 契约

> 本文定义动画系统的最小协议：状态机、生命周期、取消语义、扩展接口。

## IAnim 接口

```typescript
interface IAnim {
  readonly state: AnimState;        // "idle" | "running" | "completed" | "cancelled"
  readonly isPlaying: boolean;      // state === "running"
  readonly isFinished: boolean;     // state === "completed" || "cancelled"
  readonly isInfinite: boolean;     // 是否无限长（构造时确定）

  play(): Promise<void>;
  cancel(): void;
  reset(): void;
  replay(): Promise<void>;          // = reset() + play()
}
```

### 字段语义

| 字段 | 类型 | 意义 |
|---|---|---|
| `state` | enum | 当前状态机槽位 |
| `isPlaying` | bool | 等价于 `state === "running"` |
| `isFinished` | bool | 等价于 `state === "completed" \|\| "cancelled"` |
| `isInfinite` | bool | 构造时确定的元属性，运行期不可变。详见 [02-compose.md § 无限动画](./02-compose.md#无限动画) |

### 方法语义

| 方法 | 作用 | 幂等性 |
|---|---|---|
| `play()` | 启动动画 | ✓ running 重复调用拿同一 Promise；completed 调用立即 resolve；cancelled 调用立即 reject |
| `cancel()` | 中断动画 | ✓ 非 running 是 no-op |
| `reset()` | 状态机回到 idle | ✓ 任何状态都可调；running 时会先 cancel |
| `replay()` | reset + play 语法糖 | – |

---

## AnimState 状态机

```
                    play()
        ┌─────────────────────────┐
        │                         ▼
      idle ─reset()──── running ─complete──→ completed
        ▲                  │              ┌───────┘
        │            cancel()             │
        │                  ▼          reset()
        └────reset()──── cancelled ───────┘
```

### 状态转换表

| 当前状态 | 触发 | 动作 | 新状态 | Promise 结果 |
|---|---|---|---|---|
| `idle` | `play()` | 创建新 Promise，调 `onStart()` | `running` | – |
| `idle` | `cancel()` | no-op | `idle` | – |
| `idle` | `reset()` | no-op（已经是 idle） | `idle` | – |
| `running` | `play()` | 返回原 Promise（幂等） | `running` | – |
| `running` | 自然完成（子类调 `_complete()`） | resolve Promise | `completed` | resolve() |
| `running` | 子类调 `_fail(err)` | reject Promise | `cancelled` | reject(err) |
| `running` | `cancel()` | 调 `onCancel()`，reject Promise | `cancelled` | reject(CancelledError) |
| `running` | `reset()` | 等价于 cancel() + 状态回 idle | `idle` | reject(CancelledError) |
| `completed` | `play()` | 返回 `Promise.resolve()` | `completed` | resolve() |
| `completed` | `reset()` | 状态回 idle | `idle` | – |
| `cancelled` | `play()` | 返回 `Promise.reject(CancelledError)` | `cancelled` | reject(CancelledError) |
| `cancelled` | `reset()` | 状态回 idle | `idle` | – |

### 关键不变式

1. **running 状态下一定有 in-flight Promise**。这是 `play()` 幂等的基础。
2. **completed / cancelled 是终态**，不会自动转回 idle。必须显式 `reset()` 或 `replay()` 才能再 play。
3. **`cancelled` 状态调 `play()` 会 reject**，不会"重新启动"。这避免了"以为在跑实际已死"的悬挂问题。业务想复用就显式 `replay()`。
4. **`onStart` 必须最终走到 `_complete()` 或 `_fail()` 之一**，否则 in-flight Promise 永久悬挂，await 会卡死。

---

## CancelledError

```typescript
class CancelledError extends Error {
  constructor(message = "anim cancelled") { super(message); }
}
```

### 用途

业务侧用 `instanceof CancelledError` 区分"动画跑完"和"动画被中断"：

```typescript
try {
  await anim.play();
  console.log("动画正常完成");
} catch (e) {
  if (e instanceof CancelledError) {
    // 被打断，不视为错误（玩家点了跳过/UI 关闭/页面切走）
    return;
  }
  throw e;  // 真正的错误
}
```

框架内部所有 compose 算子都依赖这一区分，避免"子 anim 被父级 cancel → 父级以为自己出错"的连锁误判。

---

## IRepeatableAnim — 可循环动画扩展

```typescript
interface IRepeatableAnim extends IAnim {
  gracefulStop(): void;
}
```

`loop` 和 `forever` 的返回值满足这个接口，多一个 `gracefulStop()`。

### gracefulStop vs cancel

| 方法 | 立即性 | Promise 结果 | 适用场景 |
|---|---|---|---|
| `cancel()` | 立刻打断（中间帧停下） | reject(CancelledError) | 强制中止：UI 关闭、节点 destroy、玩家强力跳过 |
| `gracefulStop()` | 当前轮跑完才停 | resolve() | 礼貌停止：spinner 数据来了、idle 退出时缩放回到原始尺寸、闪烁停在"亮起"那一帧 |

详见 [02-compose.md § gracefulStop](./02-compose.md#gracefulstop-的设计)。

---

## 自定义 Anim：继承 `Anim` 基类

绝大多数情况下，业务侧应该使用 Phase 2-5 提供的现成原语（`fadeIn / scaleTo / playSpine / shake / ...`）和 Phase 1 的编排算子。**只有当现成原语都满足不了时**，才需要自定义 IAnim。

### 模板

```typescript
import { Anim, AnimOptions, IAnim } from "common/anim";
import { Node, ParticleSystem } from "cc";

class MyCustomAnim extends Anim implements IAnim {
  public constructor(
    private readonly _node: Node,
    private readonly _someParam: number,
    opts?: AnimOptions,
  ) {
    super(opts);  // 默认 finite；想标记 infinite 就传 { infinite: true }
  }

  protected onStart(): void {
    // 1. 注册节点 destroy 自动 cancel（强烈推荐，避免脏 tween）
    this._autoCancelOnDestroy(this._node);

    // 2. 启动具体载荷（cc.tween / 计时器 / Spine / Particle / ...）
    //    完成时调 this._complete()，失败时调 this._fail(err)。
    someAsyncTask().then(
      () => this._complete(),
      (err) => this._fail(err),
    );
  }

  protected onCancel(): void {
    // 必须**同步**释放 onStart 启动的资源（停 tween、清 timer、停 spine、…）。
    // 状态机切换由 Anim 基类负责，这里只管资源。
    // 禁止在 onCancel 里 await——cancel 必须立即生效。
  }

  protected onReset(): void {
    // [可选] 清理子类私有状态（迭代器位置、循环计数等）。
    // 默认 no-op；编排算子（SeqAnim / LoopAnim 等）会用。
  }
}
```

### Anim 基类提供的工具

| 方法 | 调用时机 | 作用 |
|---|---|---|
| `_complete()` | onStart 内部，载荷自然完成时 | state → completed，resolve Promise |
| `_fail(err)` | onStart 内部，载荷异常失败时 | state → cancelled，reject Promise |
| `_autoCancelOnDestroy(node)` | onStart 内部 | 节点 destroy 时自动 cancel 本 anim |

`_complete()` / `_fail()` 都有"非 running 状态自动 no-op"的守卫，所以子类不用在 `cancel()` 后还小心翼翼地避免触发。

### onStart / onCancel / onReset 协议

| 钩子 | 是否同步 | 必须做的事 | 不能做的事 |
|---|---|---|---|
| `onStart` | 同步开始，最终异步 `_complete`/`_fail` | 启动载荷，至少最终走到 _complete 或 _fail 之一 | 不能死循环（永远不结束） |
| `onCancel` | **必须同步** | 释放 onStart 申请的资源 | 不能 await（cancel 必须立刻生效） |
| `onReset` | 同步 | 清理私有状态 | 不能改 Anim 基类的状态机槽位 |

---

## 节点 destroy 自动取消

`Anim._autoCancelOnDestroy(node)` 给所有作用于节点的 anim 用：

```typescript
protected onStart(): void {
  this._autoCancelOnDestroy(this._node);
  // ... 启动具体载荷
}
```

机制：通过 `Node.EventType.NODE_DESTROYED` 事件，节点 destroy 时把 anim cancel 掉。一个 anim 只能绑一个节点；多目标场景要么在 `onCancel` 里手动收尾，要么拆成多个 anim 用 `par()` 组合。

### 为什么需要

Cocos 中常见的脏 tween 问题：

```typescript
// 没有自动 cancel 时
const tween = cc.tween(node).to(2.0, { position: v3(100, 0, 0) }).start();
// ...
node.destroy();   // tween 还在跑！
// 1.5 秒内每帧都在改一个 destroy 节点的 position
```

IAnim 自动接管：

```typescript
const anim = moveTo(node, v3(100, 0, 0), 2.0);
anim.play();
// ...
node.destroy();   // anim 自动 cancel，tween 立刻停
```

### Phase 2+ 的所有节点级原语都默认启用

所有 `fadeIn / scaleTo / moveTo / playSpine / ...` 在 `onStart` 内部都会调 `_autoCancelOnDestroy`。业务侧不需要操心。
