/**
 * Cocos Creator UUID 压缩/解压
 *
 * Cocos 在 prefab 序列化里把 36 字符的标准 UUID 压缩成 23 字符形式：
 *   - 前 5 个 hex 字符保留不变（"53f93..."）
 *   - 剩余 27 个 hex 字符（= 108 bit）每 12 bit 一组，用 base64 字符表（64 = 6 bit）双字符表示
 *     27 hex × 4 bit = 108 bit → 18 base64 字符
 *
 * 例：
 *   meta:    "53f930ad-6071-4f7c-a838-ed8d3b9bf350"
 *   prefab:  "53f93CtYHFPfKg47Y07m/NQ"
 *
 * 算法来源：Cocos Creator 引擎 `cocos/core/utils/uuid.ts`
 */

const BASE64_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const HEX_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  const hex = "0123456789abcdef";
  for (let i = 0; i < hex.length; i++) map[hex[i]] = i;
  for (let i = 0; i < hex.length; i++) map[hex[i].toUpperCase()] = i;
  return map;
})();

const BASE64_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < BASE64_KEYS.length; i++) map[BASE64_KEYS[i]] = i;
  return map;
})();

/** 标准化为不含连字符的小写 hex（32 字符） */
export function normalizeUuid(uuid: string): string {
  const cleaned = uuid.replace(/-/g, "").toLowerCase();
  if (cleaned.length !== 32 || !/^[0-9a-f]{32}$/.test(cleaned)) {
    throw new Error(`invalid full uuid: ${uuid}`);
  }
  return cleaned;
}

/** 检测一个字符串是不是压缩 UUID（23 字符，base64ish） */
export function isCompressedUuid(s: string): boolean {
  return typeof s === "string" && s.length === 23 && /^[0-9a-f]{5}[A-Za-z0-9+/]{18}$/.test(s);
}

/** 检测一个字符串是不是完整 UUID（36 字符带连字符 / 或 32 字符不带） */
export function isFullUuid(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.length === 36) return /^[0-9a-fA-F-]{36}$/.test(s);
  if (s.length === 32) return /^[0-9a-fA-F]{32}$/.test(s);
  return false;
}

/** 压缩：完整 UUID → 23 字符压缩形式 */
export function compressUuid(uuid: string): string {
  const hex = normalizeUuid(uuid);
  let result = hex.substr(0, 5);
  for (let i = 5; i < 32; i += 3) {
    const a = HEX_VALUES[hex[i]] ?? 0;
    const b = HEX_VALUES[hex[i + 1]] ?? 0;
    const c = HEX_VALUES[hex[i + 2]] ?? 0;
    const value = (a << 8) | (b << 4) | c;
    result += BASE64_KEYS[(value >> 6) & 0x3f];
    result += BASE64_KEYS[value & 0x3f];
  }
  return result;
}

/** 解压：23 字符压缩形式 → 32 字符 hex（不带连字符） */
export function decompressUuid(short: string): string {
  if (!isCompressedUuid(short)) {
    throw new Error(`invalid compressed uuid: ${short}`);
  }
  let result = short.substr(0, 5);
  for (let i = 5; i < 23; i += 2) {
    const high = BASE64_VALUES[short[i]];
    const low = BASE64_VALUES[short[i + 1]];
    if (high == null || low == null) {
      throw new Error(`invalid base64 char in: ${short}`);
    }
    const value = (high << 6) | low; // 12 bits
    result += ((value >> 8) & 0xf).toString(16);
    result += ((value >> 4) & 0xf).toString(16);
    result += (value & 0xf).toString(16);
  }
  return result;
}

/** 把任意 UUID 形式（完整 / 压缩 / 不带连字符）规范成 32 字符 hex */
export function toCanonicalHex(uuid: string): string {
  if (isCompressedUuid(uuid)) return decompressUuid(uuid);
  if (isFullUuid(uuid)) return normalizeUuid(uuid);
  throw new Error(`unrecognized uuid format: ${uuid}`);
}
