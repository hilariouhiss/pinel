# AGENTS.md

This file provides guidance to Conding Agent when working with code in this repository.

## 项目概览

Pinel monorepo——为 Pi 编码智能体（`@earendil-works/pi-coding-agent`）提供 VS Code 图形聊天面板。无根 package.json，由两个独立仓库经 `git subtree` 整合（完整历史保留为祖先提交）：

- `vscode/` —— VS Code 扩展（发布 ID `hilariouhiss.pinel`），聊天面板宿主
- `pi/` —— Pi 插件包（npm `@hilariouhiss/pinel`，`pi install` 安装，独立发布），运行在 Pi 进程内回传状态

**权威指南是 `vscode/AGENTS.md`**（架构规则、Feature Map、测试规范、踩坑沉淀索引）。动手前先读它；修改仓库结构/命令/架构约束后需同步更新它。

git 注意：子树内旧提交路径为根相对，逐文件溯源需带前缀，如 `git log vscode/main --oneline -- src/chat/session-history.ts`（普通 `--follow` 无法跨前缀边界）。

## 常用命令

所有 npm 命令在 `vscode/` 目录内运行：

| 命令                                                                      | 作用                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm install`                                                             | 安装依赖；npm 12 需先 `npm install-scripts approve esbuild`                                           |
| `npm run compile`                                                         | 质量门：类型检查（宿主+webview+插件）→ lint → 12 个 `check:*` 纯函数自检 → 宿主+webview bundle        |
| `npm run watch`                                                           | 并行监听（esbuild 宿主 + esbuild webview + tsc）；**F5 调试前必跑**                                   |
| `npm test`                                                                | 全量测试（mocha + 真实 VS Code；pretest 自动编译+lint；首次下载 VS Code 约 100MB 到 `.vscode-test/`） |
| `npm run compile-tests && npx vscode-test --label main --grep "<测试名>"` | 跑单个测试（套件 label：`main` 工作区 / `no-workspace` 空窗口）                                       |
| `npm run check-types` / `check-plugin` / `lint` / `package`               | 分项：双 tsconfig 类型检查 / 插件（`../pi`）独立 tsc（不在主 program）/ eslint / 生产构建             |
| `npm run smoke:plugin`                                                    | 真实 pi 冒烟（opt-in，需已装 pi，不进 CI）                                                            |
| `npm run install:all`                                                     | 一键：构建 + vsce 打包 + 安装扩展 + `pi install ../pi`                                                |

`pi/` 内：无 npm scripts；测试 `cd pi && npx vitest`；发布 `cd pi && npm publish`。

CI（`.github/workflows/ci.yml`）：仅覆盖 `vscode/`，win/ubuntu 矩阵，Node 22，`npm ci` → `npm run compile` → `npm test`（xvfb）。

## 架构

**三进程**：VS Code 扩展宿主（CJS bundle `dist/extension.js`，`vscode` external，唯一入口 `src/extension.ts`）↔ `pi --mode rpc` 子进程（环境变量 `PINEL_PLUGIN=1`，严格 LF JSONL over stdio）↔ webview（React 19，单 IIFE bundle 同时服务聊天 + 会话历史两个视图，按 `body[data-pinel-view]` 分支挂载；CSP nonce `default-src 'none'`，markdown 禁 rehype-raw）。

**依赖方向**：`src/chat → src/rpc`；`src/rpc` 不依赖 vscode；宿主与 webview **零代码共享**，仅 postMessage 通信，`OutMessage` 类型手工镜像于 `webview-ui/src/types.ts`——宿主消息类型变更必须同步镜像（App.tsx switch 无 default 分支，漏同步 = 运行时静默 bug）。

**RPC 协议**：改动前必读 `src/rpc/protocol.ts` 头注释（协议契约；`pi/docs/rpc.md` 与 pi 0.84.x 实际有漂移）。硬约束：LF 切分、禁止 readline；流式按 contentIndex 装配、`message_end` 权威；`extension_ui_request` 必须回复否则 agent 永久阻塞；命令 30s 超时。

**pi/ 插件状态桥**：插件不开新传输，借 `extension_ui_request` 帧（`setStatus`）回传，宿主按白名单过滤 + 防御解析（`pinel-payload.ts`）；插件仅在 `PINEL_PLUGIN=1` 时激活。

**构建**：两个独立 esbuild 配置——宿主 `esbuild.js`（`src/extension.ts → dist/extension.js`，CJS）、webview `webview-ui/esbuild.js`（`index.tsx → media/webview.js`，IIFE，`.svg` text loader 内联 lucide 图标）；tsc 仅检查不产出；`check:*` 是编译期纯函数自检（与 mocha 并列的第二测试层）。

**配置与状态**：宿主直接读写 `~/.pi/agent/settings.json`（严格 JSON.parse，损坏即抛、绝不覆盖；写入原子 temp+rename）与项目级 `<workspace>/.pi/settings.json`；会话为 JSONL 文件，最后会话经 workspaceState `pinelLastSessionFile` + `--session` 恢复；扩展启停 = 文件重命名 `.ts ↔ .disabled`，包管理走 `pi install/remove`。

**git 状态**：监听 `.git/HEAD`、`index`、`packed-refs`、`refs/**` 状态文件（提交/暂存/切换分支不触发保存事件），300ms 去抖后广播 `sessionEnv` 刷新信息条。

**测试架构**：集成测试经扩展导出获取 `PinelTestApi`，断言 controller 缓存/事件日志；RPC 行为用 `src/test/fixtures/fake-pi.js` 脚本化（prompt 标记场景 + `PINEL_FAKE_PI_SCENARIO` env 预置场景）。

## 关键约定

细节见 `vscode/AGENTS.md`，此处只保留最核心：

- 注释与提交信息**中文**，标识符英文；Conventional Commits，一次一个完整变更，无 AI 署名
- 修改后零 ESLint 警告，不留死代码/死导入
- Windows 进程管理契约：`.cmd` 走 `cmd.exe /d /s /c` + `windowsVerbatimArguments`；停止 = 优雅关 stdin（2.5s）→ `taskkill /T /F`（总时长 5s）
- 交付前：中大改动 `npm run compile` + `npm test` 全绿；用户可见变更同步 README.md/CHANGELOG.md
