# 04 — Roadmap

> Phase 1-7 实施计划、V1 范围内/外、deferred 项目的取舍理由。

## V1 总览

| Phase | 内容 | 状态 | 文件 |
|---|---|---|---|
| 1 | 核心契约 IAnim/Anim + 编排算子 (seq/par/race/loop/forever/delay/call) + 无限动画支持 | ✅ 已完成 | `IAnim.ts` / `Anim.ts` / `compose.ts` |
| 2 | 属性 tween 原语 (`tweenTo / tweenBy / animateValue / animateCurve`) | ⏳ 待开始 | `primitives.ts`（待创建） |
| 3 | 节点级 sugar (`fadeIn / fadeOut / opacityTo / scaleTo / scalePop / moveTo / moveBy / rotateTo / rotateBy / tint`) | ⏳ 待开始 | `builders/node.ts`（待创建） |
| 4 | Cocos 系统包装 (`playClip / trigger / playSpine / playParticle / playParticleGroup`) | ⏳ 待开始 | `builders/system.ts`（待创建） |
| 5 | 遗留工具适配 (`shake / rollingScore / customCurve / moveAlongPath`) | ⏳ 待开始 | `builders/legacy.ts`（待创建） |
| 6 | easing 扩展 (`spring / customBezier / wave / steps / fromRealCurve`) | ⏳ 待开始 | `easing.ts`（待创建） |
| 7 | 单元测试覆盖 | ⏳ 待开始 | `tests/`（待创建） |

预计总规模 ~3000 行 TS（含注释），开发周期 ~5-7 工作日。

---

## Phase 1 — 已完成

`IAnim.ts` / `Anim.ts` / `compose.ts` / `index.ts`，含：

- IAnim / IRepeatableAnim 接口
- Anim 抽象基类（状态机 / Promise 缓存 / cancel 协议 / 节点 destroy 自动取消）
- AnimState 状态机
- CancelledError 类型
- isInfinite 元属性 + 编排算子自动推算
- seq / par / race / loop / forever / delay / call 编排算子
- gracefulStop（loop / forever 礼貌停止）

约 ~36 KB / 1100 行 TS。

---

## Phase 2 — 属性 tween 原语

### 目标

提供 cc.tween 的 IAnim 包装，作为后续所有节点级原语的共同地基。

```typescript
// 通用属性 tween
function tweenTo<T extends object>(
  target: T,
  props: Partial<T>,
  duration: number,
  opts?: TweenOptions,
): IAnim;

// 相对量 tween
function tweenBy<T extends object>(
  target: T,
  deltaProps: Partial<T>,
  duration: number,
  opts?: TweenOptions,
): IAnim;

// 标量 tween（按帧 onUpdate 拿插值，常用于 Score 滚动等业务）
function animateValue(
  from: number,
  to: number,
  duration: number,
  onUpdate: (v: number) => void,
  opts?: TweenOptions,
): IAnim;

// 跟 RealCurve 资源（Cocos 曲线编辑器输出的 .curve 资产）
function animateCurve(
  curve: RealCurve,
  duration: number,
  onUpdate: (v: number) => void,
  opts?: { tStart?: number; tEnd?: number },
): IAnim;
```

### 设计要点

- 所有原语在 onStart 自动调 `_autoCancelOnDestroy(target)`（如果 target 是 Node 或带 node 的 Component）；
- onCancel 调 `Tween.stopAllByTarget(target)`，干净停止；
- TweenOptions 含 easing、onUpdate（可选）、onComplete（不需要——业务用 await）；
- easing 接受字符串（cc.tween 内置）或函数（Phase 6 扩展）。

---

## Phase 3 — 节点级 sugar

### 目标

最常见的节点动画一行写完。所有 sugar 都建在 Phase 2 原语上。

```typescript
fadeIn(node, dur)              // UIOpacity 0 → 255
fadeOut(node, dur)             // UIOpacity ? → 0
opacityTo(node, value, dur)    // UIOpacity ? → value

scaleTo(node, scale, dur)      // node.scale → scale (Vec3 或数字)
scalePop(node, peak, dur)      // 1 → peak → 1（弹跳反馈）

moveTo(node, pos, dur)         // node.position → pos
moveBy(node, delta, dur)       // node.position 偏移 delta

rotateTo(node, angle, dur)     // node.angle → angle
rotateBy(node, delta, dur)     // node.angle 偏移 delta

tint(spriteOrLabel, color, dur)  // color → color
```

### 接口约定

所有 sugar 接受可选的 `TweenOptions`（与 Phase 2 一致）。返回 IAnim。

---

## Phase 4 — Cocos 系统包装

### 目标

把 Cocos 内置的"非 cc.tween 类"动画系统也归一化到 IAnim 下。

```typescript
// cc.Animation 组件播片段
playClip(node: Node, clipName: string, opts?: ClipOptions): IAnim;

// cc.AnimationController（动画状态机）触发 trigger
trigger(node: Node, triggerName: string, waitFor?: number): IAnim;

// sp.Skeleton 播 spine 动作
playSpine(skel: sp.Skeleton, animName: string, opts?: SpineOptions): IAnim;
// 含 loop 标志；loop=true 时返回的 IAnim isInfinite=true

// cc.ParticleSystem 播粒子
playParticle(ps: ParticleSystem | Node, opts?: ParticleOptions): IAnim;
// 含 autoStop 标志；持续发射型粒子在 cancel 时调 stopEmitting

// 多个粒子组（一组节点同时播）
playParticleGroup(nodes: Node[], opts?: ParticleOptions): IAnim;
```

### 关键设计点

- **playClip**：用 `cc.Animation` 组件 + `Animation.EventType.FINISHED` 监听等待完成；fallback 用 clip duration 计时。
- **trigger**：写 trigger，再用一个 `setValue + waitForFinish` 模式；这是项目里大量 character 动画的当前用法。
- **playSpine**：用 `setAnimation` + `setCompleteListener`；loop=true 时不监听完成（无限）。
- **playParticle**：用 `play()` + `WorldFinish` 事件或 timer 兜底；连续发射型粒子的 cancel 走 `stopEmitting()` 不打断已发出的粒子。

---

## Phase 5 — 遗留工具适配

### 目标

把项目里已有的、风格不一致的动画工具收编进 IAnim。

```typescript
shake(node: Node, dur: number, strength: number, opts?): IAnim;
// 适配 ShakeTool；用 cc 调度替代 setTimeout

rollingScore(label: Label, from: number, to: number, dur: number): IAnim;
// 适配 RollingScore；其实就是 animateValue 的特化

customCurve(node: Node, curveAsset: RealCurve, dur: number): IAnim;
// 适配 CustomizeTween 的核心逻辑

moveAlongPath(node: Node, points: Vec3[], dur: number): IAnim;
// 适配 BezierCurve 路径计算
```

### 兼容性

旧组件（`ShakeTool / RollingScore / CustomizeTween / BezierCurve`）保留可用，不强制下线。新代码用 IAnim 适配版即可享受统一的 cancel / compose 能力。

---

## Phase 6 — easing 扩展

### 目标

补齐 cc.tween 内置 easing 不够用的高级缓动。

```typescript
type Easing = string | ((t: number) => number);

const easing = {
  // cc.tween 已有的 (linear / sineIn / sineOut / sineInOut / quadIn / ... / bounceIn / ...)
  // 直接用字符串
  
  // 新加的：
  spring(stiffness: number, damping: number): Easing;
  customBezier(p1x: number, p1y: number, p2x: number, p2y: number): Easing;
  wave(freq: number, amp: number): Easing;
  steps(n: number): Easing;
  fromRealCurve(curve: RealCurve): Easing;
};
```

`fromRealCurve` 是亮点：让美术在 Cocos 曲线编辑器里画的曲线直接当 easing 用，不用每次写代码。

---

## Phase 7 — 单元测试覆盖

### 目标

核心 invariant 必须有自动化测试，避免后续 phase 改动破坏。

### 用什么测

**问题**：cc.tween / cc.Animation / sp.Skeleton 都需要 Cocos 运行时，普通 jest 跑不起来。

**方案**（讨论中）：

- 选项 A：编写一个 mock cc 模块，让 jest/vitest 可以跑；只测 IAnim/Anim/compose 这一层（不测真正的 tween）。
- 选项 B：在 Cocos 里跑测试组件，输出测试结果到 console。
- 选项 C：把 IAnim/Anim/compose 抽到一个不依赖 cc 的子目录，纯逻辑层独立测试。

倾向选项 A：成本最低，能覆盖 90% 的 invariant。Phase 1 的 compose 算子、状态机、cancel 协议都是纯逻辑，mock 一下 cc.Tween 就能测。

### 待覆盖项

- `Anim` 基类的状态机转换（idle → running → completed/cancelled，回 idle）
- `play()` 幂等：running 多调返回同一 Promise；completed/cancelled 的边界行为
- `cancel()` 协议：CancelledError reject、onCancel 调用顺序
- `seq` 串行执行顺序、cancel 传播、子 anim 复用 reset
- `par` all-settle 语义、单 child fail 取消其他、CancelledError 不当 fail
- `race` first-settle、其他自动 cancel、所有 child cancel 时整体 fail
- `loop` 计数、reset、`gracefulStop` 当前轮跑完后 complete
- `forever` 永远不 complete、gracefulStop 路径、cancel 路径
- `isInfinite` 推算正确性
- console.warn 路径（seq 非末尾 inf / loop inf child / forever inf child）

---

## 不在 V1 范围内的项目（已显式排除）

### ❌ GameReel god class 重构

**为什么排除**：GameReel 是项目的核心 reel 控制器，~3000 行，混合了状态机 + 动画 + 节点操作 + 业务逻辑。重构它是一个独立的项目（用 IAnim 做工具），不是 IAnim 的一部分。

**用户原话**："GameReel 动画不用装入。我们只保证最小动画单元我们都支持就可以。我們的設計目標就是用于重構舊動畫"

**意思**：IAnim V1 提供"足够丰富的最小动画单元"，让任何旧动画代码都能一对一翻译过来。GameReel 是消费者，不是 IAnim 的一部分。

### ❌ Timeline 可视化编辑器

**初步设想**：在 Cocos 编辑器里画一个时间轴，业务侧拖块组合 anim，导出 JSON 给运行时执行。

**为什么不做**：
- 过早投入：当前没有任何客户实际要求；
- 体量大：Cocos Editor 扩展 + 自定义 Inspector + 序列化格式 + 反序列化解释器，至少 2 周；
- ROI 低：项目里需要复杂动画的地方不多（Spine 做了一部分），代码描述足够。

**未来重启条件**：当代码描述的动画超过 50 处且复杂度持续上升，再考虑 V3 引入。

### ❌ 运行时 Anim Monitor 编辑器扩展

**初步设想**：游戏里实时显示当前正在跑的 anim 树（哪个 seq 跑到第几个 child、par 哪几个还没 settle、cancel 链路追踪）。

**为什么不做**：
- 调试方便但不影响功能；
- 实现需要 IAnim 实例订阅、UI overlay、可能要侵入 Anim 基类加更多生命周期 hook；
- V1 阶段先用 console.warn / console.log + breakpoint 调试足够。

**未来重启条件**：当 anim 树规模上 100+ 节点、肉眼调试困难时，再考虑 V1.5 加进来。

### ❌ waitFor / waitUntil

**说明**：把外部 Promise 或谓词包成 anim。

```typescript
waitFor(p: Promise<unknown>): IAnim;
waitUntil(predicate: () => boolean, pollHz?: number): IAnim;
```

**为什么不做（暂时）**：`call(async () => p)` 已经覆盖了 waitFor 的常用场景；waitUntil 涉及轮询频率/事件订阅的设计选择，暂时业务上没强需求。

**未来重启**：业务侧明确要求时加。

---

## 后续版本（V2+ 设想）

### V1.5 — quality of life

- 基于 V1 反馈打补丁
- 可能加入：`waitFor` / `waitUntil`
- 单元测试更全
- README / cookbook 完善

### V2 — 整合

- 与 IView 契约合作：所有 view 自动暴露 `playEnter / playExit` 接口（IAnimatedView）
- Presenter 层用 IAnim 重构 fadeIn/fadeOut（详见 [05-context.md](./05-context.md)）
- 旧 ButtonScale / TweenOpacity 等组件迁移到 IAnim

### V3 — 工具链

- Anim Monitor 编辑器扩展
- 可视化 Timeline 编辑器（如果届时业务上有强需求）
- 自动性能 profile（"哪个 anim 最耗 CPU 时间"）

---

## 提交粒度

每个 phase 落地后做一次 submodule 提交。提交信息格式：

```
anim: phase N — <主题>

- 实现要点 1
- 实现要点 2
- 测试覆盖
```

外层 repo 的 submodule 指针更新单独一个 commit，与其他变更不混。
