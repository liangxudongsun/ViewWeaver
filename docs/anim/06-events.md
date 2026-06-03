# 06 — Timeline Events

> **compose 管起止，event 管过程。**
>
> `seq` / `par` / `delay` 描述宏观时间结构；动画 **play() 进行过程中** 由物理/逻辑驱动的瞬时时刻，用 **命名 timeline event** 表达，不靠嵌套闭包或散落 optional callback。

## 问题

只用 IAnim 起止编排时：

- 每个 actor 各自的 marker 无法事先写成 `delay(fixedMs)`；
- handler 埋在 `call(async () => { const onX = ... })` 闭包里，grep 找不到处理点；
- motion 层与演出层通过匿名 `(node, idx) => void` 耦合。

**代码结构（调用栈）≠ 时序结构（交叉发生的 marker）。** event 层补这一缺口。

## 三层分工

| 层 | 职责 | 典型 API |
|---|---|---|
| **compose** | 阶段串联 / 并行 | `seq`, `par`, `race` |
| **IAnim play()** | 一段 motion 的生命周期 | `play()` / `cancel()` |
| **timeline event** | play 内部的命名时刻 | `emitAnimEvent(scope, def, payload)` |

## 核心类型（common/anim）

```typescript
import {
  defineAnimEvent,
  bindAnimEventHandlersFromDefs,
  emitAnimEvent,
  resolveAnimEvents,
  animEventSpec,
  eventsForAnim,
} from "common/anim";

// 1. 业务域：defs 对象（payload 类型绑在 def 上）
export const WheelboardMotionEvents = {
  symbolDrop: defineAnimEvent<{ node: Node; boardIndex: number }>(
    "wheelboard.motion.symbolDrop",
  ),
  motionComplete: defineAnimEvent<{ nodes: Node[] }>("wheelboard.motion.complete"),
} as const;

// 2. animId → emit 列表
const SPECS = [
  animEventSpec("wheelboard.land", [
    WheelboardMotionEvents.symbolDrop,
    WheelboardMotionEvents.motionComplete,
  ]),
];

// 3. 编排层唯一 handler 注册点（key 用 defs 字段名，payload 全推断）
const events = bindAnimEventHandlersFromDefs(WheelboardMotionEvents, {
  symbolDrop: ({ node, boardIndex }) => { /* 拖尾 */ },
  motionComplete: ({ nodes }) => { /* 同步节点 */ },
});

// 4. 传入 build 上下文
view.buildAnim(animId, { board, events });

// 5. motion 层 emit
emitAnimEvent(resolveAnimEvents(ctx), WheelboardMotionEvents.symbolDrop, { node, boardIndex });
```

## 与 IAnimBuildContext 的关系

```typescript
interface IAnimBuildContext {
  readonly fast?: boolean;
  readonly events?: AnimEventScope;  // handler 通道
}
```

- **Data**（board、flags、spinMode）仍放业务 extends 的 context 字段；
- **Handler** 统一走 `ctx.events`，不在 context 上挂 `onSymbolDrop?` 等匿名 callback。

## 发现 handler 的标准路径

```text
AnimId
  → AnimEventSpec 表（eventsForAnim / WHEELBOARD_MOTION_EVENT_SPECS）
  → grep defineAnimEvent / WheelboardMotionEvents
  → bindAnimEventHandlersFromDefs / buildXxxMotionHandlers
```

开发期：`warnIfUndeclaredAnimEvent(specs, animId, def.id)` — emit 了 spec 未声明的 event 时 console.warn。

## 与 compose 的边界

| 用 compose | 用 event |
|---|---|
| teaser → throw → land 整段先后 | land **内部** 每颗 symbol 落地 |
| 已知秒数的 delay | Reel 物理驱动的时刻 |
| 宏观阶段切换 | 微观 side-effect 注入 |

不要把「每 symbol 一个 seq 子节点」替代 event — 编排树会爆炸，stagger 仍要在 motion 内算。

## 业务域接入 checklist

1. `*AnimEvents.ts`：`defineAnimEvent` + `animEventSpec` 表；
2. `*MotionHandlers.ts`：`bindAnimEventHandlersFromDefs` 唯一实现；
3. catalog 只 `events: buildXxxMotionHandlers(...)` + `buildAnim`；
4. resolver 只 `emitAnimEvent` / 域封装 `emitXxxMotionEvent`。

## 决策

见 [99-decisions.md § Decision-12](./99-decisions.md#decision-12-timeline-event-走-animeventscope-而非-context-散 callback)。
