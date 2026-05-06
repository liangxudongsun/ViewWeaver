/**
 * 把 prefab 中出现的 __type__ 映射到生成代码里要使用的 TypeScript 类型。
 *
 * - cc.* 内置组件：写死映射表。
 * - 自定义脚本：UUID 形式（32 位 hex 或无 cc. 前缀），v0.1 当作未知，
 *   生成代码时跳过；v0.2 通过 assets/scripts 下的 .ts.meta 反查类名。
 */

export interface ComponentTypeInfo {
  /** 用在 .gen.ts 里的 TS 标识符，例如 `Sprite`、`Label` */
  tsName: string;
  /** 用在 import 里的来源；cc.* 来自 'cc'，自定义脚本来自相对路径 */
  importFrom: "cc" | string;
  /** 是否原生 cc 组件 */
  builtin: boolean;
  /**
   * 该脚本是否使用 `export default class` —— 影响 import 语法：
   *   true  → `import Foo from "..."`
   *   false → `import { Foo } from "..."`（命名导出，默认）
   * 仅对自定义脚本有意义；cc.* 都是命名导出。
   */
  isDefaultExport?: boolean;
  /**
   * `extends X` 中 X 的字面量名（仅对自定义脚本有意义）。
   * 例：`class MyButton extends Button` → `extendsClassName === "Button"`。
   * 用于触发"Button 子类"识别。
   */
  extendsClassName?: string;
  /**
   * 是否为 cc.Button 或其子类。
   *  · cc.Button 内置 → true
   *  · 自定义脚本继承自 Button（含通过 ScriptTypeRegistry 解析出的 `extendsClassName === "Button"`）→ true
   *  · 其它 → undefined / false
   */
  isButton?: boolean;
}

/**
 * Cocos Creator 3.x 内置组件类型映射。
 * 仅列出 UI / 渲染 / 动画 / 物理常用类，不齐全也无需齐全：
 * 未列入的会归类到 unknown，调用方自行决定是否暴露。
 */
const CC_BUILTIN: Record<string, string> = {
  // 基础
  "cc.Node": "Node",
  "cc.Component": "Component",

  // UI Transform / Layout
  "cc.UITransform": "UITransform",
  "cc.Canvas": "Canvas",
  "cc.Widget": "Widget",
  "cc.Layout": "Layout",
  "cc.UIOpacity": "UIOpacity",
  "cc.Mask": "Mask",
  "cc.SafeArea": "SafeArea",
  "cc.PageView": "PageView",
  "cc.PageViewIndicator": "PageViewIndicator",
  "cc.ScrollView": "ScrollView",
  "cc.ScrollBar": "ScrollBar",
  "cc.ProgressBar": "ProgressBar",
  "cc.Slider": "Slider",

  // 渲染
  "cc.Sprite": "Sprite",
  "cc.Label": "Label",
  "cc.LabelOutline": "LabelOutline",
  "cc.LabelShadow": "LabelShadow",
  "cc.RichText": "RichText",
  "cc.Graphics": "Graphics",
  "cc.MeshRenderer": "MeshRenderer",
  "cc.SkinnedMeshRenderer": "SkinnedMeshRenderer",

  // 交互
  "cc.Button": "Button",
  "cc.Toggle": "Toggle",
  "cc.ToggleContainer": "ToggleContainer",
  "cc.EditBox": "EditBox",
  "cc.BlockInputEvents": "BlockInputEvents",

  // 动画
  "cc.Animation": "Animation",
  "cc.AnimationController": "animation.AnimationController",
  // cocos 实际序列化用的是带 namespace 的全名
  "cc.animation.AnimationController": "animation.AnimationController",
  "cc.SkeletalAnimation": "SkeletalAnimation",

  // 摄像机/光照
  "cc.Camera": "Camera",
  "cc.DirectionalLight": "DirectionalLight",
  "cc.PointLight": "PointLight",

  // 音频
  "cc.AudioSource": "AudioSource",

  // 粒子
  "cc.ParticleSystem": "ParticleSystem",
  "cc.ParticleSystem2D": "ParticleSystem2D",

  // 物理
  "cc.RigidBody": "RigidBody",
  "cc.RigidBody2D": "RigidBody2D",
  "cc.Collider": "Collider",
  "cc.Collider2D": "Collider2D",
  "cc.BoxCollider": "BoxCollider",
  "cc.SphereCollider": "SphereCollider",
};

/** sp.Skeleton（Spine）来自单独模块 */
const SP_BUILTIN: Record<string, string> = {
  "sp.Skeleton": "sp.Skeleton",
};

/** dragonBones 等扩展 */
const DRAGONBONES_BUILTIN: Record<string, string> = {
  "dragonBones.ArmatureDisplay": "dragonBones.ArmatureDisplay",
};

/** 32 位 hex 或带斜杠的 UUID 形式（自定义脚本） */
export function isCustomComponent(typeName: string): boolean {
  if (typeName.startsWith("cc.") || typeName.startsWith("sp.") || typeName.startsWith("dragonBones.")) {
    return false;
  }
  // Cocos 自定义脚本通常是 22 位 base64ish 或形如 'd3e97/3QbpOWLKLFyxte0WJ' 的 UUID
  return /^[A-Za-z0-9+/=_-]{16,}$/.test(typeName) || /\//.test(typeName);
}

/**
 * 查询某个 prefab __type__ 对应的 TS 信息。
 * @returns 没找到时返回 undefined（自定义脚本或不识别的内置组件）。
 */
export function lookupComponentType(typeName: string): ComponentTypeInfo | undefined {
  if (typeName in CC_BUILTIN) {
    return {
      tsName: CC_BUILTIN[typeName],
      importFrom: "cc",
      builtin: true,
      isButton: typeName === "cc.Button",
    };
  }
  if (typeName in SP_BUILTIN) {
    return { tsName: SP_BUILTIN[typeName], importFrom: "sp", builtin: true };
  }
  if (typeName in DRAGONBONES_BUILTIN) {
    return {
      tsName: DRAGONBONES_BUILTIN[typeName],
      importFrom: "dragon-bones",
      builtin: true,
    };
  }
  return undefined;
}

/** 暴露所有内置类型用于测试 / 文档 */
export const ALL_BUILTIN: ReadonlyArray<string> = [
  ...Object.keys(CC_BUILTIN),
  ...Object.keys(SP_BUILTIN),
  ...Object.keys(DRAGONBONES_BUILTIN),
];
