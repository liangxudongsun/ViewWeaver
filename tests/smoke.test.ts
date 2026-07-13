// Lightweight, framework-free smoke tests for ViewWeaver.
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
import {
  inferProjectRoot,
  looksLikeCocosRoot,
  resolvePrefabLayout,
  resolveRegistryPath,
  VIEWWEAVER_ROOT_REL,
  REGISTRY_REL,
} from "../src/core/ProjectLayout.ts";
import { RegistryManager, type RegistryEntry } from "../src/core/RegistryManager.ts";
import { runOnce } from "../src/core/RunOnce.ts";
import {
  compressUuid,
  decompressUuid,
  isCompressedUuid,
  isFullUuid,
  normalizeUuid,
} from "../src/core/UuidCompress.ts";
import { extractClassFromContent } from "../src/core/TsClassExtractor.ts";
import { scanTsMeta } from "../src/core/TsMetaScanner.ts";
import { ScriptTypeRegistry } from "../src/core/ScriptTypeRegistry.ts";

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

test("makeDefaultBindConfig: button-only default — skips non-button nodes", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  // 默认规则下，只有挂了 cc.Button 的节点才会被纳入；
  // synthetic 里只有 child_b/same_name(0) 是 Button 节点。
  eq(cfg.nodes.length, 1, `expected exactly 1 button node, got ${cfg.nodes.length}`);
  const entry = cfg.nodes[0];
  eq(entry.path, "child_b/same_name", "the button-bearing node is selected");
  // 默认 exposeNode=false（业务侧拿 Node 用 .node 即可）
  eq(entry.exposeNode, false, "node ref not exposed by default");
  // 第一个组件用基础名（最好看）
  eq(entry.components?.length, 1, "single Button component exposed");
  eq(entry.components![0].rawType, "cc.Button", "rawType is Button");
  eq(entry.components![0].field, entry.field, "first component reuses base field name");
});

test("makeDefaultBindConfig: triggerBuiltinTypes=null restores 'expose every named node'", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
    triggerBuiltinTypes: null, // 取消触发限制 → 任何节点都可暴露
    exposedBuiltinTypes: new Set(["cc.Sprite", "cc.Label", "cc.Button"]),
    exposeTriggerNode: true,
  });
  const paths = cfg.nodes.map((n) => n.path);
  assert(paths.includes("child_a"), `child_a exposed (got ${paths.join(",")})`);
  assert(paths.includes("child_b/same_name"), "first same_name exposed");
  assert(paths.includes("child_b/same_name(1)"), "second same_name exposed");
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

test("generateGenTs: button-only default produces parseable TS with Button import", async () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  const code = generateGenTs(cfg, parsed);
  assert(code.includes("AUTO-GENERATED by ViewWeaver"), "header present");
  assert(/import\s*\{[^}]*Button[^}]*\}\s*from\s*"cc"/.test(code), "Button imported");
  assert(code.includes("NODE_PATHS"), "NODE_PATHS table present");
  assert(code.includes("public bind(root: Node)"), "bind() defined");

  const nm: { stripTypeScriptTypes?: (s: string, o?: object) => string } = await import("node:module");
  if (typeof nm.stripTypeScriptTypes === "function") {
    nm.stripTypeScriptTypes(code, { mode: "strip" });
  }
});

test("generateGenTs: gen.ts implements IView contract (no duck typing)", () => {
  // 这条契约保护：消费侧（Tester / Presenter / 加载器）依赖 IView 接口而不是
  // ad-hoc `Component & { bind?: ... }`。如果生成器漏写 implements，编译期不会
  // 报错（结构等价仍然通过），但消费侧的"接口约定"承诺就破了 —— 故在此显式断言。
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  const code = generateGenTs(cfg, parsed);

  // 1. import 顶部必须 import IView
  assert(
    /import\s+type\s*\{\s*IView\s*\}\s*from\s*"\.\.\/IView"/.test(code),
    "should import IView type from ../IView"
  );

  // 2. class 声明必须 implements IView（与 extends Component 同行）
  assert(
    /export\s+class\s+_\w+\s+extends\s+Component\s+implements\s+IView\s*\{/.test(code),
    "generated _XxxView class should `extends Component implements IView`"
  );

  // 3. bind 签名要兼容 IView.bind(root: Node)：参数 root: Node 必须存在
  assert(
    /public\s+bind\s*\(\s*root\s*:\s*Node\s*\)/.test(code),
    "bind signature must take (root: Node) to satisfy IView.bind"
  );
});

test("generateGenTs: emits onClickXxx hook + Button.EventType.CLICK binding for cc.Button", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  const code = generateGenTs(cfg, parsed);
  // gen.ts 内部类用下划线前缀，且 extends Component
  assert(/export class\s+_\w+View\s+extends\s+Component/.test(code),
    `gen.ts should declare 'export class _XxxView extends Component'; got:\n${code.slice(0, 600)}`);
  // 默认规则下 child_b/same_name(0) 是唯一 button 节点 → 字段名按路径派生
  // 我们只断言"存在 onClick<X>(): void {} 钩子"和它的字段是同一个名字，避免硬编码字段命名规则
  const fieldMatch = /public readonly\s+(\w+)!:\s*Button;/.exec(code);
  assert(fieldMatch != null, `expected a Button field; got:\n${code}`);
  const field = fieldMatch![1];
  const hookName = "onClick" + field.charAt(0).toUpperCase() + field.slice(1);
  const hookRe = new RegExp(`protected\\s+${hookName}\\s*\\(\\s*\\)\\s*:\\s*void\\s*\\{`);
  assert(hookRe.test(code), `expected ${hookName} hook; got:\n${code}`);
  // bind() 应注册 Button.EventType.CLICK，并把 w[<hookName>] 当作 listener
  assert(/Button\.EventType\.CLICK/.test(code), `expected Button.EventType.CLICK; got:\n${code}`);
  const dispatchRe = new RegExp(`w\\.${hookName}\\b`);
  assert(dispatchRe.test(code), `expected dispatch via w.${hookName}; got:\n${code}`);
});

test("makeDefaultBindConfig: a Button subclass triggers node export, but ButtonScale-like custom does NOT", () => {
  // 合成一个 prefab：A 节点挂"假装继承 Button"的自定义 + 一个 Button 子类节点；
  //                  B 节点只挂"普通自定义脚本"（既不是 Button 也不是 Button 子类）。
  // 期望默认规则下：A 进入导出（因为 isButton=true）、B 不进入。
  const data: unknown[] = [
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
      _name: "withButtonSubclass",
      _parent: { __id__: 1 },
      _children: [],
      _components: [{ __id__: 4 }],
      _active: true,
    },
    /* 3 */ {
      __type__: "cc.Node",
      _name: "withPlainCustom",
      _parent: { __id__: 1 },
      _children: [],
      _components: [{ __id__: 5 }],
      _active: true,
    },
    /* 4 */ { __type__: "FAKE_UUID_BUTTON_SUB", node: { __id__: 2 }, _enabled: true },
    /* 5 */ { __type__: "FAKE_UUID_PLAIN", node: { __id__: 3 }, _enabled: true },
  ];
  const parsed = parsePrefab(data as never);
  // 模拟 ScriptTypeRegistry 解析出的 typeInfo：手动注入到 component
  for (const c of parsed.allComponents) {
    if (c.rawType === "FAKE_UUID_BUTTON_SUB") {
      c.typeInfo = {
        tsName: "MyMenuButton",
        importFrom: "./MyMenuButton",
        builtin: false,
        extendsClassName: "Button",
        isButton: true,
      };
    } else if (c.rawType === "FAKE_UUID_PLAIN") {
      c.typeInfo = {
        tsName: "ButtonScale",
        importFrom: "./ButtonScale",
        builtin: false,
        extendsClassName: "Component",
        isButton: false,
      };
    }
  }
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  const paths = cfg.nodes.map((n) => n.path);
  assert(paths.includes("withButtonSubclass"),
    `Button-subclass node should be exported by default; got ${JSON.stringify(paths)}`);
  assert(!paths.includes("withPlainCustom"),
    `non-button custom (ButtonScale-like) should NOT trigger export; got ${JSON.stringify(paths)}`);
  // 该节点的导出组件就是这个 Button 子类
  const entry = cfg.nodes.find((n) => n.path === "withButtonSubclass")!;
  eq(entry.components?.length, 1, "single Button-subclass component exposed");
  eq(entry.components![0].rawType, "FAKE_UUID_BUTTON_SUB", "exposed component is the subclass");
});

test("generateViewTs: emits 'export class XxxView extends _XxxView' header", async () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
  });
  const { generateViewTs } = await import("../src/generators/ViewTsGenerator.ts");
  const view = generateViewTs(cfg);
  // 头部声明明确"开发者可改、工具不会覆盖"
  assert(/THIS FILE IS YOURS TO EDIT/.test(view), "view.ts header marks ownership");
  // 类名 = viewClassName，extends gen.ts 内部类 _viewClassName
  const pattern = new RegExp(`export class\\s+${cfg.viewClassName}\\s+extends\\s+_${cfg.viewClassName}\\b`);
  assert(pattern.test(view), `view.ts should extend _${cfg.viewClassName}; got:\n${view}`);
  // import 路径默认指向同目录的 .gen 文件
  assert(/from\s+"\.\/panel\.gen"/.test(view), `view.ts should import from "./panel.gen"; got:\n${view}`);
});

test("runOnce: view.ts is generate-once — second run keeps user edits", async () => {
  const projectRoot = path.resolve(__dirname, "../../..");
  const prefab = path.join(
    projectRoot,
    "extensions/proj-l-commonui/assets/ab/prefab/ui/common_ui.prefab"
  );
  if (!fs.existsSync(prefab)) {
    process.stdout.write("    SKIP: real project not present\n");
    return;
  }
  if (!fs.existsSync(path.join(projectRoot, "assets")) || !fs.existsSync(path.join(projectRoot, "settings"))) {
    process.stdout.write("    SKIP: not a Cocos project root\n");
    return;
  }
  // 用临时 outDir 隔离，不污染真实项目
  const tmpDir = path.join(__dirname, ".tmp-view-once");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // 第一次：view.ts 应当被新建
    const r1 = runOnce({
      prefabPath: prefab,
      outDir: tmpDir,
      bindPath: path.join(tmpDir, "common_ui.bind.json"),
      projectRoot,
      mode: "write",
      regenBind: true,
    });
    assert(r1.ok, "first run ok");
    eq(r1.viewStatus, "created", "first run creates view.ts");
    assert(fs.existsSync(r1.viewFile), "view.ts written to disk");

    // 模拟开发者改了 view.ts —— 加一行 marker
    const userMarker = "// >>> USER EDIT MARKER <<<";
    fs.appendFileSync(r1.viewFile, "\n" + userMarker + "\n");

    // 第二次：view.ts 应保留，gen.ts 仍重写
    const r2 = runOnce({
      prefabPath: prefab,
      outDir: tmpDir,
      bindPath: path.join(tmpDir, "common_ui.bind.json"),
      projectRoot,
      mode: "write",
    });
    assert(r2.ok, "second run ok");
    eq(r2.viewStatus, "skipped-exists", "second run keeps user view.ts");
    const onDisk = fs.readFileSync(r2.viewFile, "utf8");
    assert(onDisk.includes(userMarker), "user edits preserved across re-runs");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test("generateGenTs: emits sibling-dedup fallback when same-name siblings are both exposed", () => {
  const parsed = parsePrefab(buildSyntheticPrefab() as never);
  // 强制走「全暴露」路径，让两个 same_name 都进配置
  const cfg = makeDefaultBindConfig(parsed, {
    prefabRelativePath: "panel.prefab",
    outputPath: "panel.gen.ts",
    triggerBuiltinTypes: null,
    exposedBuiltinTypes: new Set(["cc.Sprite", "cc.Label", "cc.Button"]),
    exposeTriggerNode: true,
  });
  const code = generateGenTs(cfg, parsed);
  assert(
    code.includes("filter(n => n.name ===") || code.includes("filter((n) => n.name ==="),
    "duplicate-sibling fallback emitted"
  );
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

// --- v0.2 core tests --------------------------------------------------------

test("ProjectLayout: resolvePrefabLayout produces expected paths", () => {
  const projectRoot = path.resolve(__dirname, "fixtures/_fake_project_a");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "settings"), { recursive: true });

  const layout = resolvePrefabLayout({ projectRoot, prefabName: "common_ui" });
  eq(layout.prefabName, "common_ui");
  assert(layout.outDir.endsWith(path.join(VIEWWEAVER_ROOT_REL.replace(/\//g, path.sep), "common_ui")));
  assert(layout.genTsRel === "assets/scripts/views/common_ui/common_ui.gen.ts", layout.genTsRel);
  assert(layout.bindJsonRel === "assets/scripts/views/common_ui/common_ui.bind.json");
  eq(resolveRegistryPath(projectRoot), path.join(projectRoot, REGISTRY_REL));
});

test("ProjectLayout: rejects illegal prefab names", () => {
  const projectRoot = path.resolve(__dirname, "fixtures/_fake_project_a");
  let caught = false;
  try {
    resolvePrefabLayout({ projectRoot, prefabName: "../etc" });
  } catch {
    caught = true;
  }
  assert(caught, "expected to reject path-traversal prefab name");
});

test("ProjectLayout: looksLikeCocosRoot true only with assets/ + settings/", () => {
  const a = path.resolve(__dirname, "fixtures/_fake_project_a"); // both
  const b = path.resolve(__dirname, "fixtures/_fake_subext_b"); // only assets/
  fs.mkdirSync(b, { recursive: true });
  fs.mkdirSync(path.join(b, "assets"), { recursive: true });
  assert(looksLikeCocosRoot(a) === true, "true for both");
  assert(looksLikeCocosRoot(b) === false, "false for only assets/");
});

test("ProjectLayout: inferProjectRoot skips sub-extensions, finds outermost root", () => {
  // 模拟 proj-l-client/extensions/proj-l-commonui/assets/ab/prefab/x.prefab 这种结构
  const root = path.resolve(__dirname, "fixtures/_fake_project_a");
  fs.mkdirSync(path.join(root, "extensions/sub/assets/ab"), { recursive: true });
  // sub 没有 settings/，inferProjectRoot 应该跳过它，找到外层 root
  const fakePrefab = path.join(root, "extensions/sub/assets/ab/x.prefab");
  fs.writeFileSync(fakePrefab, "[]", "utf8");
  const inferred = inferProjectRoot(fakePrefab);
  eq(inferred, root, "inferred outer root");
});

test("RegistryManager: upsert + get + remove", () => {
  const projectRoot = path.resolve(__dirname, "fixtures/_fake_project_a");
  // clean
  const regPath = resolveRegistryPath(projectRoot);
  try {
    fs.rmSync(regPath, { force: true });
  } catch {
    /* ignore */
  }

  const reg = new RegistryManager(projectRoot);
  const entry: RegistryEntry = {
    prefabName: "demo_x",
    prefabPath: "assets/foo/demo_x.prefab",
    genTsPath: "assets/scripts/views/demo_x/demo_x.gen.ts",
    bindJsonPath: "assets/scripts/views/demo_x/demo_x.bind.json",
    viewClassName: "Demo_xPrefabView",
    lastGenAt: new Date().toISOString(),
    lastGenBy: "test",
  };
  reg.upsert(entry);

  const got = reg.get("demo_x");
  assert(got != null, "entry persisted");
  eq(got!.viewClassName, "Demo_xPrefabView");

  // upsert again with new data overwrites
  reg.upsert({ ...entry, viewClassName: "Demo_xPrefabView2" });
  eq(reg.get("demo_x")!.viewClassName, "Demo_xPrefabView2", "overwrite ok");

  // remove
  assert(reg.remove("demo_x") === true, "remove returns true");
  assert(reg.get("demo_x") === undefined, "entry gone");
  assert(reg.remove("demo_x") === false, "remove missing returns false");
});

test("RegistryManager: corrupt registry is backed up + reset", () => {
  const projectRoot = path.resolve(__dirname, "fixtures/_fake_project_a");
  const regPath = resolveRegistryPath(projectRoot);
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(regPath, '{"bogus":true}', "utf8");

  const reg = new RegistryManager(projectRoot);
  const file = reg.load();
  eq(file.tool, "viewweaver");
  eq(Object.keys(file.entries).length, 0, "reset to empty");
  // 应该备份过损坏文件
  const backups = fs
    .readdirSync(path.dirname(regPath))
    .filter((n) => n.startsWith("__registry.json.broken."));
  assert(backups.length >= 1, "broken backup created");
  // 清理备份避免污染
  for (const b of backups) fs.unlinkSync(path.join(path.dirname(regPath), b));
});

test("runOnce: dry-run does not write files", () => {
  const fixturePath = path.resolve(
    __dirname,
    "../../proj-l-commonui/assets/ab/prefab/ui/common_ui.prefab"
  );
  if (!fs.existsSync(fixturePath)) {
    process.stdout.write("    SKIP: fixture not present\n");
    return;
  }
  const projectRoot = path.resolve(__dirname, "fixtures/_fake_project_dryrun");
  fs.mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "settings"), { recursive: true });
  const layout = resolvePrefabLayout({ projectRoot, prefabName: "common_ui" });

  const result = runOnce({
    prefabPath: fixturePath,
    outDir: layout.outDir,
    bindPath: layout.bindJsonPath,
    mode: "dry-run",
  });
  assert(result.ok, "ok");
  assert(result.code.length > 0, "code generated");
  assert(!fs.existsSync(layout.genTsPath), "gen.ts NOT written in dry-run");
  assert(!fs.existsSync(layout.bindJsonPath), "bind.json NOT written in dry-run");
});

// =============================================================================
// 阶段 3：自定义脚本类型识别
// =============================================================================

test("UuidCompress: real example round-trip", () => {
  const full = "53f930ad-6071-4f7c-a838-ed8d3b9bf350";
  const compressed = compressUuid(full);
  eq(compressed, "53f93CtYHFPfKg47Y07m/NQ", "matches cocos prefab __type__ form");
  eq(isCompressedUuid(compressed), true);
  eq(isFullUuid(full), true);
  eq(decompressUuid(compressed), normalizeUuid(full), "round-trip");
});

test("UuidCompress: rejects bad input", () => {
  let threw = false;
  try {
    compressUuid("not-a-uuid");
  } catch {
    threw = true;
  }
  assert(threw, "compressUuid throws on bad input");

  eq(isCompressedUuid("123"), false);
  eq(isCompressedUuid("53f930ad-6071-4f7c-a838-ed8d3b9bf350"), false);
  eq(isFullUuid("53f93CtYHFPfKg47Y07m/NQ"), false);
});

test("TsClassExtractor: typical Cocos component", () => {
  const src = `
import { _decorator, Component } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('CommonUI')
export class CommonUI extends Component {
    public foo: number = 0;
}
`;
  const info = extractClassFromContent(src, "/fake/CommonUI.ts");
  assert(info != null, "info found");
  eq(info!.className, "CommonUI");
  eq(info!.ccclassName, "CommonUI");
  eq(info!.isExported, true);
  eq(info!.isDefault, false);
});

test("TsClassExtractor: bare @ccclass without parens", () => {
  const src = `
import { _decorator, Component } from 'cc';
@_decorator.ccclass
export class Foo extends Component {}
`;
  // 注意：这种形式我们用的是 @ccclass 关键字（不含 _decorator. 前缀）
  const src2 = `
const { ccclass } = _decorator;
@ccclass
export class Bar extends Component {}
`;
  const info = extractClassFromContent(src2, "/fake/Bar.ts");
  assert(info != null, "info found for bare @ccclass");
  eq(info!.className, "Bar");
  eq(info!.ccclassName, "Bar", "fallback ccclassName == className");
});

test("TsClassExtractor: returns undefined for non-Cocos files", () => {
  const src = `export class NotACocosComponent {}`;
  const info = extractClassFromContent(src, "/fake/x.ts");
  assert(info == null, "no @ccclass → undefined");
});

test("TsClassExtractor: handles other decorators between @ccclass and class", () => {
  const src = `
@ccclass('Mixed')
@executeInEditMode
@menu('UI/Mixed')
export class Mixed extends Component {}
`;
  const info = extractClassFromContent(src, "/fake/Mixed.ts");
  assert(info != null, "info found through multiple decorators");
  eq(info!.className, "Mixed");
  eq(info!.ccclassName, "Mixed");
});

test("TsMetaScanner + ScriptTypeRegistry: end-to-end on synthetic fixture", () => {
  // 准备一个临时项目：assets/scripts/Foo.ts + .ts.meta，extensions/sub/Bar.ts + .ts.meta
  const root = path.resolve(__dirname, "fixtures/_fake_scripts_proj");
  const assetsScripts = path.join(root, "assets/scripts");
  const extSubAssets = path.join(root, "extensions/sub/assets/components");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(assetsScripts, { recursive: true });
  fs.mkdirSync(extSubAssets, { recursive: true });
  fs.mkdirSync(path.join(root, "settings"), { recursive: true });

  // Foo.ts — uuid: 53f930ad-6071-4f7c-a838-ed8d3b9bf350
  const fooUuid = "53f930ad-6071-4f7c-a838-ed8d3b9bf350";
  fs.writeFileSync(
    path.join(assetsScripts, "Foo.ts"),
    `
import { _decorator, Component } from 'cc';
const { ccclass } = _decorator;
@ccclass('Foo')
export class Foo extends Component {}
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(assetsScripts, "Foo.ts.meta"),
    JSON.stringify({ ver: "4.0.24", importer: "typescript", uuid: fooUuid }),
    "utf8"
  );

  // Bar.ts — uuid: aa11bb22-cc33-44dd-55ee-66ff7788aabb
  const barUuid = "aa11bb22-cc33-44dd-55ee-66ff7788aabb";
  fs.writeFileSync(
    path.join(extSubAssets, "Bar.ts"),
    `
import { _decorator, Component } from 'cc';
const { ccclass } = _decorator;
@ccclass('Bar')
export class Bar extends Component {}
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(extSubAssets, "Bar.ts.meta"),
    JSON.stringify({ ver: "4.0.24", importer: "typescript", uuid: barUuid }),
    "utf8"
  );

  // 扫描器结果
  const scan = scanTsMeta({ projectRoot: root });
  eq(scan.count, 2, "two .ts.meta found");
  assert(scan.byUuid.has(normalizeUuid(fooUuid)), "Foo uuid indexed");
  assert(scan.byCompressed.has(compressUuid(fooUuid)), "Foo compressed indexed");

  // 注册表 resolve
  const reg = new ScriptTypeRegistry(root);
  const genTsAbsPath = path.join(root, "assets/scripts/views/x/x.gen.ts");
  const fooInfo = reg.resolve(compressUuid(fooUuid), { genTsAbsPath });
  assert(fooInfo != null, "Foo resolved by compressed uuid");
  eq(fooInfo!.tsName, "Foo");
  eq(fooInfo!.builtin, false);
  eq(fooInfo!.importFrom, "../../Foo");

  // 跨目录的 Bar
  const barInfo = reg.resolve(compressUuid(barUuid), { genTsAbsPath });
  assert(barInfo != null, "Bar resolved");
  eq(barInfo!.tsName, "Bar");
  eq(
    barInfo!.importFrom,
    "../../../../extensions/sub/assets/components/Bar",
    "import path traverses out of assets/ into extensions/"
  );

  // 找不到的 UUID 返回 undefined
  const ghost = reg.resolve(compressUuid("00000000-0000-0000-0000-000000000000"), { genTsAbsPath });
  assert(ghost == null, "missing uuid returns undefined");
});

test("ScriptTypeRegistry: handles export default; ignores non-exported", () => {
  const root = path.resolve(__dirname, "fixtures/_fake_scripts_default");
  const assetsScripts = path.join(root, "assets/scripts");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(assetsScripts, { recursive: true });
  fs.mkdirSync(path.join(root, "settings"), { recursive: true });

  // export default class — 应当被解析，并标记 isDefaultExport
  const u1 = "11111111-2222-3333-4444-555555555555";
  fs.writeFileSync(
    path.join(assetsScripts, "Default.ts"),
    `import { _decorator, Component } from 'cc';
const { ccclass } = _decorator;
@ccclass('Default')
export default class Default extends Component {}`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(assetsScripts, "Default.ts.meta"),
    JSON.stringify({ ver: "4.0.24", importer: "typescript", uuid: u1 }),
    "utf8"
  );

  // 非 export：纯内部类，跳过
  const u2 = "22222222-3333-4444-5555-666666666666";
  fs.writeFileSync(
    path.join(assetsScripts, "Internal.ts"),
    `import { _decorator, Component } from 'cc';
const { ccclass } = _decorator;
@ccclass('Internal')
class Internal extends Component {}`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(assetsScripts, "Internal.ts.meta"),
    JSON.stringify({ ver: "4.0.24", importer: "typescript", uuid: u2 }),
    "utf8"
  );

  const reg = new ScriptTypeRegistry(root);
  const genTsAbsPath = path.join(root, "assets/scripts/views/x/x.gen.ts");
  const def = reg.resolve(compressUuid(u1), { genTsAbsPath });
  assert(def != null, "export default class is now resolved");
  eq(def!.tsName, "Default");
  eq(def!.isDefaultExport, true, "isDefaultExport flagged");
  eq(def!.builtin, false);

  eq(reg.resolve(compressUuid(u2), { genTsAbsPath }), undefined, "non-export skipped");
});

test("runOnce: integration on real proj-l-client common_ui.prefab", () => {
  // 这个测试要真实项目根存在；若不在则跳过
  const projectRoot = path.resolve(__dirname, "../../..");
  const prefab = path.join(
    projectRoot,
    "extensions/proj-l-commonui/assets/ab/prefab/ui/common_ui.prefab"
  );
  if (!fs.existsSync(prefab)) {
    process.stdout.write("    SKIP: real project not present\n");
    return;
  }
  if (!fs.existsSync(path.join(projectRoot, "assets")) || !fs.existsSync(path.join(projectRoot, "settings"))) {
    process.stdout.write("    SKIP: not a Cocos project root\n");
    return;
  }
  const layout = resolvePrefabLayout({ projectRoot, prefabName: "common_ui" });
  const result = runOnce({
    prefabPath: prefab,
    outDir: layout.outDir,
    bindPath: layout.bindJsonPath,
    projectRoot,
    mode: "dry-run",
    // 测试要拿到新生成的默认 config（含自定义脚本组件），强制不读已有 bind.json
    regenBind: true,
  });
  assert(result.ok, "runOnce ok");
  assert(result.scriptResolve != null, "scriptResolve stats present");
  // common_ui.prefab 在当前项目里有 60 个 unknown 组件实例，跨多个唯一类型
  const sr = result.scriptResolve!;
  process.stdout.write(
    `         resolved ${sr.resolved}/${sr.totalUnknown} instances ` +
      `(${sr.uniqueResolvedTypes}/${sr.uniqueResolvedTypes + sr.uniqueUnresolvedTypes} unique types, ` +
      `${sr.tsMetaFiles} ts.meta in ${sr.scanMs}ms)\n`
  );
  assert(sr.resolved > 0, `expected at least 1 resolved, got ${sr.resolved}`);
  // common_ui.prefab 实测有 4 个唯一自定义类型（CommonUI/L10nLabel/...），都应解析出来
  assert(
    sr.uniqueResolvedTypes >= 3,
    `expected ≥3 unique types resolved, got ${sr.uniqueResolvedTypes}`
  );
  // 实例覆盖率应当 >= 80%
  const coverage = sr.resolved / sr.totalUnknown;
  assert(coverage >= 0.8, `instance coverage too low: ${(coverage * 100).toFixed(1)}%`);
  // 默认规则只导 cc.Button + Button 子类，所以生成代码里:
  //   · 一定 import cc.Button
  //   · 应当生成 view.ts 内容（首次或 dry-run）
  //   · 不再要求出现自定义脚本 import（除非项目里有 Button 子类）
  assert(/\bButton\b/.test(result.code), "gen.ts should import Button when buttons are exposed");
  assert(result.viewCode.length > 0, "view.ts code should be rendered (dry-run)");
  assert(
    /export class\s+\w+View\s+extends\s+_\w+View/.test(result.viewCode),
    `view.ts should declare 'export class XxxView extends _XxxView'; got:\n${result.viewCode.slice(0, 400)}`
  );
});

await Promise.all(pending);
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const f of failures) process.stderr.write(f + "\n");
  process.exit(1);
}
