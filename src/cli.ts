#!/usr/bin/env node
/**
 * genbot CLI
 *
 * 用法：
 *   node dist/cli.js <prefab-path> [options]
 *
 * Options:
 *   --out <dir>          输出目录，默认 prefab 同级
 *   --bind <path>        指定 bind.json 路径，默认 <prefab>.bind.json
 *   --regen-bind         即使 bind.json 已存在，也用默认配置覆盖
 *   --save-bind          没有 bind.json 时把生成的默认配置写盘（默认开）
 *   --no-save-bind       关闭自动落盘默认配置
 *   --dump-tree          打印解析后的节点树
 *   --quiet              静默模式，只在出错时输出
 *
 * 输出：
 *   <out>/<prefabName>.gen.ts
 *   <out>/<prefabName>.bind.json     （首次或 --regen-bind）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parsePrefabFile, dumpTree } from "./parsers/PrefabParser.ts";
import {
  type BindConfig,
  deriveBindJsonPath,
  loadBindConfig,
  makeDefaultBindConfig,
  saveBindConfig,
  validateBindAgainstPrefab,
} from "./generators/BindJsonManager.ts";
import { generateGenTs } from "./generators/GenTsGenerator.ts";
import { writeFileSafe, basenameNoExt } from "./utils/paths.ts";

interface CliArgs {
  prefab: string;
  out?: string;
  bind?: string;
  regenBind: boolean;
  saveBind: boolean;
  dumpTree: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prefab: "",
    regenBind: false,
    saveBind: true,
    dumpTree: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--out":
        args.out = argv[++i];
        break;
      case "--bind":
        args.bind = argv[++i];
        break;
      case "--regen-bind":
        args.regenBind = true;
        break;
      case "--save-bind":
        args.saveBind = true;
        break;
      case "--no-save-bind":
        args.saveBind = false;
        break;
      case "--dump-tree":
        args.dumpTree = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (!args.prefab && !a.startsWith("-")) {
          args.prefab = a;
        } else {
          fail(`unknown argument: ${a}`);
        }
    }
  }
  if (!args.prefab) fail("missing <prefab-path>");
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: genbot <prefab> [options]",
      "",
      "Options:",
      "  --out <dir>      output directory (default: prefab dir)",
      "  --bind <path>    bind.json path (default: <prefab>.bind.json)",
      "  --regen-bind     overwrite existing bind.json with default",
      "  --save-bind      auto save default bind.json when missing (default)",
      "  --no-save-bind   do not write bind.json automatically",
      "  --dump-tree      print parsed node tree to stderr",
      "  --quiet          only print errors",
      "  -h, --help       this help",
      "",
    ].join("\n")
  );
}

function fail(msg: string): never {
  process.stderr.write(`[genbot] ERROR: ${msg}\n`);
  process.exit(1);
}

function log(quiet: boolean, msg: string): void {
  if (!quiet) process.stdout.write(`${msg}\n`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const prefabPath = path.resolve(args.prefab);
  if (!fs.existsSync(prefabPath)) fail(`prefab not found: ${prefabPath}`);

  const t0 = Date.now();
  log(args.quiet, `[genbot] parsing ${prefabPath} ...`);
  const parsed = parsePrefabFile(prefabPath);
  const tParse = Date.now() - t0;
  log(
    args.quiet,
    `[genbot] parsed in ${tParse}ms: ` +
      `${parsed.stats.totalRaw} entries → ${parsed.stats.totalNodes} nodes, ` +
      `${parsed.stats.totalComponents} components ` +
      `(${parsed.stats.unknownComponents} unknown types)`
  );
  if (parsed.stats.unknownTypeNames.length > 0 && !args.quiet) {
    const sample = parsed.stats.unknownTypeNames.slice(0, 5).join(", ");
    const more = parsed.stats.unknownTypeNames.length - 5;
    log(args.quiet, `[genbot]   unknown types: ${sample}${more > 0 ? ` (+${more} more)` : ""}`);
  }

  if (args.dumpTree) {
    process.stderr.write(dumpTree(parsed.root) + "\n");
  }

  const bindPath = args.bind ? path.resolve(args.bind) : deriveBindJsonPath(prefabPath);
  const outDir = args.out ? path.resolve(args.out) : path.dirname(prefabPath);
  const prefabName = basenameNoExt(prefabPath);
  const outFile = path.join(outDir, `${prefabName}.gen.ts`);

  let config: BindConfig;
  let usedDefault = false;
  const existing = !args.regenBind ? loadBindConfig(bindPath) : undefined;
  if (existing) {
    log(args.quiet, `[genbot] loaded bind config: ${bindPath}`);
    config = existing;
    // 校验
    const issues = validateBindAgainstPrefab(config, parsed);
    if (issues.length > 0) {
      const errs = issues.filter((i) => i.level === "error");
      if (errs.length > 0) {
        process.stderr.write(`[genbot] bind config has ${errs.length} error(s):\n`);
        for (const e of errs) {
          process.stderr.write(`  - ${e.message}\n`);
        }
        fail("aborting due to bind validation errors");
      }
      for (const w of issues) {
        process.stderr.write(`[genbot] WARN: ${w.message}\n`);
      }
    }
  } else {
    log(args.quiet, `[genbot] no bind config found, creating default ...`);
    usedDefault = true;
    // prefab 相对路径：尝试相对 cwd
    const prefabRel = path.relative(process.cwd(), prefabPath).replace(/\\/g, "/");
    const outRel = path.relative(process.cwd(), outFile).replace(/\\/g, "/");
    config = makeDefaultBindConfig(parsed, {
      prefabRelativePath: prefabRel,
      outputPath: outRel,
    });
    if (args.saveBind) {
      saveBindConfig(bindPath, config);
      log(args.quiet, `[genbot] wrote default bind config: ${bindPath}`);
    }
  }

  // 生成 gen.ts
  const code = generateGenTs(config, parsed, { toolVersion: "0.1.0" });
  writeFileSafe(outFile, code);
  log(args.quiet, `[genbot] wrote ${outFile} (${code.length} bytes)`);
  log(
    args.quiet,
    `[genbot] done in ${Date.now() - t0}ms${usedDefault ? " (default config)" : ""}`
  );
}

try {
  main();
} catch (e) {
  fail((e as Error).stack ?? String(e));
}
