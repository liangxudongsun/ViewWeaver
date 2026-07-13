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
 *   "tool": "viewweaver",
 *   "version": "0.2.0",
 *   "entries": {
 *     "<prefabName>": {
 *       "prefabName": "common_ui",
 *       "prefabUuid": "abc-...",
 *       "prefabPath": "assets/resources/prefab/MainUI.prefab",
 *       "genTsPath": "assets/scripts/views/common_ui/common_ui.gen.ts",
 *       "bindJsonPath": "assets/scripts/views/common_ui/common_ui.bind.json",
 *       "viewClassName": "Common_uiView",
 *       "lastGenAt": "2026-05-06T12:34:56.000Z",
 *       "lastGenBy": "cli" | "extension" | "auto-watch"
 *     }
 *   }
 * }
 *
 * 兼容：若仅有旧 `assets/scripts/_genbot/__registry.json`（tool: genbot），
 * load() 会迁移路径到 views/ 并在下次 save 写出新文件。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileSafe, ensureDir, readJsonIfExists } from "../utils/paths.ts";
import {
  LEGACY_GENBOT_ROOT_REL,
  VIEWWEAVER_ROOT_REL,
  resolveLegacyRegistryPath,
  resolveRegistryPath,
} from "./ProjectLayout.ts";
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
  lastGenBy: "cli" | "extension" | "auto-watch" | "test" | "inspector" | "ai";
}

export interface RegistryFile {
  $schema: 1;
  tool: "viewweaver";
  version: string;
  entries: Record<string, RegistryEntry>;
}

/** 磁盘上可能仍是旧 tool 字段 */
interface RawRegistryFile {
  $schema?: number;
  tool?: string;
  version?: string;
  entries?: Record<string, RegistryEntry>;
}

const EMPTY: () => RegistryFile = () => ({
  $schema: 1,
  tool: "viewweaver",
  version: TOOL_VERSION,
  entries: {},
});

/** 把相对路径中的旧 _genbot 根改成 views */
function migrateRelPath(rel: string | undefined): string | undefined {
  if (!rel) return rel;
  const posix = rel.replace(/\\/g, "/");
  if (posix.startsWith(`${LEGACY_GENBOT_ROOT_REL}/`) || posix === LEGACY_GENBOT_ROOT_REL) {
    return posix.replace(LEGACY_GENBOT_ROOT_REL, VIEWWEAVER_ROOT_REL);
  }
  return posix;
}

function migrateEntry(entry: RegistryEntry): RegistryEntry {
  return {
    ...entry,
    genTsPath: migrateRelPath(entry.genTsPath) ?? entry.genTsPath,
    bindJsonPath: migrateRelPath(entry.bindJsonPath) ?? entry.bindJsonPath,
    viewTsPath: migrateRelPath(entry.viewTsPath),
  };
}

function normalizeRegistry(raw: RawRegistryFile): RegistryFile | null {
  if (raw.$schema !== 1) return null;
  if (raw.tool !== "viewweaver" && raw.tool !== "genbot") return null;
  const entries: Record<string, RegistryEntry> = {};
  for (const [k, v] of Object.entries(raw.entries ?? {})) {
    entries[k] = migrateEntry(v);
  }
  return {
    $schema: 1,
    tool: "viewweaver",
    version: raw.version || TOOL_VERSION,
    entries,
  };
}

export class RegistryManager {
  private readonly _projectRoot: string;
  private readonly _registryPath: string;
  private readonly _legacyRegistryPath: string;
  /** 从旧布局迁入后，下次 save 写新路径 */
  private _dirtyFromLegacy = false;

  constructor(projectRoot: string) {
    if (!path.isAbsolute(projectRoot)) {
      throw new Error(`projectRoot must be absolute: ${projectRoot}`);
    }
    this._projectRoot = projectRoot;
    this._registryPath = resolveRegistryPath(projectRoot);
    this._legacyRegistryPath = resolveLegacyRegistryPath(projectRoot);
  }

  /** registry 文件绝对路径（新布局） */
  public get path(): string {
    return this._registryPath;
  }

  /** 读出当前内容，文件不存在则返回空模板（不会写盘） */
  public load(): RegistryFile {
    const modern = readJsonIfExists<RawRegistryFile>(this._registryPath);
    if (modern) {
      const norm = normalizeRegistry(modern);
      if (norm) {
        this._dirtyFromLegacy = false;
        return norm;
      }
      const backup = `${this._registryPath}.broken.${Date.now()}.bak`;
      try {
        fs.copyFileSync(this._registryPath, backup);
      } catch {
        /* ignore */
      }
      return EMPTY();
    }

    const legacy = readJsonIfExists<RawRegistryFile>(this._legacyRegistryPath);
    if (legacy) {
      const norm = normalizeRegistry(legacy);
      if (norm) {
        this._dirtyFromLegacy = true;
        return norm;
      }
    }

    return EMPTY();
  }

  /** upsert 单个条目 + 立刻落盘 */
  public upsert(entry: RegistryEntry): RegistryFile {
    const file = this.load();
    file.entries[entry.prefabName] = migrateEntry(entry);
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

  /** 把 file 内容稳定排序后写盘（始终写新布局） */
  public save(file: RegistryFile): void {
    const ordered: RegistryFile = {
      $schema: 1,
      tool: "viewweaver",
      version: file.version || TOOL_VERSION,
      entries: sortKeys(
        Object.fromEntries(
          Object.entries(file.entries).map(([k, v]) => [k, migrateEntry(v)])
        )
      ),
    };
    ensureDir(path.dirname(this._registryPath));
    writeFileSafe(this._registryPath, JSON.stringify(ordered, null, 2) + "\n");
    this._dirtyFromLegacy = false;
  }
}

function sortKeys(obj: Record<string, RegistryEntry>): Record<string, RegistryEntry> {
  const sorted: Record<string, RegistryEntry> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k];
  }
  return sorted;
}
