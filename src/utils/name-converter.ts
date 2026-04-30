/**
 * 节点名/路径 → 合法 TS 标识符。
 *
 * 规则：
 * - 非 ASCII 字母数字 / 下划线 / $ → 转 `_`；
 * - 连续 `_` 合并；
 * - 首字符若为数字，前缀 `_`；
 * - 命中保留字时尾缀 `_`；
 * - 路径段用 `_` 拼接，再做一次清洗。
 */

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield", "let", "static", "implements", "interface", "package", "private",
  "protected", "public", "abstract", "as", "async", "await", "any", "boolean",
  "constructor", "declare", "from", "is", "module", "namespace", "of", "type",
]);

export function toIdentifier(raw: string): string {
  if (!raw) return "_";
  let s = raw.replace(/[^A-Za-z0-9_$]/g, "_");
  s = s.replace(/_+/g, "_");
  if (/^[0-9]/.test(s)) s = "_" + s;
  if (RESERVED.has(s)) s = s + "_";
  return s;
}

/** 把路径段拼成单个标识符；camelCase 形式更短更易读 */
export function pathToIdentifier(path: string, options?: { camel?: boolean }): string {
  if (!path) return "root";
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) return "root";
  if (options?.camel) {
    const parts = segs.map((s) => toIdentifier(s));
    const head = parts[0].replace(/^_+/, "");
    const rest = parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
    const joined = head + rest.join("");
    return toIdentifier(joined);
  }
  return toIdentifier(segs.join("_"));
}

/** 把 PascalCase / kebab / snake 转成属性风格的 camelCase */
export function toCamel(raw: string): string {
  const cleaned = toIdentifier(raw);
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}
