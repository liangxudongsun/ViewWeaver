// Lightweight, framework-free smoke tests for genbot.
//
// Run with:  node --experimental-strip-types tests/smoke.test.ts
//
// Exit code is non-zero when any case fails.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrefab, parsePrefabFile } from "../src/parsers/PrefabParser.ts";
import {
  makeDefaultBindConfig,
  validateBindAgainstPrefab,
  saveBindConfig,
  loadBindConfig,
} from "../src/generators/BindJsonManager.ts";
import { generateGenTs } from "../src/generators/GenTsGenerator.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let failed = 0;
let passed = 0;
const failures: string[] = [];
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  const run = async (): Promise<void> => {
    try {
      await fn();
      passed++;
      process.stdout.write(`  PASS  ${name}\n`);
    } catch (e) {
      failed++;
      const msg = `  FAIL  ${name}\n         ${(e as Error).stack ?? (e as Error).message}`;
      failures.push(msg);
      process.stdout.write(msg + "\n");
    }
  };
  pending.push(run());
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg ?? "values not equal"}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
    );
  }
}

// --- minimal synthetic prefab -----------------------------------------------

/**
 * Build a tiny prefab JSON:
 *
 *   root (cc.Node "panel")
 *     ├─ child_a (cc.Node)
 *     │    └─ [cc.Sprite, cc.Label]
 *     └─ child_b (cc.Node)
 *          ├─ same_name (cc.Node) [cc.Button]
 *          └─ same_name (cc.Node) [cc.Sprite]
 */
function buildSyntheticPrefab(): unknown[] {
  return [
    /* 0 */ { __type__: "cc.Prefab", _name: "panel", data: { __id__: 1 } },
    /* 1 */ {
      __type__: "cc.Node",
      _name: "panel",
      _parent: null,
      _children: [{ __id__: 2 }, { __id__: 3 }],
      _components: [],
      _active: true,
    },
    /* 2 */ {
      __type__: "cc.Node",
      _name: "child_a",
      _parent: { __id__: 1 },
      _children: [],
      _components: [{ __id__: 7 }, { __id__: 8 }],
      _active: true,
    },
    /* 3 */ {
      __type__: "cc.Node",
      _name: "child_b",
      _parent: { __id__: 1 },
      _children: [{ __id__: 4 }, { __id__: 5 }],
      _components: [],
      _active: true,
    },
    /* 4 */ {
      __type__: "cc.Node",
      _name: "same_name",
      _parent: { __id__: 3 },
      _children: [],
      _components: [{ __id__: 9 }],
      _active: true,
    },
    /* 5 */ {
      __type__: "cc.Node",
      _name: "same_name",
      _parent: { __id__: 3 },
      _children: [],
      _components: [{ __id__: 10 }],
      _active: true,
    },
    /* 6 */ { __type__: "cc.CompPrefabInfo", fileId: "skip" },
    /* 7 */ { __type__: "cc.Sprite", node: { __id__: 2 }, _enabled: true },
    /* 8 */ { __type__: "cc.Label", node: { __id__: 2 }, _enabled: true },
    /* 9 */ { __type__: "cc.Button", node: { __id__: 4 }, _enabled: true },
    /* 10 */ { __type__: "cc.Sprite", node: { __id__: 5 }, _enabled: true },
  ];
}

// --- tests ------------------------------------------------------------------

test("parsePrefab: builds correct node tree", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  eq(parsed.name, "panel");
  eq(parsed.stats.totalNodes, 5, "totalNodes");
  eq(parsed.stats.totalComponents, 4, "totalComponents (skipping CompPrefabInfo)");
  // 路径
  assert(parsed.nodesByPath.has(""), "root path empty");
  assert(parsed.nodesByPath.has("child_a"), "child_a present");
  assert(parsed.nodesByPath.has("child_b/same_name"), "first same_name");
  assert(parsed.nodesByPath.has("child_b/same_name(1)"), "second same_name disambiguated");
});

test("parsePrefab: components ordered and typed", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const a = parsed.nodesByPath.get("child_a")!;
  eq(a.components.length, 2, "child_a has 2 components");
  eq(a.components[0].rawType, "cc.Sprite");
  eq(a.components[0].typeInfo!.tsName, "Sprite");
  eq(a.components[1].rawType, "cc.Label");
});

test("makeDefaultBindConfig: skips root, exposes named nodes + whitelisted components", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  const fields = cfg.nodes.map((n) => n.field);
  // 单段 path 不做 underscore→camel 转换（保留美术节点名的可读性）
  assert(!fields.includes("root"), "root not exposed by default");
  assert(fields.includes("child_a"), `child_a exposed (got ${fields.join(",")})`);
  assert(fields.includes("child_b"), "child_b exposed");
  // 多段路径里的段会 PascalCase 拼接：child_b/same_name → child_bSame_name
  const sameNameItems = cfg.nodes.filter((n) => n.path.startsWith("child_b/same_name"));
  eq(sameNameItems.length, 2, "two same_name siblings exposed");

  const childA = cfg.nodes.find((n) => n.path === "child_a")!;
  const types = (childA.components ?? []).map((c) => c.rawType);
  assert(types.includes("cc.Sprite"), "Sprite exposed");
  assert(types.includes("cc.Label"), "Label exposed");
});

test("validateBindAgainstPrefab: returns no errors for default config", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  const issues = validateBindAgainstPrefab(cfg, parsed);
  const errs = issues.filter((i) => i.level === "error");
  eq(errs.length, 0, `expected no errors, got: ${JSON.stringify(errs)}`);
});

test("validateBindAgainstPrefab: detects missing path", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  cfg.nodes.push({ path: "ghost/node", field: "ghostNode" });
  const issues = validateBindAgainstPrefab(cfg, parsed);
  assert(issues.some((i) => i.level === "error" && i.path === "ghost/node"), "ghost reported");
});

test("generateGenTs: produces parseable TS code", async () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  const code = generateGenTs(cfg, parsed);
  assert(code.includes("AUTO-GENERATED BY genbot"), "header present");
  assert(/import\s*\{[^}]*Sprite[^}]*\}\s*from\s*"cc"/.test(code), "Sprite imported");
  assert(code.includes("NODE_PATHS"), "NODE_PATHS table present");
  assert(code.includes("public bind(root: Node)"), "bind() defined");
  assert(
    code.includes("filter(n => n.name ===") || code.includes("filter((n) => n.name ==="),
    "duplicate-sibling fallback emitted"
  );

  // 用 node:module 的 strip-types 校验语法（22.7+）
  const nm: { stripTypeScriptTypes?: (s: string, o?: object) => string } = await import("node:module");
  if (typeof nm.stripTypeScriptTypes === "function") {
    nm.stripTypeScriptTypes(code, { mode: "strip" });
  }
});

test("CLI fixture round-trip: load + save bind.json is stable", () => {
  const fixturePath = path.resolve(
    __dirname,
    "../../proj-l-commonui/assets/ab/prefab/ui/common_ui.prefab"
  );
  if (!fs.existsSync(fixturePath)) {
    process.stdout.write("    SKIP: fixture not present, skipping round-trip test\n");
    return;
  }
  const parsed = parsePrefabFile(fixturePath);
  assert(parsed.stats.totalNodes > 100, `expected many nodes, got ${parsed.stats.totalNodes}`);

  const tmpBind = path.resolve(__dirname, "output/_round_trip.bind.json");
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "common_ui.prefab",
    outputPath: "common_ui.gen.ts",
  });
  saveBindConfig(tmpBind, cfg);
  const reloaded = loadBindConfig(tmpBind);
  assert(reloaded != null, "reload bind.json");
  eq(reloaded!.nodes.length, cfg.nodes.length, "node count stable");
});

await Promise.all(pending);
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stderr.write(f + "\n");
  process.exit(1);
}
