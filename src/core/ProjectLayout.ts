/**
 * ViewWeaver 输出布局规则
 *
 * 约定：
 * - 所有生成产物固定放在 <project>/assets/scripts/views/ 下
 * - 每个 prefab 一个子目录：assets/scripts/views/<prefabName>/
 *   - <prefabName>.gen.ts     : 自动生成的 PrefabView 代码
 *   - <prefabName>.bind.json  : 节点契约配置
 *   - <prefabName>.view.ts    : 开发者承基类（仅首次生成）
 * - 同名 prefab 冲突：以 prefab 文件 UUID 区分（v0.2 暂不支持，v0.3 加冲突检测）
 *
 * 所有 prefab 不区分原始路径，扁平化在 views/ 下，避免：
 *   - prefab 移动后还要追着改生成代码路径
 *   - 不同 bundle 的 prefab 一会儿命中 ab/ 一会儿命中 ui/
 *   - 跨 bundle 引用复杂的相对路径 import
 *
 * 路径映射靠 __registry.json 维护（详见 RegistryManager）。
 *
 * 兼容：旧布局 assets/scripts/_genbot/ 由 RegistryManager 读取并迁移。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 生成根目录相对项目根：assets/scripts/views */
export const VIEWWEAVER_ROOT_REL = "assets/scripts/views";

/** @deprecated 旧布局；仅供迁移检测 */
export const LEGACY_GENBOT_ROOT_REL = "assets/scripts/_genbot";

/** @deprecated use VIEWWEAVER_ROOT_REL */
export const GENBOT_ROOT_REL = VIEWWEAVER_ROOT_REL;

/** registry 文件相对项目根 */
export const REGISTRY_REL = "assets/scripts/views/__registry.json";

/** 旧 registry 相对路径 */
export const LEGACY_REGISTRY_REL = "assets/scripts/_genbot/__registry.json";

/** 单个 prefab 的输出目录约定 */
export interface PrefabOutputLayout {
  /** prefab 名（不含扩展名） */
  prefabName: string;
  /** 输出绝对目录：<project>/assets/scripts/views/<prefabName> */
  outDir: string;
  /** .gen.ts 绝对路径 */
  genTsPath: string;
  /** .bind.json 绝对路径 */
  bindJsonPath: string;
  /** .view.ts 绝对路径（开发者可改、只首次生成） */
  viewTsPath: string;
  /** 相对项目根的 .gen.ts 路径（用于 registry） */
  genTsRel: string;
  /** 相对项目根的 .bind.json 路径（用于 registry） */
  bindJsonRel: string;
  /** 相对项目根的 .view.ts 路径（用于 registry） */
  viewTsRel: string;
}

export interface LayoutOptions {
  /** 项目根目录（含 assets/）的绝对路径 */
  projectRoot: string;
  /** prefab 名（不含扩展名） */
  prefabName: string;
}

/** 计算 prefab 在 views/ 下的输出布局（所有路径归一为绝对路径 + 相对路径双份） */
export function resolvePrefabLayout(opts: LayoutOptions): PrefabOutputLayout {
  if (!path.isAbsolute(opts.projectRoot)) {
    throw new Error(`projectRoot must be absolute: ${opts.projectRoot}`);
  }
  const safeName = sanitizePrefabName(opts.prefabName);
  const outDir = path.join(opts.projectRoot, VIEWWEAVER_ROOT_REL, safeName);
  const genTsPath = path.join(outDir, `${safeName}.gen.ts`);
  const bindJsonPath = path.join(outDir, `${safeName}.bind.json`);
  const viewTsPath = path.join(outDir, `${safeName}.view.ts`);
  return {
    prefabName: safeName,
    outDir,
    genTsPath,
    bindJsonPath,
    viewTsPath,
    genTsRel: toRel(opts.projectRoot, genTsPath),
    bindJsonRel: toRel(opts.projectRoot, bindJsonPath),
    viewTsRel: toRel(opts.projectRoot, viewTsPath),
  };
}

/** registry 文件绝对路径（新布局） */
export function resolveRegistryPath(projectRoot: string): string {
  if (!path.isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be absolute: ${projectRoot}`);
  }
  return path.join(projectRoot, REGISTRY_REL);
}

/** 旧 registry 绝对路径 */
export function resolveLegacyRegistryPath(projectRoot: string): string {
  if (!path.isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be absolute: ${projectRoot}`);
  }
  return path.join(projectRoot, LEGACY_REGISTRY_REL);
}

/** 把绝对路径转换成相对项目根的路径（用 / 分隔，便于 JSON 持久化跨平台） */
export function toRel(projectRoot: string, absPath: string): string {
  return path.relative(projectRoot, absPath).replace(/\\/g, "/");
}

/** 把相对项目根路径还原为绝对路径 */
export function toAbs(projectRoot: string, relPath: string): string {
  return path.join(projectRoot, relPath);
}

/**
 * 检测 prefab 是否能合法落到 views/ 下
 * - 名字不能为空
 * - 不允许 .. / 等路径字符（防注入）
 */
export function sanitizePrefabName(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error(`invalid prefab name: ${name}`);
  }
  if (/[\\/:*?"<>|]/.test(name) || name.includes("..")) {
    throw new Error(`invalid prefab name (contains illegal chars): ${name}`);
  }
  return name;
}

/**
 * 从 prefab 路径反推 Cocos 项目根。
 *
 * Cocos Creator 项目根的标志（必要条件）：
 * - 包含 `settings/` 目录（v2 / v3 都有）
 * - 包含 `assets/` 目录
 *
 * 这个组合能稳定排除 `proj-l-commonui` 这种"看似根但实际是子扩展"的目录，
 * 因为子扩展通常没有 settings/。
 *
 * 找不到返回 undefined，调用方需明确传 projectRoot。
 */
export function inferProjectRoot(prefabAbsPath: string): string | undefined {
  let cur = path.dirname(prefabAbsPath);
  const visited = new Set<string>();
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    if (looksLikeCocosRoot(cur)) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

/** 判断给定目录是否像 Cocos Creator 项目根（assets/ + settings/ 同时存在） */
export function looksLikeCocosRoot(dir: string): boolean {
  const assetsDir = path.join(dir, "assets");
  const settingsDir = path.join(dir, "settings");
  try {
    return fs.existsSync(assetsDir) && fs.existsSync(settingsDir);
  } catch {
    return false;
  }
}
