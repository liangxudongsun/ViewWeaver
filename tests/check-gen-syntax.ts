// 用 Node 22 的 TS strip-types API 检查生成文件能否被解析。
import * as fs from "node:fs";
import * as path from "node:path";

const target = process.argv[2] ?? "tests/output/common_ui.gen.ts";
const abs = path.resolve(target);
const text = fs.readFileSync(abs, "utf8");

// node:module 暴露了 stripTypeScriptTypes（22.7+）
// 类型不在公开 d.ts 里，所以用 any。
import * as nodeModule from "node:module";
const stripFn: ((src: string, opts?: object) => string) | undefined =
  (nodeModule as unknown as { stripTypeScriptTypes?: (src: string, opts?: object) => string })
    .stripTypeScriptTypes;

if (typeof stripFn !== "function") {
  console.error("[check] node:module.stripTypeScriptTypes not available; node version too old");
  process.exit(2);
}

try {
  const stripped = stripFn(text, { mode: "strip" });
  console.log(`[check] OK: ${target} parses, stripped size = ${stripped.length} bytes`);
} catch (e) {
  console.error(`[check] FAIL: ${target}: ${(e as Error).message}`);
  process.exit(1);
}
