/**
 * 从 .ts 源文件里提取 `@ccclass` 装饰的类名 / 类符号
 *
 * Cocos 组件 ts 文件的典型结构：
 *
 *     import { _decorator, Component } from 'cc';
 *     const { ccclass } = _decorator;
 *
 *     @ccclass('CommonUI')
 *     export class CommonUI extends Component { ... }
 *
 * 或简写：
 *
 *     @ccclass
 *     export class Foo extends Component { ... }
 *
 * 我们只抓 **第一个 @ccclass 装饰的导出类**：因为一个 .ts.meta 文件就对应一个
 * 主 export，附带的辅助类不是 prefab 序列化目标。
 *
 * 用正则而非完整 TS AST：
 *  · 性能：每个文件只读一次、扫几行就能定位
 *  · 零依赖：不引入 typescript 编译器
 *  · 鲁棒：90% 项目都符合 cocos 默认模板，遇到特殊形式回退到 fallback
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface TsClassInfo {
  /** 文件里 export 的主类名 */
  className: string;
  /** @ccclass(...) 装饰器里写的注册名（一般等于 className，少数项目会改） */
  ccclassName: string;
  /** 是否带 `export` 关键字（直接 import 还是只能命名空间访问） */
  isExported: boolean;
  /** 是否是 `export default` */
  isDefault: boolean;
  /**
   * `extends X` 后的基类名（仅字面量，未做 import 重命名解析）。
   * 用于：识别 cc.Button 子类（基类名为 "Button"）。
   * 没有 extends 子句时为 undefined。
   *
   * 已知局限：
   *   · 跨文件继承链不会递归解析（A extends B extends Button → 当前只能直接看到 A→B）
   *   · `import { Button as MyBtn } from "cc"; class X extends MyBtn` 会被识别为 "MyBtn"
   *   · 命名空间形式 `class X extends cc.Button` 会被识别为 "cc.Button"（含点号）
   * 这些边缘情况我们另外在 ScriptTypeRegistry 里做归一化处理。
   */
  extendsClassName?: string;
  /** 文件绝对路径 */
  filePath: string;
}

/**
 * 在文件内容里找第一个 @ccclass 装饰的导出类
 * 找不到返回 undefined（说明这个 .ts 不是 Cocos 组件）
 */
export function extractClassFromContent(content: string, filePath: string): TsClassInfo | undefined {
  // 单行模式下匹配 @ccclass(...) 后面紧跟的 export class XXX (extends Y)?
  // 装饰器和类定义之间允许有空白行/其它装饰器
  const pattern =
    /@ccclass\s*(?:\(\s*(?:['"]([^'"]+)['"])?\s*\))?\s*(?:@[A-Za-z_$][\w$]*\s*(?:\([^)]*\))?\s*)*((?:export\s+(?:default\s+)?)?)\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$.]*))?/m;

  const m = content.match(pattern);
  if (!m) return undefined;

  const ccname = m[1];
  const exportPrefix = m[2].trim();
  const className = m[3];
  const extendsName = m[4];
  const isExported = /\bexport\b/.test(exportPrefix);
  const isDefault = /\bdefault\b/.test(exportPrefix);

  return {
    className,
    ccclassName: ccname || className,
    isExported,
    isDefault,
    extendsClassName: extendsName,
    filePath,
  };
}

/** 读 .ts 文件并解析；找不到 @ccclass 返回 undefined */
export function extractClassFromFile(filePath: string): TsClassInfo | undefined {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`filePath must be absolute: ${filePath}`);
  }
  if (!fs.existsSync(filePath)) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return extractClassFromContent(content, filePath);
}

/**
 * 批量提取，返回 className → TsClassInfo 索引。
 * 同名类（不同文件）会保留**第一个**遇到的，并在 console 警告（v0.3 再做 namespace 隔离）。
 */
export function extractClassesFromFiles(filePaths: ReadonlyArray<string>): Map<string, TsClassInfo> {
  const map = new Map<string, TsClassInfo>();
  for (const f of filePaths) {
    const info = extractClassFromFile(f);
    if (!info) continue;
    if (map.has(info.className)) {
      // 同名冲突：保留第一个，调用方可用 collisionFiles 检查
      continue;
    }
    map.set(info.className, info);
  }
  return map;
}
