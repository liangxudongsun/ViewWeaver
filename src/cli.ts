#!/usr/bin/env node
/**
 * ViewWeaver CLI（v0.2 重构版）
 *
 * 行为变化：
 * - 输出位置不再默认 prefab 同级，而是写到 <project>/assets/scripts/views/<prefabName>/
 * - 自动维护 <project>/assets/scripts/views/__registry.json
 * - 项目根优先取 --project，未传则从 prefab 路径向上推断（找到含 assets/ 的目录）
 *
 * 用法：
 *   node --experimental-strip-types src/cli.ts <prefab> [options]
 *
 * Options:
 *   --project <dir>      项目根目录（含 assets/）。未传则自动推断
 *   --out <dir>          覆盖默认输出目录（绝对路径），仅 debug 用
 *   --bind <path>        覆盖 bind.json 路径，仅 debug 用
 *   --regen-bind         即使 bind.json 已存在，也用默认配置覆盖
 *   --no-save-bind       关闭 bind.json 自动落盘
 *   --dry-run            只解析与生成代码，不写盘（不更新 registry）
 *   --dump-tree          打印解析后的节点树到 stderr
 *   --quiet              静默模式
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { runOnce, runDumpTree, type Logger, TOOL_VERSION } from "./core/RunOnce.ts";
import {
  inferProjectRoot,
  resolvePrefabLayout,
} from "./core/ProjectLayout.ts";
import { RegistryManager, type RegistryEntry } from "./core/RegistryManager.ts";
import { basenameNoExt } from "./utils/paths.ts";

interface CliArgs {
  prefab: string;
  project?: string;
  out?: string;
  bind?: string;
  regenBind: boolean;
  saveBind: boolean;
  dumpTree: boolean;
  dryRun: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prefab: "",
    regenBind: false,
    saveBind: true,
    dumpTree: false,
    dryRun: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--project":
        args.project = argv[++i];
        break;
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
      case "--dry-run":
        args.dryRun = true;
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
      `ViewWeaver v${TOOL_VERSION} — Cocos prefab View 代码生成工具`,
      "",
      "Usage: viewweaver <prefab> [options]",
      "",
      "Options:",
      "  --project <dir>     project root (default: auto-detect from prefab path)",
      "  --out <dir>         override output dir (debug)",
      "  --bind <path>       override bind.json path (debug)",
      "  --regen-bind        overwrite existing bind.json with default",
      "  --no-save-bind      do not auto-save default bind.json",
      "  --dry-run           parse + generate but do not write to disk",
      "  --dump-tree         print parsed node tree to stderr",
      "  --quiet             only print errors",
      "  -h, --help          this help",
      "",
    ].join("\n")
  );
}

function fail(msg: string): never {
  process.stderr.write(`[viewweaver] ERROR: ${msg}\n`);
  process.exit(1);
}

function buildLogger(quiet: boolean): Logger {
  return {
    info: (m) => !quiet && process.stdout.write(`[viewweaver] ${m}\n`),
    warn: (m) => process.stderr.write(`[viewweaver] WARN: ${m}\n`),
    error: (m) => process.stderr.write(`[viewweaver] ERROR: ${m}\n`),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const prefabPath = path.resolve(args.prefab);
  if (!fs.existsSync(prefabPath)) fail(`prefab not found: ${prefabPath}`);
  if (!prefabPath.endsWith(".prefab")) {
    process.stderr.write(`[viewweaver] WARN: file extension is not .prefab — proceeding anyway\n`);
  }

  // 1. 推断项目根
  const projectRoot = args.project
    ? path.resolve(args.project)
    : inferProjectRoot(prefabPath);
  if (!projectRoot) {
    fail(
      `cannot infer project root from prefab path. ` +
        `pass --project <dir> explicitly. prefab=${prefabPath}`
    );
  }

  // 2. 计算输出布局
  const prefabName = basenameNoExt(prefabPath);
  const layout = resolvePrefabLayout({ projectRoot, prefabName });
  const outDir = args.out ? path.resolve(args.out) : layout.outDir;
  const bindPath = args.bind ? path.resolve(args.bind) : layout.bindJsonPath;

  if (args.dumpTree) {
    process.stderr.write(runDumpTree(prefabPath) + "\n");
  }

  // 3. 跑核心生成流程
  const logger = buildLogger(args.quiet);
  const result = runOnce({
    prefabPath,
    outDir,
    bindPath,
    regenBind: args.regenBind,
    saveBindIfMissing: args.saveBind,
    mode: args.dryRun ? "dry-run" : "write",
    logger,
    toolVersion: TOOL_VERSION,
  });

  if (!result.ok) {
    fail(result.error?.message ?? "unknown error");
  }

  // 4. 更新 registry（dry-run 不更新）
  if (!args.dryRun) {
    const registry = new RegistryManager(projectRoot);
    const entry: RegistryEntry = {
      prefabName: layout.prefabName,
      prefabPath: relPosix(projectRoot, prefabPath),
      genTsPath: relPosix(projectRoot, result.outFile),
      bindJsonPath: relPosix(projectRoot, result.bindPath),
      viewTsPath: relPosix(projectRoot, result.viewFile),
      viewClassName: result.config.viewClassName,
      lastGenAt: new Date().toISOString(),
      lastGenBy: "cli",
    };
    registry.upsert(entry);
    if (!args.quiet) {
      process.stdout.write(`[viewweaver] registry updated: ${registry.path}\n`);
    }
  }
}

function relPosix(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, "/");
}

try {
  main();
} catch (e) {
  fail((e as Error).stack ?? String(e));
}
