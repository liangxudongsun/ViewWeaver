import * as path from "node:path";
import * as fs from "node:fs";

/** 确保目录存在；不存在则递归创建 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** 文件名去掉扩展名 */
export function basenameNoExt(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? base : base.slice(0, dot);
}

/**
 * 写入文件 — 原子写入：写到 .tmp 再 rename 上去
 *
 * 单进程内基本可以避免读到半截文件（rename 在同一文件系统上是原子的），
 * 多进程并发写仍需上锁，但 v0.2 没有这种场景。
 */
export function writeFileSafe(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  // Windows 下若目标文件存在，rename 会失败，所以先尝试删
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // 走 fallback：先删再 rename（windows 上 rename 不能覆盖）
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* not exist, ok */
    }
    fs.renameSync(tmp, filePath);
  }
}

export function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}
