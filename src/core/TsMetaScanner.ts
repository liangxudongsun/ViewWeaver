/**
 * 扫描项目里所有 .ts.meta 文件，建立 UUID → 源文件路径 的映射
 *
 * Cocos Creator 项目里每个 .ts 旁边都有一个同名 .ts.meta，里面记着 uuid。
 * 我们要扫这些 meta 文件，把 uuid（含压缩形式）映射回 .ts 文件绝对路径。
 *
 * 默认扫描两个根：
 *   - <project>/assets/
 *   - <project>/extensions/
 *
 * 不扫 node_modules / dist / library / 三方依赖。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { compressUuid, normalizeUuid } from "./UuidCompress.ts";

export interface MetaEntry {
  /** .ts.meta 中的标准 UUID（小写，不带连字符） */
  uuidHex: string;
  /** 压缩 UUID（prefab 里的 __type__ 值） */
  uuidCompressed: string;
  /** .ts 源文件绝对路径（去掉 .meta 后缀） */
  tsAbsPath: string;
  /** 相对项目根的 .ts 路径（POSIX） */
  tsRelPath: string;
}

export interface ScanOptions {
  /** 项目根目录绝对路径（含 assets/） */
  projectRoot: string;
  /** 自定义扫描根列表，默认 ['assets', 'extensions'] */
  scanRoots?: string[];
  /** 跳过的目录名（任意层级匹配） */
  skipDirs?: ReadonlySet<string>;
  /** 扫描超时（毫秒），防止异常项目把工具卡死 */
  timeoutMs?: number;
}

export interface ScanResult {
  /** uuidHex → MetaEntry */
  byUuid: Map<string, MetaEntry>;
  /** uuidCompressed → MetaEntry，prefab __type__ 直接查这个 */
  byCompressed: Map<string, MetaEntry>;
  /** 总扫描时间 */
  elapsedMs: number;
  /** 命中的 .ts.meta 文件数 */
  count: number;
  /** 解析失败的文件（路径 + 错误） */
  failures: Array<{ file: string; reason: string }>;
}

const DEFAULT_SKIP: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "library",
  ".git",
  ".vscode",
  ".idea",
  "temp",
  ".tmp",
  "views", // 不扫自己生成的目录
  "_genbot", // 旧布局兼容
]);

/**
 * 扫一遍项目，构建 uuid 索引。
 *
 * 在中等大小的项目（约 1000 个 .ts 文件）上 < 200ms 应当稳定。
 * 实测 proj-l-client 全量在 ~50ms。
 */
export function scanTsMeta(options: ScanOptions): ScanResult {
  const t0 = Date.now();
  const projectRoot = options.projectRoot;
  if (!path.isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be absolute: ${projectRoot}`);
  }

  const scanRoots = options.scanRoots ?? ["assets", "extensions"];
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = t0 + timeoutMs;

  const byUuid = new Map<string, MetaEntry>();
  const byCompressed = new Map<string, MetaEntry>();
  const failures: Array<{ file: string; reason: string }> = [];

  for (const rel of scanRoots) {
    const absRoot = path.join(projectRoot, rel);
    if (!fs.existsSync(absRoot)) continue;
    walk(absRoot, projectRoot, skipDirs, deadline, byUuid, byCompressed, failures);
  }

  return {
    byUuid,
    byCompressed,
    elapsedMs: Date.now() - t0,
    count: byUuid.size,
    failures,
  };
}

function walk(
  dir: string,
  projectRoot: string,
  skipDirs: ReadonlySet<string>,
  deadline: number,
  byUuid: Map<string, MetaEntry>,
  byCompressed: Map<string, MetaEntry>,
  failures: Array<{ file: string; reason: string }>
): void {
  if (Date.now() > deadline) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (skipDirs.has(ent.name)) continue;
      walk(
        path.join(dir, ent.name),
        projectRoot,
        skipDirs,
        deadline,
        byUuid,
        byCompressed,
        failures
      );
      continue;
    }
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".ts.meta")) continue;
    const metaPath = path.join(dir, ent.name);
    const tsAbsPath = metaPath.slice(0, -".meta".length);
    if (!fs.existsSync(tsAbsPath)) {
      // .meta 没对应 .ts，可能是被删掉了，跳过
      continue;
    }
    try {
      const raw = fs.readFileSync(metaPath, "utf8");
      const json = JSON.parse(raw);
      const u = (json as { uuid?: string }).uuid;
      if (!u || typeof u !== "string") {
        failures.push({ file: metaPath, reason: "missing uuid" });
        continue;
      }
      const uuidHex = normalizeUuid(u);
      const uuidCompressed = compressUuid(u);
      const entry: MetaEntry = {
        uuidHex,
        uuidCompressed,
        tsAbsPath,
        tsRelPath: path.relative(projectRoot, tsAbsPath).replace(/\\/g, "/"),
      };
      byUuid.set(uuidHex, entry);
      byCompressed.set(uuidCompressed, entry);
    } catch (e) {
      failures.push({ file: metaPath, reason: (e as Error).message });
    }
  }
}
