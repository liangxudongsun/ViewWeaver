/**
 * Cocos Editor 扩展入口（v0.2 才会真正实现）。
 *
 * v0.1 阶段：CLI 已可独立使用，扩展面板暂未启用。
 * 这里只占位，让 package.json 的 main 字段不至于失效。
 */

export function load(): void {
  // intentionally empty in v0.1
}

export function unload(): void {
  // intentionally empty
}

export const methods = {
  /** 占位：右键菜单触发的 Bind Editor 面板 */
  openBindEditor(): void {
    console.warn("[genbot] openBindEditor: panel not implemented in v0.1, please use the CLI.");
  },
  /** 占位：批量重新生成 */
  regenerateAll(): void {
    console.warn("[genbot] regenerateAll: not implemented in v0.1, please use the CLI.");
  },
};
