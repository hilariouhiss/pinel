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
| `src/chat/` | 聊天层：`controller.ts`（会话控制器：事件映射/流装配/状态广播）、`panel.ts`（WebviewViewProvider + postMessage 协议 + CSP HTML）、`stream-assembly.ts`（contentIndex 分块装配纯函数）、`todos.ts`（todo 工具结果快照解析纯函数）、`commands.ts`（get_commands 响应防御解析纯函数）、`questionnaire.ts`（ask_user_question 问卷参数解析与回填映射纯函数） |
| `src/extension.ts` | 入口：activate/deactivate、命令注册、面板注册、导出 `PinelTestApi` 测试钩子 |
| `src/test/` | 单元测试 + 集成测试 + `fixtures/fake-pi.js`（按 rpc.md 实现的假 pi）、`fixtures/long-running.js`（stop 测试用长命进程） |
| `src/test-no-workspace/` | 空窗口实例集成测试（独立 .vscode-test.mjs 配置，不传 workspaceFolder 启动） |
| `scripts/` | 测试辅助脚本（clean-test-userdata.mjs：每次 npm test 前清理 .vscode-test/user-data） |
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
├─ src/test-no-workspace/  # 空窗口实例集成测试（独立测试套件）
├─ scripts/                # 测试辅助脚本（clean-test-userdata.mjs）
├─ webview-ui/             # React webview 源码（browser 平台，不得 import 宿主代码或 vscode API）
│  ├─ src/components/      # Composer / MessageView / Markdown / Notices / StatusBar / UiDialogs / TodoPanel / Questionnaire
│  ├─ src/command-match.ts # /命令补全匹配纯函数（前缀>子串>描述，skill 裸名命中）
│  ├─ src/types.ts         # 宿主消息协议镜像（与 controller OutMessage 手工同步）
│  └─ esbuild.js           # webview 打包脚本（根目录运行：node webview-ui/esbuild.js）
├─ media/                  # 图标 + webview 构建产物（webview.js/css 及 .map 被 gitignore）
├─ .github/workflows/ci.yml # CI：Windows + Ubuntu 矩阵，node 22
├─ .vscode/                # launch/tasks（F5 调试、watch 任务）、extensions/settings
├─ .pi/plans/              # 计划文档（已入库，读它了解 v0.1/v0.2 边界与历史决策）
├─ dist/ out/              # 构建产物（gitignored）
├─ esbuild.js              # 宿主打包脚本（入口 src/extension.ts → dist/extension.js，external: vscode）
├─ .vscodeignore           # 发布裁剪：排除 src/ webview-ui/ out/ node_modules 等，只打包 dist/ 与 media/ 产物
├─ .gitignore              # 忽略分组：依赖/构建产物/测试运行时/工具本地状态（.codegraph/、.pi/subagents/ 不入库）/通用防御
└─ .vscode-test.mjs        # 测试运行配置（双套件：main 工作区 + no-workspace 空窗口；30s 超时）
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
- 质量门：`npm run compile` 与 `npm test` 必须全绿（当前 59/59 通过）

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
- `extension_ui_request` 对话框方法（select/confirm/input/editor）必须回复 `extension_ui_response`，否则 agent 永久阻塞；pinel 渲染内联卡片由用户作答，`agent_settled`/`handleExit`/`restart` 时清空未决请求（清扫正确性依赖「dialog 阻塞期间不 settle」的实测前提）
- 命令发送带 30s 超时；不带 id 的响应按 `command` 字段兜底关联
- **命令补全数据链路**：`get_commands` 一律 fire-and-forget（`void fetchCommands()`，内部 try/catch + client 身份校验）——旧版 pi 回 success:false 会 reject，await 在启动关键路径会把面板挂起至 30s；失败静默保持空列表（仅 Output 记录，不弹 notice），补全弹窗对空列表永不弹出；`restart`/`handleExit` 必须清空并广播空命令列表（旧进程的命令会误导补全）；响应字段以实测实现为准（name/description/source/sourceInfo，docs/rpc.md 示例的 path/location 已漂移），防御解析在 `src/chat/commands.ts`；webview 触发谓词 `text.startsWith('/')` 且首词无空白（与 pi 的执行判定解耦，提示层关闭不影响 pi 展开）
- **问卷链路（ask_user_question）**：插件逐题串行阻塞、已提交答案不可撤回——pinel 从 `tool_execution_start`（toolName `ask_user_question`）的完整参数在本地渲染整卷问卷，pi 发来的串行 select/input **标题门控后缓冲不展示**（不匹配题目的对话框走逐卡路径），用户答完确认后按游标自动回填（单选：选项原行/哨兵行+跟进 input；多选：`"1,3"` 数字串或空串；哨兵取 `request.options` 末项不硬编码文案）；**settled/handleExit/restart 清理时必须先对残留缓冲帧逐帧回 cancelled**（插件问卷无 timeout，pi 侧不会自动解锁，否则 agent 永久阻塞）；用户消息事件（pi 也发 message_start/message_end）必须门控跳过防重复显示（乐观渲染保留，权威列表走快照）
- **模型状态自愈**：初始同步 get_state 最多 4 次尝试（间隔 2s/5s/10s），仍无模型时自动重启 pi 一次（在 `startWithHeal` 内顺序执行，**不走 restart 防重入守卫**——自愈常嵌套在手动重启链内会被守卫拦截）；`modelHealRestarted` 置位后短路为单次尝试，手动 restart 重置；`running` 在首次 get_state 成功后才置位（健康慢启动显示"启动中…"而非假警告）；运行中无模型由 StatusBar 用现有字段推导警告态（⚠ 无可用模型 + 重启按钮），**不新增协议字段**

**Windows 专项约束（有回归测试 `src/test/spawn-spec.test.ts`）**：
- pi 启动解析：裸命令名经 `where.exe` 并**优先 `.cmd`/`.bat` 行**（PATH 中无扩展名 sh 脚本会遮蔽 shim）；`.cmd` 用 `cmd.exe /d /s /c` 包装且必须 `windowsVerbatimArguments: true`（Node 默认的反斜杠转义引号会破坏 cmd 解析）；cmd 路径用 ComSpec 反斜杠形式
- 进程终止：**优雅退出优先**——先关闭 stdin（pi RPC 模式在 EOF 时自行 flush 会话/释放锁并退出），优雅期 2.5s 后未退才硬杀：Windows `taskkill /pid <pid> /T /F`；POSIX spawn 需 `detached: true` 后负 PID 组 kill（SIGTERM → 2s 后 SIGKILL）——两侧都要杀整棵进程树（bash 工具子进程）；总时长 5s 契约（永不 reject、exit 事件先于 resolve 派发，`stop.test.ts` 覆盖两条路径）；stdin 需挂空 error 监听防异步 EPIPE

**安全约束**：
- webview CSP `default-src 'none'` + script nonce；markdown 用 react-markdown 且**不得启用 rehype-raw**
- 不把用户输入拼进 shell 命令字符串（piPath 配置除外——它本就是用户显式指定的本地命令）

**范围纪律**：以下功能属于 v0.2+，非明确需求不得提前实现：会话列表/切换/重命名、Plan Mode、edit diff 预览、@提及、检查点/回退（`get_available_models` 协议类型已备好但未使用）。注：交互 UI（对话框卡片 + 待办面板）、/命令自动补全与问卷确认流程（ask_user_question 整卷 + 确认前修改 + 自动回填）已于 2026-08 经用户明确要求提前实现（见 `src/chat/todos.ts`、`src/chat/questionnaire.ts`、`UiDialogs.tsx`、`Questionnaire.tsx` 与 `webview-ui/src/command-match.ts`）。

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

**已有测试**（59 个，全部必须保持通过）：
- `framing.test.ts`：LF framing（U+2028、`\r\n`、粘包拆包）
- `stream-assembly.test.ts`：contentIndex 分块装配（多块交替、权威替换、乱序）
- `spawn-spec.test.ts`：Windows shim 解析（.cmd 包装、verbatim 参数、shell 模式）
- `stop.test.ts`：`RpcClient.stop()` 等待真实退出（exit 事件在 resolve 前派发、子进程已死）+ 优雅退出路径（stdin EOF 自退 exit code 0）+ 兜底硬杀路径（`PINEL_LONG_NO_EOF=1` 拒不退出）
- `todos.test.ts`：`parseTodoTasks` 防御解析（全量快照、部分损坏跳过、结构不符 null）
- `commands.test.ts`：`parseCommands` 防御解析（get_commands 响应：全量合法、部分损坏跳过、结构不符空列表、未知 source 兜底）
- `questionnaire.test.ts`：`parseQuestionnaireArgs` 防御解析 + `parseQuestionnaireAnswer` 校验 + 回填映射（select 选项行/哨兵跟进标记、input 多选数字串/空串/自定义、标题归属）
- `extension.test.ts`：集成测试（真实 VS Code + 假 pi：状态同步、端到端流式、abort、UI 自动取消、跨消息不串块、重启竞态回归、崩溃后重启恢复、模型自愈——NULLMODEL-FIRST 重试恢复无重启 / NULLMODEL-FOREVER 自动重启恰好一次后警告态、命令补全链路——启动送达/CMDADD settle 刷新/重启恢复不残留/NOCOMMANDS 旧版失败静默、问卷链路——整卷全链路含修改重答/取消无残留/通用对话框标题门控、用户消息去重——pi 的 user 事件不重复推送）
- `src/test-no-workspace/no-workspace.test.ts`：空窗口实例友好状态（no-workspace + 引导文本，不伪装成进程异常）

**新增功能覆盖要求**：
- 纯逻辑（framing/装配/spawn 解析类）→ 在 `src/test/` 加 mocha 单测，与现有 suite 风格一致
- 聊天行为/RPC 交互 → 扩展 `fixtures/fake-pi.js` 场景（新增 prompt 标记触发）后加集成测试，经 `PinelTestApi` 断言 controller 状态；**作用于首次 get_state 的场景**（如模型自愈）不能用 prompt 子串标记——首次 get_state 发生在任何 prompt 之前，改用环境变量 `PINEL_FAKE_PI_SCENARIO` 在 spawn 时激活（测试内先设 env 再 `api.restart()` 触发新进程，结束恢复 env + restart）
- 修改 RPC 命令/事件处理必须同步更新 `protocol.ts` 类型与假 pi

**集成测试专项注意（踩坑沉淀）**：
- 等待空闲用 `api.waitForSettled(timeoutMs, baseline)` 且 **baseline 必须在触发动作前捕获**（settle 与响应异步到达，基线后置会死等）；重启类测试**不要用** waitForSettled（无新 prompt 时 settled 不前进会挂到超时），改用 `waitFor` 轮询断言
- 假 pi 的中断用**代际计数**（abortGeneration），不得用全局布尔并在新 prompt 里复位——那会复活被 abort 的旧流，其迟到事件污染后续装配；CRASHME 场景为「先正常 respond 再延迟 exit(1)」，配合「sendPrompt 后立即 restart」可确定性复现 restart 竞态（旧 exit 事件迟到污染新状态）
- 测试运行于真实 VS Code，`vscode.workspace.workspaceFolders[0]` 即仓库根（workspaceFolder '.'）
- **@vscode/test-cli 配置里 `launchArgs` 非空时 `workspaceFolder` 会被忽略**（实测：加任何 launchArgs 后 main 实例空窗口启动）；不要在 launchArgs 里传诊断 flag
- 两个测试实例共享 `.vscode-test/user-data`：no-workspace 套件（空窗口）退出会把空窗口状态持久化，污染下次运行的 main 实例——`npm test` 已内置清理脚本（scripts/clean-test-userdata.mjs），直接跑 `npx vscode-test` 跳过清理会踩坑
- 主套件内**不得**用 `updateWorkspaceFolders` 移除全部工作区文件夹：VS Code 空窗口不支持该 API 恢复（实测 add 返回 false，不可逆），no-workspace 场景由独立空窗口实例套件覆盖
- fake-pi 的 prompt 场景判断注意**子串包含顺序**（如 `UIREQUEST-CRASH` 必须在 `UIREQUEST` 之前）与 `waitForUiResponse` 命中后从数组移除（否则后续同 id 请求命中已 resolve 的旧 waiter 死锁）
- fake-pi 与 long-running 均在 **stdin EOF 时退出**（与真实 pi 的优雅退出路径一致）：集成测试的 restart 流程不付 2.5s 优雅期等待；long-running 经 `PINEL_LONG_NO_EOF=1` 保持常驻（供 stop 兜底硬杀测试）
- **待办列表数据源踩坑**：pi 0.84.1 的 RPC 模式对 `setWidget` 组件工厂静默忽略（rpiv-todo 的 todo 面板收不到内容），todo 列表从 `tool_execution_end`（toolName "todo"）的 `result.details.tasks` 全量快照解析——**未文档化字段**，必须防御解析（见 `src/chat/todos.ts`）；若 pi 未来支持字符串数组 widget 或 todo 专用事件，迁移到官方通道
- **get_commands 数据源踩坑**：docs/rpc.md 示例写 path/location 字段，pi 0.84.x 实际返回 sourceInfo（文档漂移）——协议类型以实现为准 + 防御解析（见 `src/chat/commands.ts`）；get_commands 不受模型状态影响，旧版 pi 回 success:false；`NOCOMMANDS`/`CMDADD` 场景经假 pi 覆盖（NOCOMMANDS 作用于首次 get_commands，用 env 激活而非 prompt 标记）
- **问卷测试场景**：fake-pi `QUESTIONNAIRE`/`QUESTIONNAIRE-GENERIC` 模拟插件串行 walker（含哨兵跟进 input、多选 input、取消放弃、穿插通用对话框）；**fake-pi 日志跨测试累积**——断言响应序列必须用 `recordsAfterPrompt(marker)` 按 prompt 边界切片，否则命中前面测试的同 id 记录（累计计数断言失败）

**F5 调试专项注意（踩坑沉淀）**：
- `.vscode/launch.json` 的 extensionHost 配置必须**显式把 `${workspaceFolder}` 作为 args 传入**（官方推荐写法）；缺省时开发宿主以空窗口启动，`workspaceFolders` 为空 → 面板提示「请先打开一个文件夹」且点重启无效（pi 从未被 spawn）
- F5 时 Debug Console 的 `DEP0169 url.parse` 警告来自 **VS Code 自身**（1.133 内置 AgentHost 进程 + 扩展宿主内部代码），与本仓库无关（宿主 bundle 与 pi 依赖均无 url.parse；pi 的 stderr 被完全接管不会出现在 Debug Console）；警告无害，随 VS Code 升级自然消失（上游 issue microsoft/vscode#301941），无需处理

## Agent Instructions

1. **动手前先理解**：读本文件、`.pi/plans/` 下的计划与相关模块源码；不清楚的 RPC 行为查 `protocol.ts` 头注释与 pi 官方 docs/rpc.md，不要凭想象写协议
2. **优先复用**：新增能力前先查 `src/` 与 `webview-ui/` 是否已有可复用模块（如 `stream-assembly.ts` 的纯函数、`client.ts` 的 spawn 解析、Composer 的附件处理）
3. **不随意新增依赖**：宿主与 webview 均以 esbuild 打包发布，新依赖须经得起体积/安全权衡；webview 侧优先用既有 react-markdown 与 VS Code CSS 变量
4. **不修改无关文件**：改动聚焦任务范围；不顺手重构、不改格式化风格、不动构建产物（dist/out/media/webview.*）
5. **改完必须验证**：`npm run compile` + `npm test` 全绿才可交付；涉及 Windows 路径/进程的行为需确认 `spawn-spec` 相关测试；提交信息遵循 Conventional Commits
6. **保持文档同步**：修改目录结构、命令、构建流程或架构约束后，同步更新本文件与 README.md
