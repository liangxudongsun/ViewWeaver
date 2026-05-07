# 02 — 编排算子

> 本文详解 `seq / par / race / loop / forever / delay / call` 的语义、传播规则、与无限动画的相互作用。

## 算子总览

```typescript
seq(a, b, c)          // 串行：a → b → c，全部完成才完成
par(a, b, c)          // 并行：所有同时开始，等所有 settle
race(a, b, c)         // 赛跑：所有同时开始，第一个完成就完成（其他自动 cancel）
loop(n, a)            // 循环 n 次
forever(a)            // 无限循环
delay(seconds)        // 等 N 秒
call(fn)              // 同步/异步函数包装为 anim 步
```

所有算子返回 `IAnim`（`loop` / `forever` 返回 `IRepeatableAnim`），可被再次组合。

---

## seq — 串行

```typescript
function seq(...anims: IAnim[]): IAnim
```

**语义**：依次播放，前一个 settle 后才启动下一个。所有完成才整体完成。

```typescript
seq(
  fadeIn(node, 0.3),
  delay(0.5),
  call(() => audio.play("ding")),
  fadeOut(node, 0.3),
)
```

**特殊情况**：
- `seq()` 空入参 → 返回立即完成的 anim；
- `seq(a)` 单个入参 → 直接返回 a，不包装。

**取消传播**：
- 父 cancel → 取消当前正在跑的 child（之前的已完成、之后的还没启动）；
- 任一 child 异常失败 → seq 整体 fail；
- child 被外部直接 cancel → 父 seq 也走 cancel 路径（不视为错误）。

---

## par — 并行

```typescript
function par(...anims: IAnim[]): IAnim
```

**语义**：所有 child 同时开始，**全部** settle 才整体完成。

```typescript
par(
  fadeIn(panel, 0.3),
  scaleTo(panel, 1.0, 0.3),
  playSpine(skeleton, "appear"),
)
// 三个动画同时开始，三个都跑完才整体完成
```

**取消传播**：
- 父 cancel → 取消所有 in-flight child；
- 任一 child 失败 → 取消其他，整组 fail；
- 任一 child 被外部 cancel → 取消其他，整组 cancel（不视为错误）。

---

## race — 赛跑

```typescript
function race(...anims: IAnim[]): IAnim
```

**语义**：所有 child 同时开始，**第一个** settle 就整体完成（其他自动 cancel）。

```typescript
// 等动画播完 or 玩家点了跳过 or 5 秒超时
await race(
  introAnim,
  waitForClick(skipButton),    // 假设有这种 anim
  delay(5),
).play();
```

**取消传播**：
- 父 cancel → 取消所有 in-flight child；
- 第一个 child 完成 → 取消其他，整体 complete；
- 第一个 child 失败 → 取消其他，整体 fail；
- 某个 child 被外部 cancel：**不影响 race**，继续等其他 child；
- 所有 child 都被取消 → race fail（避免悬挂）。

**经典模式 —— "无限背景 + 有限前景"**：

```typescript
await race(
  forever(idleBob),           // infinite 背景
  seq(intro, mainAct, exit),  // finite 前景
).play();
// 当前景完成，race 自动 cancel 掉 idleBob
```

---

## loop — 循环 n 次

```typescript
function loop(times: number, anim: IAnim): IRepeatableAnim
```

**语义**：把 anim 重复跑 `times` 次。

```typescript
loop(3, scalePop(node, 1.2, 0.15))    // 弹三下
```

**特殊情况**：
- `times <= 0` → 立即完成；
- `times = Infinity` → 等价于 `forever(anim)`，整体 isInfinite=true。

**每轮迭代前**自动 `reset()` 内层 anim，避免终态污染。

**返回值是 `IRepeatableAnim`**，支持 `gracefulStop()`：当前轮跑完后停（不打断中间帧），整体走 `completed` → Promise resolve。

---

## forever — 无限循环

```typescript
function forever(anim: IAnim): IRepeatableAnim
```

**语义**：永远循环。永远不会自然完成，必须通过 `cancel()` 或 `gracefulStop()` 停止。

```typescript
const breath = forever(seq(
  scaleTo(node, 1.05, 0.4),
  scaleTo(node, 1.0, 0.4),
));
breath.play();              // 不要 await
// ...
breath.gracefulStop();      // 缩放回到 1.0 才停（漂亮）
//   vs breath.cancel();    // 立刻打断，可能停在 1.03（难看）
```

**`isInfinite = true` 永远成立。**

---

## delay — 等 N 秒

```typescript
function delay(seconds: number): IAnim
```

**实现**：用 `cc.tween` 的空对象当 timer，**跟着 `director.pause()` 走**——游戏暂停时动画也暂停（不像 `setTimeout`）。

```typescript
seq(fadeIn(node, 0.3), delay(0.5), fadeOut(node, 0.3))
```

**特殊情况**：`seconds <= 0` 立即完成（不延迟一帧）。

---

## call — 函数副作用包装

```typescript
function call(fn: () => void | Promise<void>): IAnim
```

**语义**：把任意函数包成 anim 步。

- 同步函数：执行完即完成；
- 异步函数（返回 Promise）：等 Promise resolve/reject 后再切状态；
- 抛异常：走 `_fail` 路径。

```typescript
seq(
  fadeIn(node, 0.3),
  call(() => audio.play("ding")),                // 同步副作用
  call(async () => await loadSomething()),       // 异步步骤
  fadeOut(node, 0.3),
)
```

### 限制

`cancel()` 时只切状态机，**不真的中断用户函数的 Promise**。如果函数体很长，请显式做 abort 检查：

```typescript
call(async () => {
  for (let i = 0; i < 1000; i++) {
    if (someAbortFlag) return;     // 业务自己处理
    await processItem(i);
  }
})
```

---

## 无限动画

> "有限/无限"是 IAnim 的核心元属性，在构造时确定，运行期不可变。

### isInfinite 推算规则

每个算子的 `isInfinite` 由其子 anim 推算出来：

| 算子 | 推算规则 | 备注 |
|---|---|---|
| `delay(s)` | `false` | 永远有限 |
| `call(fn)` | `false` | 永远有限（即便 fn 是无限循环也别这么用） |
| `seq(a, b, c)` | 任一子 inf → 整体 inf | 推算后还会检查"非末尾位置出现 inf"并 `console.warn` |
| `par(a, b)` | 任一子 inf → 整体 inf | 等所有 settle，含 inf 就永远等不齐 |
| `race(a, b)` | **全部** 子 inf → 整体 inf；任一 finite → 整体 finite | 第一个 settle 就完事，有限子能保证整体有限 |
| `loop(n, a)` | child inf 或 n 非有限 → 整体 inf | child inf 时会 `console.warn` |
| `forever(a)` | 永远 `true` | child 也是 inf 时会 `console.warn` |

### console.warn 报警表

```typescript
seq(forever(blink), exitAnim);
// [anim] seq(): child #0 is infinite; the following 1 child(ren) will never run.

loop(3, forever(blink));
// [anim] loop(3, ...): inner anim is infinite; the first iteration never completes.

forever(forever(x));
// [anim] forever(): inner anim is already infinite; wrapping has no effect.
```

不报警的合法场景：
- `seq(intro, forever(idle))` —— 末尾 inf 表示"前面做完转入永久循环"，合法；
- `par(mainSeq, forever(bgGlow))` —— par 整体变 inf，业务上由外层 race 或 cancel 控制结束；
- `race(forever(inf1), mainSeq)` —— race 仍然 finite，mainSeq 决定结束。

### 使用模式

#### Pattern 1：fire-and-forget

```typescript
const idle = forever(seq(
  scaleTo(node, 1.05, 0.4),
  scaleTo(node, 1.0, 0.4),
));
idle.play();              // 别 await！
// ... 玩家退出 idle 状态
idle.gracefulStop();      // 转完一轮再停
```

#### Pattern 2：背景循环 + 前景动作（race 模式，推荐）

```typescript
await race(
  forever(idleBob),                // 无限背景
  seq(intro, mainAct, exit),       // 有限前景
).play();
// race 完成时，idleBob 自动被 cancel
```

#### Pattern 3：spinner 等数据

```typescript
const spin = forever(rotateBy(node, 360, 1.0));
spin.play();
const data = await fetch();
spin.gracefulStop();   // 转完一整圈停在 0° 位置
```

#### Pattern 4：超时取消

```typescript
try {
  await race(spinAnim, delay(10)).play();
} catch (e) {
  if (e instanceof CancelledError) {
    // 不会到这里，race 不 reject
  }
}
// race 永远在 10 秒内完成（超时由 delay 收尾）
```

---

## gracefulStop 的设计

`loop` 和 `forever` 返回的是 `IRepeatableAnim`，多一个 `gracefulStop()` 方法。

### 为什么需要

`cancel()` 立刻打断动画，可能停在视觉上难看的中间帧（spinner 卡在 47°、scale 卡在 1.03）。

`gracefulStop()` 让当前一轮播完后才停，整体走 `completed` → Promise 正常 resolve。区别于 cancel 的 reject。

### 实现机制

`LoopAnim` / `ForeverAnim` 内部有一个 `_gracefulStopRequested` 标记。`gracefulStop()` 设置标记后立即返回，当前轮 child 的 `play().then(...)` 完成时调 `_next()` 看到标记走 `_complete()`，跳过下一轮启动。

### 状态机视角

| 终态如何到达 | finite anim | infinite anim |
|---|---|---|
| 自然 complete | ✓ play() resolve | ✗ 不可能 |
| `cancel()` | play() reject(CancelledError) | play() reject(CancelledError) |
| `gracefulStop()` (loop/forever) | – | play() resolve（下一轮边界停） |
| 节点 destroy | 自动 cancel → reject | 自动 cancel → reject |

---

## 子 anim 的 reset 规则

所有 compose 算子在启动每个子 anim 之前都会 `reset()` 一遍（如果子 anim 不是 idle 状态）。这是防御性设计：

```typescript
const a = fadeIn(node, 0.3);
a.play();
a.cancel();          // a 现在是 cancelled 状态

const s = seq(a, fadeOut(node, 0.3));
await s.play();      // 没有 reset 防御的话：a.play() 立即 reject(CancelledError)
                     // → seq 永远悬挂！
```

加了 `if (cur.state !== "idle") cur.reset();` 后，seq 在跑 `a` 前先把它拉回 idle，正常播放。

**这暗含了一个所有权约定**：交给 compose 算子的 anim 实例，其生命周期归 compose 管理。**不要把同一个 anim 实例同时塞进两个 compose**，行为是未定义的（很可能两个 compose 互相 reset 对方的进度）。

要复用动画"模板"，请用工厂函数：

```typescript
const makeFade = (n: Node) => fadeIn(n, 0.3);   // 工厂
par(makeFade(a), makeFade(b));                  // 两个独立实例 ✓
// 而不是
const f = fadeIn(a, 0.3);
par(f, f);                                      // 同一个实例两次 ✗
```

---

## 取消传播总结表

| 触发方式 | seq | par | race | loop | forever |
|---|---|---|---|---|---|
| 父 cancel | 当前 child cancel | 所有 in-flight cancel | 所有 in-flight cancel | 当前轮 child cancel | 当前轮 child cancel |
| 父 gracefulStop | – | – | – | 当前轮跑完后 complete | 当前轮跑完后 complete |
| child 自然完成 | 推进下一个 | 计数+1，等齐则 complete | 取消其他，整体 complete | 推进下一轮 | 推进下一轮 |
| child fail | 整体 fail | 取消其他，整体 fail | 取消其他，整体 fail | 整体 fail | 整体 fail |
| child 被外部 cancel | 整体 cancel | 取消其他，整体 cancel | 不影响 race（继续等其他） | 整体 cancel | 整体 cancel |

> "整体 cancel" 在状态机上等价于"`_fail(CancelledError)`"，但语义上是被取消而非出错。父级 compose 会识别 CancelledError 不当 fail。
