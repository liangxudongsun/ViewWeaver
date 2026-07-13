/**
 * 自定义脚本类型注册表
 *
 * 把 prefab 里的 UUID（压缩或完整形式）解析成 `{ className, importFrom }`，
 * 让 GenTsGenerator 能给 60 个 unknown 组件生成正确的 import + 类型字段。
 *
 * 解析步骤：
 *   1. 用 TsMetaScanner 扫一次项目的 .ts.meta 文件，建立 UUID → ts 路径 索引（懒加载）
 *   2. 第一次 resolve(uuid) 时，按需读取对应 .ts 文件，跑 TsClassExtractor 抓 @ccclass
 *   3. 最终返回的 importFrom 是相对 .gen.ts 文件的相对路径（POSIX）
 *
 * 性能：
 *  - 索引扫一次缓存到内存，整个 runOnce 流程只扫一次
 *  - .ts 内容懒加载，没碰到的脚本不读
 *  - proj-l-client（约 600+ ts 文件）整体扫描 < 80ms
 */

import * as path from "node:path";

import { type ComponentTypeInfo } from "../parsers/ComponentTypeMap.ts";
import { scanTsMeta, type ScanResult, type MetaEntry } from "./TsMetaScanner.ts";
import { extractClassFromFile, type TsClassInfo } from "./TsClassExtractor.ts";
import { isCompressedUuid, isFullUuid, normalizeUuid } from "./UuidCompress.ts";

export interface ScriptResolveContext {
  /** .gen.ts 文件绝对路径，用于计算 import 相对路径 */
  genTsAbsPath: string;
}

/**
 * 解析结果（resolve 的 cache value）
 * - `info`: 当 .ts 找到了合法 @ccclass，返回标准 ComponentTypeInfo
 * - `info: undefined`: 找不到 .ts.meta 或文件里没 @ccclass，调用方应当跳过该组件
 */
interface ResolveCacheValue {
  info: ComponentTypeInfo | undefined;
  meta?: MetaEntry;
  cls?: TsClassInfo;
}

export class ScriptTypeRegistry {
  private readonly _projectRoot: string;
  private _scanResult?: ScanResult;
  /** 同一个 (uuid, genTsAbsPath) 组合的解析结果缓存 */
  private readonly _cache = new Map<string, ResolveCacheValue>();
  /** 每个 ts 文件只解析一次类名 */
  private readonly _classCache = new Map<string, TsClassInfo | null>();

  constructor(projectRoot: string) {
    if (!path.isAbsolute(projectRoot)) {
      throw new Error(`projectRoot must be absolute: ${projectRoot}`);
    }
    this._projectRoot = projectRoot;
  }

  /** 强制立刻扫一次（默认懒加载） */
  public scan(): ScanResult {
    if (!this._scanResult) {
      this._scanResult = scanTsMeta({ projectRoot: this._projectRoot });
    }
    return this._scanResult;
  }

  /** 返回扫描结果（不存在则触发扫描） */
  public get scanResult(): ScanResult {
    return this.scan();
  }

  /**
   * 解析 prefab __type__（压缩 UUID 或完整 UUID）→ ComponentTypeInfo
   * 找不到时返回 undefined，调用方按之前的 unknown 处理逻辑跳过。
   *
   * importFrom 是相对 .gen.ts 的 POSIX 路径，去掉 .ts 扩展名（runtime import 用 .js）
   */
  public resolve(rawType: string, ctx: ScriptResolveContext): ComponentTypeInfo | undefined {
    const cacheKey = `${rawType}|${ctx.genTsAbsPath}`;
    const cached = this._cache.get(cacheKey);
    if (cached) return cached.info;

    const meta = this.lookupMeta(rawType);
    if (!meta) {
      this._cache.set(cacheKey, { info: undefined });
      return undefined;
    }

    const cls = this.lookupClass(meta);
    if (!cls || !cls.isExported) {
      // 没有 @ccclass 装饰、或是非 export 的内部类 → 跳过
      this._cache.set(cacheKey, { info: undefined, meta, cls: cls ?? undefined });
      return undefined;
    }

    const importFrom = this.computeImportPath(ctx.genTsAbsPath, meta.tsAbsPath);
    const info: ComponentTypeInfo = {
      tsName: cls.className,
      importFrom,
      builtin: false,
      isDefaultExport: cls.isDefault,
      extendsClassName: cls.extendsClassName,
      // 直接继承自 Button 的脚本视为 Button 子类。
      // 注意：跨文件多级继承（A → B → Button）当前不递归解析，需要时
      // 后续可在 v0.3 沿 extendsClassName 链查找。
      isButton: cls.extendsClassName === "Button" || cls.extendsClassName === "cc.Button",
    };
    this._cache.set(cacheKey, { info, meta, cls });
    return info;
  }

  /** 直接拿到 meta 信息（debug 用） */
  public lookupMeta(rawType: string): MetaEntry | undefined {
    const r = this.scan();
    if (isCompressedUuid(rawType)) return r.byCompressed.get(rawType);
    if (isFullUuid(rawType)) return r.byUuid.get(normalizeUuid(rawType));
    return undefined;
  }

  /** 解析某个 ts 文件的类信息（带缓存） */
  public lookupClass(meta: MetaEntry): TsClassInfo | undefined {
    const cached = this._classCache.get(meta.tsAbsPath);
    if (cached !== undefined) return cached ?? undefined;
    const info = extractClassFromFile(meta.tsAbsPath);
    this._classCache.set(meta.tsAbsPath, info ?? null);
    return info;
  }

  /**
   * 计算从 .gen.ts 到目标 .ts 的相对 import 路径（POSIX 风格、无扩展名）
   *
   * 例：
   *   gen: <root>/assets/scripts/views/common_ui/common_ui.gen.ts
   *   tgt: <root>/assets/scripts/game/effect/MultiplierBallEffect.ts
   *   →    "../../game/effect/MultiplierBallEffect"
   */
  public computeImportPath(genTsAbsPath: string, targetTsAbsPath: string): string {
    const fromDir = path.dirname(genTsAbsPath);
    let rel = path.relative(fromDir, targetTsAbsPath);
    rel = rel.replace(/\\/g, "/");
    // 去掉 .ts 扩展
    if (rel.endsWith(".ts")) rel = rel.slice(0, -3);
    // 同目录补前导 ./
    if (!rel.startsWith(".")) rel = "./" + rel;
    return rel;
  }

  /** 调试用：列出所有当前已缓存的解析结果 */
  public dumpResolved(): { rawType: string; tsName?: string; importFrom?: string }[] {
    const out: { rawType: string; tsName?: string; importFrom?: string }[] = [];
    for (const [k, v] of this._cache) {
      const rawType = k.split("|")[0];
      out.push({ rawType, tsName: v.info?.tsName, importFrom: v.info?.importFrom });
    }
    return out;
  }
}
