# anim — 项目动画系统设计文档

> **代码位置**：本 anim 库的运行时代码位于 `assets/scripts/common/anim/`（即 project-l-common submodule），原因是它必须放在 Cocos 编译器扫描的 runtime 路径下被业务脚本 `import`。
>
> **本份 docs 是 framework 视角的主拷贝**，与代码同仓内的 `assets/scripts/common/anim/docs/` 互为镜像。设计讨论以这里为单一真源，业务侧也可以就地查阅紧贴代码的拷贝。两边内容应当保持同步——后续 phase 落地时 docs 更新会同时推到两个仓。

---

> **目标**：用一套统一的 IAnim 抽象，覆盖项目里所有"会随时间改变状态"的动画形态，让业务侧从四散的 `cc.tween + Utils.delay + setTimeout + cc.AnimationController.setValue + sp.Skeleton.setAnimation + ParticleSystem.play + ShakeTool + RollingScore + ...` 收敛为一种 API：

```typescript
const anim = seq(
  fadeIn(node, 0.3),
  par(scaleTo(node, 1.0, 0.2), playSpine(skel, "appear")),
  delay(0.1),
  call(() => audio.play("entered")),
);
await anim.play();    // 一行串完整套进场动画
```

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-contract.md](./01-contract.md) | `IAnim` / `IRepeatableAnim` 接口、`AnimState` 状态机、`CancelledError`、自定义 anim 继承 `Anim` 基类的方法、节点 destroy 自动取消 |
| [02-compose.md](./02-compose.md) | `seq / par / race / loop / forever / delay / call` 各自语义、有限/无限动画与编排算子的相互作用、`gracefulStop` 礼貌停止语义、取消传播规则 |
| [03-cookbook.md](./03-cookbook.md) | 常见动画模式（进场/退场、弹跳反馈、加载圈、背景+前景、等数据+超时）、旧代码迁移示例 |
| [04-roadmap.md](./04-roadmap.md) | Phase 1-7 实施计划、V1 范围内/外、为什么不做 GameReel / Timeline 编辑器 / 运行时 Monitor |
| [05-context.md](./05-context.md) | 为什么做这个（项目现状扫描）、与 IView 契约的关系、View/Presenter 加载流程、Widget vs 动画冲突、fadeIn/fadeOut 拆分、async-transparent API 长期愿景 |
| [99-decisions.md](./99-decisions.md) | 决策日志（cc.tween vs GSAP / 不做 prefab 缓存 / IRepeatableAnim 而非接口分裂 / gracefulStop vs cancel / GameReel 出 V1 范围 / …） |

---

## 设计哲学

### 1. 一切动画都是同一个东西

不论是单个属性 tween、Spine 动作、粒子播放、计时器还是函数副作用，运行时都满足同一个最小协议：

- 有"开始 / 结束"两个时间点；
- 可以被中断；
- 可以被组合成更大的时间结构。

这就是 `IAnim`：

```typescript
interface IAnim {
  readonly state: "idle" | "running" | "completed" | "cancelled";
  readonly isInfinite: boolean;
  play(): Promise<void>;
  cancel(): void;
  reset(): void;
  replay(): Promise<void>;
}
```

### 2. 编排是一等公民

业务侧不需要写 `await Utils.delay(300); cc.tween(node).to(...)`，而是用专用算子：

```typescript
seq(a, b, c)          // 串行
par(a, b, c)          // 并行（等所有）
race(a, b, c)         // 赛跑（等第一个）
loop(n, a)            // 循环 n 次
forever(a)            // 无限循环
delay(seconds)        // 延时
call(fn)              // 函数副作用包装
```

它们都返回 `IAnim`，可以再被组合。整棵 anim 树共享一个 `cancel()`。

### 3. 取消是默认能力，不是 hack

`Tween.stopAllByTarget`、`clearTimeout` 这些零散的取消调用全部被 IAnim 内部接管。业务只需要：

```typescript
const h = anim.play();
// ... 某个时机
anim.cancel();
```

加上节点级自动取消：动画作用的节点一旦 destroy，绑在它上面的 anim 自动 cancel —— 杜绝"prefab 已销毁，tween 还在改属性"这种脏数据。

### 4. 有限动画和无限动画在一个体系内

很多动画系统把 fadeIn/scaleTo（有限）和 spinner/idleBob（无限）当成两类不同的东西。我们用一个 `isInfinite` 元属性 + `IRepeatableAnim.gracefulStop()` 把它们统一在 IAnim 下：

```typescript
const spin = forever(rotateBy(node, 360, 1.0));
spin.play();              // 不要 await
const data = await fetch();
spin.gracefulStop();      // 转完整圈停在 0° 位置（漂亮）
//   vs spin.cancel();    // 卡在某个角度（难看）
```

详见 [02-compose.md § 无限动画](./02-compose.md#无限动画)。

### 5. 显式优于隐式，但默认要好用

- `play()` 是**幂等**的：running 中重复 play 拿到同一个 Promise；completed 后 play 立即 resolve；cancelled 后 play reject —— 让业务"想 await 多少次都行"。
- `replay()` = reset + play，提供"重新跑一次"的语法糖（按钮反复点击场景）。
- 节点 destroy 自动 cancel 是**默认开**的（业务不操心）。
- `seq/par/race` 自动 `reset` 子 anim（防御复用过的实例污染）。

---

## Quick Start

```typescript
import {
  fadeIn, fadeOut, scalePop, moveBy,           // Phase 3 sugar 还没实现
  playSpine, playClip, playParticle,            // Phase 4 系统包装还没实现
  seq, par, race, loop, forever, delay, call,   // ✅ Phase 1 已可用
  IAnim, IRepeatableAnim, CancelledError,       // ✅ Phase 1 已可用
} from "common/anim";

// 例 1：进场动画（Phase 3 后可用）
const enter = seq(
  fadeIn(panel, 0.2),
  par(
    scaleTo(panel, 1.0, 0.3),
    playSpine(skeleton, "appear"),
  ),
  call(() => audio.play("ui_enter")),
);
await enter.play();

// 例 2：现在已经能写的（Phase 1 提供）
const sequence = seq(
  delay(0.5),
  call(() => console.log("step 1")),
  delay(0.3),
  call(async () => {
    await someAsyncOperation();
    console.log("step 2 done");
  }),
);
await sequence.play();

// 例 3：spinner 转到数据回来
const spin = forever(/* 转动单元，phase 3 后可用 */);
spin.play();
const data = await fetchData();
spin.gracefulStop();    // 转完整圈再停
```

---

## V1 范围（当前）

✅ **Phase 1**（已完成）：核心契约、状态机、编排算子、无限动画支持
⏳ **Phase 2**：属性 tween 原语 (`tweenTo / tweenBy / animateValue / animateCurve`)
⏳ **Phase 3**：节点级 sugar (`fadeIn/Out / opacityTo / scaleTo / scalePop / moveTo/By / rotateTo/By / tint`)
⏳ **Phase 4**：Cocos 系统包装 (`playClip / trigger / playSpine / playParticle / playParticleGroup`)
⏳ **Phase 5**：遗留工具适配 (`shake / rollingScore / customCurve / moveAlongPath`)
⏳ **Phase 6**：easing 扩展 (`spring / customBezier / wave / steps / fromRealCurve`)
⏳ **Phase 7**：单元测试覆盖

❌ **不做**：GameReel god class 重构、Timeline 可视化编辑器、运行时 Monitor 扩展

详见 [04-roadmap.md](./04-roadmap.md)。
