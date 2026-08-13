# AGENTS.md — Pinel 仓库指南

> 本文件描述仓库事实与约束，供 AI Agent 与维护者遵循。规则均基于当前代码真实状态，修改仓库结构后需同步更新本文件。

## Project Overview

**用途**：Pinel（扩展 ID `hiss.pinel`）是一个 VS Code 扩展，为 Pi 编码智能体（`@earendil-works/pi-coding-agent`）提供类似 Claude Code 插件的图形聊天面板。当前版本 v0.1，范围仅核心聊天体验。

**技术栈**：
- 扩展宿主：TypeScript（strict，Node16 模块，ES2022），Node.js API + `vscode` API（external）
- 集成方式：spawn `pi --mode rpc` 子进程，严格 LF JSONL over stdio（薄客户端架构，协议见 `src/rpc/protocol.ts` 顶部注释与 pi 官方 docs/rpc.md）
- Webview UI：React 19 + react-markdown，esbuild 打包为单文件 IIFE（`media/webview.js`），CSP（nonce + 禁远程内容）
- 构建：esbuild（宿主 CJS bundle + webview IIFE bundle 两条独立流水线）
- 测试：mocha（tdd 风格），经 `@vscode/test-cli` + `@vscode/test-electron` 在真实 VS Code 中运行
- 依赖管理：npm（lockfile 入库），CI 使用 `npm ci`

**主要模块说明**：

| 模块 | 职责 |
|---|---|
| `src/rpc/` | RPC 协议层：`protocol.ts`（协议类型，对齐 docs/rpc.md）、`framing.ts`（严格 LF JSONL 编解码）、`client.ts`（子进程生命周期 + 请求/响应关联） |
| `src/chat/` | 聊天层：`controller.ts`（会话控制器：事件映射/流装配/状态广播）、`panel.ts`（WebviewViewProvider + postMessage 协议 + CSP HTML）、`stream-assembly.ts`（contentIndex 分块装配纯函数） |
| `src/extension.ts` | 入口：activate/deactivate、命令注册、面板注册、导出 `PinelTestApi` 测试钩子 |
| `src/test/` | 单元测试 + 集成测试 + `fixtures/fake-pi.js`（按 rpc.md 实现的假 pi） |
| `webview-ui/` | React 聊天 UI（独立 tsconfig 与 esbuild 配置，与宿主完全隔离） |
| `media/` | 图标（入库）；webview 构建产物（gitignored，构建生成） |

## Repository Structure

```
pinel/
├─ src/                    # 扩展宿主源码（TypeScript，CJS，仅此目录参与宿主 bundle）
│  ├─ extension.ts         # 激活入口 + 测试 API 导出
│  ├─ rpc/                 # RPC 客户端与协议（不含 vscode 依赖，纯逻辑可单测）
│  ├─ chat/                # 控制器/面板/流式装配（依赖 vscode API 与 rpc 层）
│  └─ test/                # 测试（.test.ts 单测 + extension.test.ts 集成 + fixtures/ 假 pi）
├─ webview-ui/             # React webview 源码（browser 平台，不得 import 宿主代码或 vscode API）
│  ├─ src/components/      # Composer / MessageView / Markdown / Notices / StatusBar
│  ├─ src/types.ts         # 宿主消息协议镜像（与 controller OutMessage 手工同步）
│  └─ esbuild.js           # webview 打包脚本（根目录运行：node webview-ui/esbuild.js）
├─ media/                  # 图标 + webview 构建产物（webview.js/css 及 .map 被 gitignore）
├─ .github/workflows/ci.yml # CI：Windows + Ubuntu 矩阵，node 22
├─ .vscode/                # launch/tasks（F5 调试、watch 任务）、extensions/settings
├─ .pi/plans/              # 计划文档（已入库，读它了解 v0.1/v0.2 边界与历史决策）
├─ dist/ out/              # 构建产物（gitignored）
├─ esbuild.js              # 宿主打包脚本（入口 src/extension.ts → dist/extension.js，external: vscode）
├─ .vscodeignore           # 发布裁剪：排除 src/ webview-ui/ out/ node_modules 等，只打包 dist/ 与 media/ 产物
└─ .vscode-test.mjs        # 测试运行配置（out/test/**/*.test.js，mocha tdd，30s 超时，workspaceFolder '.'）
```

## Build and Test

```bash
npm install          # 安装依赖（npm 12 需批准 esbuild postinstall：npm install-scripts approve esbuild）
npm run compile      # 完整构建：类型检查（宿主+webview）→ lint → 宿主 bundle → webview bundle
npm run watch        # 监听模式（并行 watch:tsc + watch:esbuild + watch:webview）；F5 调试前必跑
npm test             # 运行全部测试（pretest 自动执行 compile-tests + compile + lint）
npm run check-types  # 仅类型检查：tsc --noEmit（src）+ tsc -p webview-ui/tsconfig.json
npm run lint         # eslint src（typescript-eslint flat config）
npm run package      # 生产构建（minify）
```

- **测试首次运行**会下载 VS Code 到 `.vscode-test/`（gitignored），约 100MB
- **F5 调试**：先 `npm run watch`（tasks.json 默认构建任务已含 webview），否则全新 clone 后面板空白
- 质量门：`npm run compile` 与 `npm test` 必须全绿（当前 21/21 通过）

## Coding Guidelines

**语言与风格**：
- 全部源码 TypeScript strict（tsconfig 未开 noUnusedLocals，但勿留死代码/死导入）
- 注释与提交信息使用中文；代码标识符使用英文
- 命名：类/组件/接口 PascalCase，变量/函数/文件 camelCase，测试文件 `*.test.ts`，夹具目录 `fixtures/`
- ESLint 规则为警告级（curly / eqeqeq / no-throw-literal / semi / import 命名约定），修改后必须零警告

**文件组织**：
- 新宿主逻辑按层放入 `src/rpc/`（协议/传输）或 `src/chat/`（会话/UI 桥接）；纯函数（无 vscode 依赖）优先拆成独立模块便于单测（参照 `stream-assembly.ts`）
- 新 webview 组件放 `webview-ui/src/components/`，宿主消息类型变更必须**同步更新** `webview-ui/src/types.ts` 镜像
- 构建产物（dist/ out/ media/webview.*）不入库

## Architecture Rules

**分层约束（不得破坏）**：
1. 依赖方向：`webview-ui` → `media/webview.js`（打包）；`src/chat` → `src/rpc`；`src/rpc` 不依赖 vscode；webview 与宿主**零代码共享**，仅通过 postMessage 协议通信
2. 宿主 bundle 唯一入口 `src/extension.ts`，`vscode` 必须保持 external；webview 所有依赖必须打进 bundle（发布包不含 node_modules）

**协议硬约束（均为踩坑后固化的行为，改动前先读 `src/rpc/protocol.ts` 头注释）**：
- JSONL framing 只用 `\n` 切分、容忍尾部 `\r`；**禁止 Node `readline`**（U+2028/U+2029 会破坏帧边界）
- 流式装配按 `contentIndex` 分块，`message_end.message` 为权威；`message_start` 与 `agent_settled` 时必须重置装配状态；settle 后迟到的 `message_update` 必须丢弃
- 空闲判定用 `agent_settled`（`agent_end` 仅刷新消息列表，之后仍可能有 retry/compaction/排队 continuation）
- `extension_ui_request` 对话框方法（select/confirm/input/editor）必须回复 `extension_ui_response`，否则 agent 永久阻塞（v0.1 策略：自动 cancelled）
- 命令发送带 30s 超时；不带 id 的响应按 `command` 字段兜底关联

**Windows 专项约束（有回归测试 `src/test/spawn-spec.test.ts`）**：
- pi 启动解析：裸命令名经 `where.exe` 并**优先 `.cmd`/`.bat` 行**（PATH 中无扩展名 sh 脚本会遮蔽 shim）；`.cmd` 用 `cmd.exe /d /s /c` 包装且必须 `windowsVerbatimArguments: true`（Node 默认的反斜杠转义引号会破坏 cmd 解析）；cmd 路径用 ComSpec 反斜杠形式
- 进程终止：Windows `taskkill /pid <pid> /T /F`；POSIX spawn 需 `detached: true` 后负 PID 组 kill——两侧都要杀整棵进程树（bash 工具子进程）

**安全约束**：
- webview CSP `default-src 'none'` + script nonce；markdown 用 react-markdown 且**不得启用 rehype-raw**
- 不把用户输入拼进 shell 命令字符串（piPath 配置除外——它本就是用户显式指定的本地命令）

**范围纪律**：v0.1 只做核心聊天。以下功能属于 v0.2+，非明确需求不得提前实现：会话列表/切换/重命名、Plan Mode、edit diff 预览、@提及、检查点/回退、权限确认 UI（`get_available_models` 协议类型已备好但未使用）。

## Development Workflow

**修改代码前**：
1. 读 `.pi/plans/init-vscode-extension.md`，确认改动落在 v0.1 边界内或属已规划项
2. 读 `src/rpc/protocol.ts` 头注释与相关模块的既有实现，遵循上述架构规则
3. 涉及 RPC 行为时核对 pi 官方协议文档（`docs/rpc.md`，位于 pi 包安装目录）

**提交代码前**：
1. `npm run compile`（类型 + lint + 双 bundle）全绿
2. `npm test` 全绿；新增/修改协议或流式逻辑必须补测试（见下）
3. Commit 遵循 Conventional Commits（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`），一次提交一个完整独立变更，不含 AI 署名
4. 变更影响用户行为时同步更新 README.md 与 CHANGELOG.md；新增/删除文件后同步本文件的结构描述

## Testing Guidelines

**已有测试**（21 个，全部必须保持通过）：
- `framing.test.ts`：LF framing（U+2028、`\r\n`、粘包拆包）
- `stream-assembly.test.ts`：contentIndex 分块装配（多块交替、权威替换、乱序）
- `spawn-spec.test.ts`：Windows shim 解析（.cmd 包装、verbatim 参数、shell 模式）
- `extension.test.ts`：集成测试（真实 VS Code + 假 pi：状态同步、端到端流式、abort、UI 自动取消、跨消息不串块）

**新增功能覆盖要求**：
- 纯逻辑（framing/装配/spawn 解析类）→ 在 `src/test/` 加 mocha 单测，与现有 suite 风格一致
- 聊天行为/RPC 交互 → 扩展 `fixtures/fake-pi.js` 场景（新增 prompt 标记触发）后加集成测试，经 `PinelTestApi` 断言 controller 状态
- 修改 RPC 命令/事件处理必须同步更新 `protocol.ts` 类型与假 pi

**集成测试专项注意（踩坑沉淀）**：
- 等待空闲用 `api.waitForSettled(timeoutMs, baseline)` 且 **baseline 必须在触发动作前捕获**（settle 与响应异步到达，基线后置会死等）
- 假 pi 的中断用**代际计数**（abortGeneration），不得用全局布尔并在新 prompt 里复位——那会复活被 abort 的旧流，其迟到事件污染后续装配
- 测试运行于真实 VS Code，`vscode.workspace.workspaceFolders[0]` 即仓库根（workspaceFolder '.'）

## Agent Instructions

1. **动手前先理解**：读本文件、`.pi/plans/` 下的计划与相关模块源码；不清楚的 RPC 行为查 `protocol.ts` 头注释与 pi 官方 docs/rpc.md，不要凭想象写协议
2. **优先复用**：新增能力前先查 `src/` 与 `webview-ui/` 是否已有可复用模块（如 `stream-assembly.ts` 的纯函数、`client.ts` 的 spawn 解析、Composer 的附件处理）
3. **不随意新增依赖**：宿主与 webview 均以 esbuild 打包发布，新依赖须经得起体积/安全权衡；webview 侧优先用既有 react-markdown 与 VS Code CSS 变量
4. **不修改无关文件**：改动聚焦任务范围；不顺手重构、不改格式化风格、不动构建产物（dist/out/media/webview.*）
5. **改完必须验证**：`npm run compile` + `npm test` 全绿才可交付；涉及 Windows 路径/进程的行为需确认 `spawn-spec` 相关测试；提交信息遵循 Conventional Commits
6. **保持文档同步**：修改目录结构、命令、构建流程或架构约束后，同步更新本文件与 README.md
