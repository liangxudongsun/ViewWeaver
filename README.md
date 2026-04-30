# genbot

Cocos Creator 编辑器扩展，根据 prefab 自动生成强类型的 View 绑定代码 (`*.gen.ts`)，配合手写 View (`*.ts`) 形成可编译校验的「prefab 契约」。

> 项目目标见 `proj-l-client/ui-framework-design.md` §3.5。

## 核心思路

```
common_ui.prefab               (美术维护，节点结构自由)
        │
        │  程序员通过编辑器面板勾选要导出的节点
        ▼
common_ui.bind.json            (导出契约，进 Git，独立于 prefab)
        │
        │  扩展或 CLI 自动生成
        ▼
common_ui.gen.ts               (强类型 PrefabView，禁止手改)
        │
        │  程序员手写
        ▼
CommonUIView.ts                (业务 View，组合 PrefabView)
```

## 当前进度（v0.1）

- [x] 仓库初始化（Node 22 strip-types，零依赖跑通）
- [x] PrefabParser：解析 Cocos prefab JSON 为节点树（含同名兄弟消歧）
- [x] ComponentTypeMap：内置 cc.*/sp.*/dragonBones.* 常用组件识别
- [x] BindJsonManager：默认 bind 配置生成 / 加载 / 保存 / 校验
- [x] GenTsGenerator：根据 bind 输出 `.gen.ts`，含 NODE_PATHS 常量与 bind() 方法
- [x] CLI 入口：`node --experimental-strip-types src/cli.ts <prefab> [options]`
- [x] smoke.test.ts：7 用例覆盖 parser / config / validation / generator
- [x] 用 `common_ui.prefab`（524 节点 / 1160 组件）端到端验证
- [ ] v0.2 编辑器面板（GUI 选择导出节点）
- [ ] v0.2 自定义脚本类型解析（依赖 `assets/scripts` 下的 `.ts.meta` 反查类名）
- [ ] v0.2 build 脚本（npm/tsc 输出 dist/，供 Cocos Editor 加载）

### v0.1 实测数据（common_ui.prefab）

| 项 | 值 |
|---|---|
| prefab 总条目 | 3737 |
| 节点数 | 524 |
| 组件数 | 1160 |
| 未识别组件类型 | 60 实例 / 4 种（全部为业务自定义脚本 UUID，符合预期） |
| 解析耗时 | ~12ms |
| 生成 .gen.ts | 406KB / ~3500 行 |
| 端到端总耗时 | ~25ms |

## 开发

仓库工作目录：`d:\UGit\proj-l-client\extensions\genbot\`
（嵌入主项目方便用真实 prefab 调试，但 `.git` 指向 gitlab 的 `extension-tools/genbot`，不进 proj-l-client 主仓库。）

### 当前状态：仅需 Node 22+，无第三方依赖

v0.1 利用 Node 22 内置的 `--experimental-strip-types` 直接执行 TypeScript，
开发期不需要 npm install / tsc。后续需要打包成 Cocos 扩展时再补 build 脚本。

```bash
# 跑 CLI
node --experimental-strip-types src/cli.ts <prefab-path> [options]

# 跑 smoke 测试
node --experimental-strip-types tests/smoke.test.ts

# 用真实 common_ui.prefab 验证
node --experimental-strip-types src/cli.ts ^
  ../proj-l-commonui/assets/ab/prefab/ui/common_ui.prefab ^
  --no-save-bind --out tests/output
```

CLI 行为：
1. 解析 prefab，构建节点树
2. 若同名 `.bind.json` 存在则加载并校验，否则生成默认配置（导出全部命名节点 + cc.* 白名单组件）
3. 生成 `<prefab_name>.gen.ts` 到指定目录

### 提交规则

- 所有 commit 推送到 `https://gitlab.fingergame.com/h5_game_sh_tpe/extension-tools/genbot`
- 不要把 `extensions/genbot/` 加进 proj-l-client 的 git index（保持独立工作树即可）
- 待 v0.2 GUI 面板完成后，再考虑在 proj-l-client 里 `git submodule add` 正式纳管

## 仓库结构

```
src/
  cli.ts                      # CLI 入口
  main.ts                     # Cocos Editor 扩展入口（v0.2 才会真做面板）
  package.json                # type=module（让 strip-types 走 ESM）
  parsers/
    PrefabTypes.ts            # prefab JSON 类型声明 & 类型守卫
    PrefabParser.ts           # JSON → NodeTree（含路径推算、同名兄弟消歧）
    ComponentTypeMap.ts       # cc.*/sp.* 组件类型映射
  generators/
    BindJsonManager.ts        # bind.json I/O、默认配置、校验
    GenTsGenerator.ts         # NodeTree + bind → .gen.ts
  utils/
    name-converter.ts         # 节点名 → 合法 TS 标识符
    paths.ts                  # fs/path 小工具
tests/
  smoke.test.ts               # 框架无关的小型 smoke 测试（7 用例）
  check-gen-syntax.ts         # 校验生成文件的 TS 语法可解析
  package.json                # type=module
  fixtures/                   # 测试用 prefab（不入仓）
  output/                     # 生成结果（不入仓）
```

## 远程

```
https://gitlab.fingergame.com/h5_game_sh_tpe/extension-tools/genbot
```
