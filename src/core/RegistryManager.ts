/**
 * __registry.json 管理
 *
 * 用途：
 * - 记录每个 prefab → gen.ts 的映射，方便：
 *   - 运行时按 prefab UUID/名称反查 PrefabView 类（业务侧 helper）
 *   - 编辑器扩展批量遍历"哪些 prefab 已经有 bind"
 *   - prefab 改名后，校验工具能发现"registry 还有但 prefab 不在了"
 *
 * 格式（JSON）：
 * {
 *   "$schema": 1,
 *   "tool": "genbot",
 *   "version": "0.2.0",
 *   "entries": {
 *     "<prefabName>": {
 *       "prefabName": "common_ui",
 *       "prefabUuid": "abc-...",        // 可选，prefab .meta 中的 uuid（v0.3 接进来）
 *       "prefabPath": "extensions/proj-l-commonui/assets/ab/prefab/ui/common_ui.prefab",
 *       "genTsPath": "assets/scripts/_genbot/common_ui/common_ui.gen.ts",
 *       "bindJsonPath": "assets/scripts/_genbot/common_ui/common_ui.bind.json",
 *       "viewClassName": "Common_uiPrefabView",
 *       "lastGenAt": "2026-05-06T12:34:56.000Z",
 *       "lastGenBy": "cli" | "extension" | "auto-watch"
 *     }
 *   }
 * }
 *
 * 并发模型（v0.2 单进程足够）：
 * - 简单的 read → mutate → write 序列
 * - writeFileSafe 使用 tmp + rename 模拟原子
 * - 多进程同时写的极端场景留到 v0.3 上锁；CLI / 扩展不会真的并发触发
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileSafe, ensureDir, readJsonIfExists } from "../utils/paths.ts";
import { resolveRegistryPath } from "./ProjectLayout.ts";
import { TOOL_VERSION } from "./RunOnce.ts";

export interface RegistryEntry {
  prefabName: string;
  prefabUuid?: string;
  /** 相对项目根的 prefab 路径（POSIX 分隔） */
  prefabPath: string;
  /** 相对项目根的 .gen.ts 路径 */
  genTsPath: string;
  /** 相对项目根的 .bind.json 路径 */
  bindJsonPath: string;
  /** 相对项目根的 .view.ts 路径（开发者持有的承基类） */
  viewTsPath?: string;
  /** view.ts 中开发者类名（与 bind.json 的 viewClassName 对齐） */
  viewClassName: string;
  /** 上次生成时间（ISO） */
  lastGenAt: string;
  /** 上次生成来源 */
  lastGenBy: "cli" | "extension" | "auto-watch" | "test" | "inspector";
}

export interface RegistryFile {
  $schema: 1;
  tool: "genbot";
  version: string;
  entries: Record<string, RegistryEntry>;
}

const EMPTY: () => RegistryFile = () => ({
  $schema: 1,
  tool: "genbot",
  version: TOOL_VERSION,
  entries: {},
});

export class RegistryManager {
  private readonly _projectRoot: string;
  private readonly _registryPath: string;

  constructor(projectRoot: string) {
    if (!path.isAbsolute(projectRoot)) {
      throw new Error(`projectRoot must be absolute: ${projectRoot}`);
    }
    this._projectRoot = projectRoot;
    this._registryPath = resolveRegistryPath(projectRoot);
  }

  /** registry 文件绝对路径 */
  public get path(): string {
    return this._registryPath;
  }

  /** 读出当前内容，文件不存在则返回空模板（不会写盘） */
  public load(): RegistryFile {
    const raw = readJsonIfExists<RegistryFile>(this._registryPath);
    if (!raw) return EMPTY();
    if (raw.$schema !== 1 || raw.tool !== "genbot") {
      // 文件被外部破坏，留底备份后重置
      const backup = `${this._registryPath}.broken.${Date.now()}.bak`;
      try {
        fs.copyFileSync(this._registryPath, backup);
      } catch {
        /* 备份失败也继续，不应该阻塞工作流 */
      }
      return EMPTY();
    }
    raw.entries = raw.entries ?? {};
    return raw;
  }

  /** upsert 单个条目 + 立刻落盘 */
  public upsert(entry: RegistryEntry): RegistryFile {
    const file = this.load();
    file.entries[entry.prefabName] = entry;
    file.version = TOOL_VERSION;
    this.save(file);
    return file;
  }

  /** 删除指定 prefab 的注册（prefab 被删除/改名时调用） */
  public remove(prefabName: string): boolean {
    const file = this.load();
    if (!(prefabName in file.entries)) return false;
    delete file.entries[prefabName];
    this.save(file);
    return true;
  }

  public get(prefabName: string): RegistryEntry | undefined {
    return this.load().entries[prefabName];
  }

  public list(): RegistryEntry[] {
    return Object.values(this.load().entries).sort((a, b) =>
      a.prefabName.localeCompare(b.prefabName)
    );
  }

  /** 把 file 内容稳定排序后写盘 */
  public save(file: RegistryFile): void {
    const ordered: RegistryFile = {
      $schema: 1,
      tool: "genbot",
      version: file.version || TOOL_VERSION,
      entries: sortKeys(file.entries),
    };
    ensureDir(path.dirname(this._registryPath));
    writeFileSafe(this._registryPath, JSON.stringify(ordered, null, 2) + "\n");
  }
}

function sortKeys(obj: Record<string, RegistryEntry>): Record<string, RegistryEntry> {
  const sorted: Record<string, RegistryEntry> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k];
  }
  return sorted;
}
