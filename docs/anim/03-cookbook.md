# 03 — Cookbook（常见模式与迁移示例）

> 本文给出项目里高频出现的动画模式，以及"旧 cc.tween 代码 → IAnim"的迁移对照。
>
> Phase 2-5 的原语（`fadeIn / scaleTo / playSpine / shake / ...`）此时尚未实现，本文示例假设它们已经就位 —— 一旦后续 phase 落地，这些模式即可直接使用。

## 目录

- [进场 / 退场](#进场--退场)
- [反馈：弹跳](#反馈弹跳)
- [反馈：闪烁提示](#反馈闪烁提示)
- [加载：spinner](#加载spinner)
- [背景循环 + 前景动作](#背景循环--前景动作)
- [等数据 + 超时](#等数据--超时)
- [按钮 hover / 点击反馈](#按钮-hover--点击反馈)
- [SlotsWin 庆祝序列](#slotswin-庆祝序列)
- [迁移示例](#迁移示例)

---

## 进场 / 退场

### 旧写法

```typescript
// 旧：cc.tween 链式 + Utils.delay 做"分阶段"
async playEnter(node: Node) {
  const opacity = node.getComponent(UIOpacity)!;
  cc.tween(opacity).to(0.2, { opacity: 255 }).start();
  cc.tween(node).to(0.3, { scale: v3(1, 1, 1) }).start();
  await Utils.delay(300);
  audio.play("ui_enter");
}
```

### IAnim 写法

```typescript
import { seq, par, call } from "common/anim";

playEnter(node: Node) {
  return seq(
    par(
      fadeIn(node, 0.2),                       // opacity 0 → 255
      scaleTo(node, v3(1, 1, 1), 0.3),         // scale 弹回 1
    ),
    call(() => audio.play("ui_enter")),
  );
}

// 调用方
await this.playEnter(panel).play();
```

### 退场

```typescript
playExit(node: Node) {
  return par(
    fadeOut(node, 0.2),
    scaleTo(node, v3(0.8, 0.8, 1), 0.2),
  );
}
```

---

## 反馈：弹跳

### 单次弹跳（按钮按下反馈）

```typescript
// scalePop 是 phase 3 的预设：scale → target → 1.0
scalePop(button.node, 1.2, 0.15)
```

等价的展开形式：

```typescript
seq(
  scaleTo(button.node, v3(1.2, 1.2, 1), 0.075),
  scaleTo(button.node, v3(1.0, 1.0, 1), 0.075),
)
```

### 重复弹三下

```typescript
loop(3, scalePop(node, 1.2, 0.15))
```

---

## 反馈：闪烁提示

### 让玩家注意某个按钮

```typescript
const blink = forever(seq(
  fadeOut(button.node, 0.3),
  fadeIn(button.node, 0.3),
));
blink.play();

// 玩家点了或玩家忽略：
button.node.on("click", () => blink.gracefulStop());  // 闪完一轮停在"亮起"
```

### 闪 5 次后停

```typescript
await loop(5, seq(
  fadeOut(node, 0.3),
  fadeIn(node, 0.3),
)).play();
```

---

## 加载：spinner

### 转到数据回来

```typescript
const spin = forever(rotateBy(spinnerNode, 360, 1.0));   // 1 秒转一圈
spin.play();

const data = await fetchData();

spin.gracefulStop();   // 转完整圈停在原始角度（漂亮）
```

### 转到数据回来 OR 超时

```typescript
const spin = forever(rotateBy(spinnerNode, 360, 1.0));
spin.play();

try {
  await race(
    waitFor(fetchData()),    // wrapping promise (phase X)
    delay(10),               // 10 秒超时
  ).play();
  spin.gracefulStop();
} catch (e) {
  spin.cancel();
  // ...
}
```

---

## 背景循环 + 前景动作

### Pattern：race(infinite, finite)

```typescript
// idle 时角色一直呼吸；进入 attack 状态时 attack 动画完成后 idle 也停
await race(
  forever(idleBreath(character)),
  seq(
    attackWindup(character),
    attackStrike(character),
    attackRecover(character),
  ),
).play();

// race 完成时 idleBreath 自动被 cancel
// 进入下一个 state 前 character 的 transform 已经被 attack 的 settle 决定
```

### 不能写成 par

```typescript
// 错误：par 等所有 settle，forever 永远不 settle
await par(
  forever(idleBreath(character)),
  seq(attackWindup, attackStrike, attackRecover),
).play();
// → 永远 await，卡死
// → 而且会 console.warn: par 整体 isInfinite=true
```

---

## 等数据 + 超时

```typescript
// 数据先到走数据流程，10 秒先到走超时流程
const result = await race(
  call(async () => { return await fetchData(); }),    // 异步 call
  delay(10),
).play();
// 注意：race 的 Promise 是 void，要拿数据请把 fetch 结果放到外部变量
```

更工程的写法（保留数据通道）：

```typescript
let data: Data | undefined;
let timedOut = false;

await race(
  call(async () => { data = await fetchData(); }),
  seq(delay(10), call(() => { timedOut = true; })),
).play();

if (timedOut) {
  // ...
}
```

---

## 按钮 hover / 点击反馈

### 旧 ButtonScale.ts 模式

```typescript
// 当前项目的 ButtonScale 组件大致：
@ccclass
class ButtonScale extends Component {
  onTouchStart() {
    cc.tween(this.node).to(0.1, { scale: v3(0.9, 0.9, 1) }).start();
  }
  onTouchEnd() {
    cc.tween(this.node).to(0.1, { scale: v3(1.0, 1.0, 1) }).start();
  }
}
```

### IAnim 写法

```typescript
@ccclass
class ButtonScale extends Component {
  private _press?: IAnim;
  private _release?: IAnim;

  onTouchStart() {
    this._release?.cancel();
    this._press = scaleTo(this.node, v3(0.9, 0.9, 1), 0.1);
    this._press.play();
  }

  onTouchEnd() {
    this._press?.cancel();
    this._release = scaleTo(this.node, v3(1.0, 1.0, 1), 0.1);
    this._release.play();
  }

  onDestroy() {
    // _autoCancelOnDestroy 会自动处理；这里写出来仅作示例
    this._press?.cancel();
    this._release?.cancel();
  }
}
```

---

## SlotsWin 庆祝序列

```typescript
async playWinCelebration(payload: WinPayload) {
  await seq(
    // 1. 数字滚动 + 粒子同时
    par(
      rollingScore(scoreLabel, 0, payload.amount, 1.5),
      playParticle(coinBurst, { autoStop: false }),
    ),

    // 2. 大赢光圈
    race(
      forever(playClip(haloAnim, "halo_loop")),
      delay(payload.bigWin ? 3.0 : 1.5),
    ),

    // 3. 音效定点
    call(() => audio.play("win_final")),

    // 4. 关闭粒子（gracefulStop 让最后一波粒子飞完）
    call(() => coinBurst.stopEmitting()),
  ).play();
}
```

---

## 迁移示例

### 示例 1：fadeIn 的旧实现

```typescript
// 旧
const opacity = node.getComponent(UIOpacity)!;
opacity.opacity = 0;
cc.tween(opacity)
  .to(0.3, { opacity: 255 })
  .call(() => onComplete?.())
  .start();
```

```typescript
// IAnim
await fadeIn(node, 0.3).play();
onComplete?.();
```

### 示例 2：分阶段动画

```typescript
// 旧
async playStaged(node: Node) {
  await new Promise(r => cc.tween(node).to(0.2, { ... }).call(() => r()).start());
  audio.play("step1");
  await Utils.delay(100);
  await new Promise(r => cc.tween(node).to(0.3, { ... }).call(() => r()).start());
  audio.play("step2");
}
```

```typescript
// IAnim
playStaged(node: Node) {
  return seq(
    moveTo(node, v3(100, 0, 0), 0.2),
    call(() => audio.play("step1")),
    delay(0.1),
    moveTo(node, v3(200, 50, 0), 0.3),
    call(() => audio.play("step2")),
  );
}

await this.playStaged(node).play();
```

### 示例 3：可中断的循环动画

```typescript
// 旧
private _shouldStop = false;
private async loopAnim() {
  while (!this._shouldStop) {
    await new Promise(r => cc.tween(node).to(0.5, { ... }).call(() => r()).start());
    await new Promise(r => cc.tween(node).to(0.5, { ... }).call(() => r()).start());
  }
}
public stopLoop() { this._shouldStop = true; }
// 注意 stopLoop 不能立即生效，得等当前 tween 跑完
```

```typescript
// IAnim
private _loop?: IRepeatableAnim;
public startLoop() {
  this._loop = forever(seq(
    scaleTo(node, 1.05, 0.5),
    scaleTo(node, 1.0, 0.5),
  ));
  this._loop.play();
}
public stopLoop() {
  this._loop?.gracefulStop();   // 当前轮跑完再停（漂亮）
  // 或 this._loop?.cancel();   // 立即打断
}
```

### 示例 4：脏 tween 防御

```typescript
// 旧
private _activeTween?: cc.Tween<Node>;
public playEffect(node: Node) {
  this._activeTween = cc.tween(node).to(2.0, { ... });
  this._activeTween.start();
}
// node destroy 时 _activeTween 还在跑，每帧改 destroy 节点的 position
// 必须在 onDestroy 里手动 stop
```

```typescript
// IAnim
private _active?: IAnim;
public playEffect(node: Node) {
  this._active = moveTo(node, ..., 2.0);
  this._active.play();
  // node destroy 时 _autoCancelOnDestroy 自动收尾，零脏 tween
}
```

---

## 反模式（不要这样写）

### 反模式 1：await 一个 infinite anim

```typescript
// 错
await forever(idleBob).play();   // 卡死
```

正确：

```typescript
const idle = forever(idleBob);
idle.play();
// ... 别 await，留 handle
idle.cancel();    // 或 gracefulStop()
```

### 反模式 2：同一个 anim 实例塞进两个 compose

```typescript
// 错
const f = fadeIn(node, 0.3);
par(f, f);   // 两个并行各自 reset 对方的 state
```

正确：

```typescript
par(fadeIn(node, 0.3), fadeIn(node2, 0.3));   // 两个独立实例
```

### 反模式 3：onCancel 里 await

```typescript
class MyAnim extends Anim {
  protected async onCancel() {
    await someCleanup();   // ✗ cancel 不会"立即生效"
  }
}
```

正确：让清理同步完成，或者把异步清理放进单独的"finalizer" anim 里串到 seq 末尾。

### 反模式 4：用 call 当无限副作用

```typescript
// 错
seq(call(() => setInterval(() => doStuff(), 100)));
// call 立即完成，setInterval 永久泄漏
```

正确：写一个自定义 IAnim 或用 `forever(call(doStuff))` + 业务自己的节流。
