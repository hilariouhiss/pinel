# AGENTS.md — Pinel 仓库指南

> 本文件描述仓库事实与约束，供 AI Agent 与维护者遵循。规则均基于当前代码真实状态，修改仓库结构后需同步更新本文件。

## Project Overview

**用途**：Pinel（扩展 ID `hilariouhiss.pinel`）是一个 VS Code 扩展，为 Pi 编码智能体（`@earendil-works/pi-coding-agent`）提供类似 Claude Code 插件的图形聊天面板。当前版本 v0.1，范围仅核心聊天体验。

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
| `src/chat/` | 聊天层：`controller.ts`（会话控制器：事件映射/流装配/状态广播 + 会话重命名/删除 + 会话统计 get_session_stats 拉取与开关 + fork/clone 会话分支）、`panel.ts`（WebviewViewProvider + postMessage 协议 + CSP HTML）、`session-history.ts`（会话目录扫描纯函数 + appendSessionName）、`session-history-provider.ts`（主侧边栏会话历史视图）、`session-stats.ts`（get_session_stats 响应防御解析纯函数）、`git-status.ts`（工作区 git 状态：spawn `git status --porcelain --branch` 取分支+脏标记 + 防御解析纯函数）、`file-scanner.ts`（工作区文件扫描纯函数，@ 添加文件数据源）、`stream-assembly.ts`（contentIndex 分块装配纯函数）、`todos.ts`（todo 工具结果快照解析纯函数）、`commands.ts`（get_commands 响应防御解析纯函数）、`fork-messages.ts`（get_fork_messages 响应防御解析纯函数）、`models.ts`（get_available_models/get_available_thinking_levels 响应防御解析纯函数）、`questionnaire.ts`（ask_user_question 问卷参数解析与回填映射纯函数）、`prompt-editor.ts`（Ctrl+G 提示词编辑器：临时文件 + 保存回填 + 发送清理）、`extensions.ts`（pi 智能体扩展管理纯函数：本地扩展扫描/重命名启停/删除 + settings.json packages 扫描/启停/卸载） |
| `src/extension.ts` | 入口：activate/deactivate、命令注册、面板注册、导出 `PinelTestApi` 测试钩子 |
| `src/test/` | 单元测试 + 集成测试 + `fixtures/fake-pi.js`（按 rpc.md 实现的假 pi）、`fixtures/long-running.js`（stop 测试用长命进程） |
| `src/test-no-workspace/` | 空窗口实例集成测试（独立 .vscode-test.mjs 配置，不传 workspaceFolder 启动） |
| `scripts/` | 测试辅助脚本（clean-test-userdata.mjs：每次 npm test 前清理 .vscode-test/user-data） |
| `webview-ui/` | React 聊天 UI（独立 tsconfig 与 esbuild 配置，与宿主完全隔离） |
| `media/` | 图标（2026-08-27 起 webview 全部 UI 图标改用 lucide：`import "lucide-static/icons/*.svg"` 经 esbuild text loader 内联进 webview bundle，不再入库；pi-glyph.svg 为活动栏/视图头图标（镂空 π 轮廓）、pi-icon.png 为扩展图标兼市场发布图标（顶层 package.json icon，深底品牌图标；vsce 禁止 SVG 作扩展图标，须用 PNG），两者保留入库）；webview 构建产物（gitignored，构建生成） |

## Repository Structure

```
pinel/
├─ src/                    # 扩展宿主源码（TypeScript，CJS，仅此目录参与宿主 bundle）
│  ├─ extension.ts         # 激活入口 + 测试 API 导出
│  ├─ rpc/                 # RPC 客户端与协议（不含 vscode 依赖，纯逻辑可单测）
│  ├─ chat/                # 控制器/面板/流式装配/提示词编辑器（依赖 vscode API 与 rpc 层）
│  └─ test/                # 测试（.test.ts 单测 + extension.test.ts 集成 + fixtures/ 假 pi）
├─ src/test-no-workspace/  # 空窗口实例集成测试（独立测试套件）
├─ scripts/                # 测试辅助脚本（clean-test-userdata.mjs）
├─ webview-ui/             # React webview 源码（browser 平台，不得 import 宿主代码或 vscode API）
│  ├─ src/components/      # Composer（footer 卡片，含模型/思考 chip） / MessageView / Markdown / Notices / StatusBar（已删） / UiDialogs / TodoPanel / Questionnaire / ConfigPopover（队列模式/自动压缩/会话信息开关） / ModelPopover（模型/思考 chip 锚定下拉） / SessionListPopover（含行内编辑重命名/删除） / SessionStatsBar（会话信息条） / ForkPopover（fork 选择器弹层） / ExtensionPopover（扩展管理弹层：启停开关 + 卸载） / SearchBox / ListPopover（已删）
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
- 质量门：`npm run compile` 与 `npm test` 必须全绿（当前 215/215 通过：主套件 212 + 空窗口套件 3）

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
- **/new 本地拦截链路（2026-08-27 实现）**：输入框发送 `trim === "/new"` 且无 images/fileRefs 时，controller.sendPrompt 在 client 校验后拦截改调 newSession()（不乐观渲染、不发 prompt/steer）——pi slash 命令 interactive-only，**RPC 模式不展开**（rpc-mode.js 零 slash 逻辑、get_commands 不含内置命令，与 /settings 同实证）；流式中 runSessionChange 内置 abort+settle 防护；带参数/附件原样发送；与在途会话变更并发时防重入静默返回（窗口极小，接受现状）；测试断言「message === "/new" 的 prompt 记录为 0」免疫跨测试累积（**不得断言最近 in 记录为 new_session**——后随 get_messages/get_state 入站）；补全弹窗不列出 /new（get_commands 不含内置命令，行为如实）
- **提示词编辑器链路（Ctrl+G）**：键位经 package.json keybinding 注册（`ctrl+g → pinel.editPrompt`，when `pinel.inputFocused` 由 webview textarea focus/blur 事件 → `inputFocus` 消息 → 宿主 setContext 维护）——**webview 内 keydown 捕获不可行**（Ctrl+G 是 VS Code 默认全局键 gotoLine，工作台 capture 阶段拦截，vscode#320435/#139163）；命令执行 → `triggerEditPrompt` → webview 回发 `editPrompt{text}`（宿主不维护输入状态）→ `PromptEditorManager.edit` 开临时文件（`os.tmpdir()/pinel-prompt-<ts>.md`，preview:false 固定标签）；**载体必须真实文件**（untitled 保存不触发 onDidSaveTextDocument，vscode#25729）；保存 → `fillPrompt{text}` 回填输入框（**行尾规范化 `\r\n`→LF**——Windows 编辑器保存自动转换）；发送（sendPrompt 含早退分支）→ `disposeForSend`（先清 pendingUri 防双删竞态 → tabGroups.close → fs.rm 带 maxRetries 防 Windows 句柄占用）；**标签页关闭监听必须用 `tabGroups.onDidChangeTabs`（event.closed）而非 `onDidCloseTextDocument`**（后者跟踪文档对象生命周期，延迟数分钟，vscode#199282/#84505）；已确认坑：tabGroups.close 是 TabGroups 方法不是 TabGroup 方法；测试驱动 api.editPrompt + TestEventLog lastFillPrompt；F5 需验证 keybinding when 覆盖默认 gotoLine 是否生效（失效降级 Ctrl+Alt+G 已备）
- **@ 添加文件链路**：输入框末 token 以 `@` 开头触发文件补全弹窗（`getFileList` 消息 → `file-scanner.ts` 扫描工作区：ignore 包（^5.3.2，唯一运行时依赖）gitignore 过滤 + 硬编码跳过 .git/node_modules + 上限 1000 + 图片扩展名判定）→ `fileList` 响应 → 选中后附件区卡片 → 发送时 `sendPrompt` 带 fileRefs → controller **自读自拼**（实证：pi RPC 模式不支持 CLI @file 参数，main.js:508 直接报错——pinel 文本按 `<file name="绝对路径">` 格式注入对齐 pi CLI file-processor、图片转 base64 附件 + 空 `<file name>` 引用，2MB 截断，失败 notice 跳过）；**用户消息显示层剥离 `<file>` markup**（MessageView userText 替换为 📎 引用行——settle 后权威消息含整段文件内容，直接渲染会气泡突变）；踩坑：ignore 目录剪枝必须尾斜杠（`ig.ignores('dist/')`）、Windows 路径 / 分隔、测试日志结构 `{t, record:{dir, record:请求}}` 提取需双层 record
- **问卷链路（ask_user_question）**：插件逐题串行阻塞、已提交答案不可撤回——pinel 从 `tool_execution_start`（toolName `ask_user_question`）的完整参数在本地渲染整卷问卷，pi 发来的串行 select/input **标题门控后缓冲不展示**（不匹配题目的对话框走逐卡路径），用户答完确认后按游标自动回填（单选：选项原行/哨兵行+跟进 input；多选：`"1,3"` 数字串或空串；哨兵取 `request.options` 末项不硬编码文案）；**webview 重入判定按问卷实例 id 比较（2026-08-27 修复）**：`QuestionnaireView.id` = `tool_execution_start` 的 toolCallId——postMessage 每条消息都是结构化克隆的新对象，questions 引用比较恒为真会误判重入（多选勾选被拽到首个未答题、单选乱序作答回跳、drafts 每次广播被清空），故重入/drafts 清理 effect 均按 id 比较（首帧初始化 ref、重入分支更新 ref）；**多选选择框图标**：lucide check-square/square 内联（选中 focusBorder、未选 descriptionForeground、14px，与 2026-08-27 全量 lucide 迁移一致；其余 ✓ 文本字符保留）；**settled/handleExit/restart 清理时必须先对残留缓冲帧逐帧回 cancelled**（插件问卷无 timeout，pi 侧不会自动解锁，否则 agent 永久阻塞）；用户消息事件（pi 也发 message_start/message_end）必须门控跳过防重复显示（乐观渲染保留，权威列表走快照）；**提交后自动收起**（2026-08-21）：phase 进入 submitting/submitted 后组件渲染一行状态条「✓ Questionnaire answered (n/n)」（不带容器级 Esc——提交后取消无意义），App 侧 qnaFlowIndex 在提交瞬间捕获 messages.length 作流内插入位置（答题期间 agent 被对话框阻塞、消息数恒定），slice 分割渲染使后续消息落在条下方随流上移（同会话 agent_end 快照不动位置、sessionFile 变化/cleared/answering 广播三处重置，越界兜底末尾）
- **配置面板链路**：footer 卡片下半 ⚙ 设置按钮（`status-settings-btn`，lucide settings 图标）触发 ConfigPopover（2026-08-18 回归——此前因 emoji ⚙ 图标过小改为 `/settings` 命令触发，现以正式 SVG 图标恢复按钮入口，`/settings` 本地拦截逻辑已移除、输入恢复为普通文本发送；footer 卡片化后按钮位于卡片下半左）；webview 本地开合，点击外部/Esc 关闭，Esc 在 window capture 阶段拦截并 stopPropagation 让位于 Composer 的中断/清空分支；面板含队列模式双值点选（`set_steering_mode`/`set_follow_up_mode`）、自动压缩开关（`set_auto_compaction`）与会话信息开关（模型/思考切换已迁至按钮行 chip，2026-08-27）
- **模型/思考 chip 链路（2026-08-27）**：footer-actions 左端两枚常显 chip（`composer-chip`，模型=name（无则 id）max-width 140px ellipsis + tooltip 完整 provider/id，思考=thinkingLevel），点击弹 ModelPopover 锚定下拉（chip 唯一切换入口；ConfigPopover 已无模型/思考区）；**向上弹出为仓库首例**（bottom 锚定 + resize 重算 + 右缘 clamp 右对齐回退 + z-index 沿用 overlay90/panel100）；popover 互斥枚举扩 `"model"/"thinking"`（App 局部类型，types.ts 零改动）；`case models`/`case thinkingLevels` 消息 handler 空数组失败信号按枚举关弹层（ModelPopover 内同规则兜底）；隐藏/禁用：model null → 模型 chip 禁用显 "No model" + 思考 chip 整枚隐藏（thinkingLevel 永不为 null，不支持思考走 "off" 正常展示）；流式中不禁用（变更自下一回合生效）；数据拉取/选中所用消息与宿主链路（get_models/set_model 回读/clamp/client 竞态校验）完全复用无改动
- **lucide 图标链路（2026-08-27 起，替代手绘 fill SVG）**：webview 全部 UI 图标经 `import x from "lucide-static/icons/*.svg"`（lucide-static 1.34.0，lockfile 锁定；ISC 许可，@license 注释随 bundle 进入）由 esbuild `--loader:.svg=text` 内联进 bundle（`webview-ui/esbuild.js` loader 配置 + `global.d.ts` 的 `declare module "*.svg"` 通配已覆盖 bare specifier；loader 按扩展名对 node_modules 同样生效），`dangerouslySetInnerHTML` 渲染进 DOM（静态库文件，无注入风险；CSP `img-src data:` 不涉及）；lucide SVG 标准结构 `fill="none" stroke="currentColor"` → **主题自适应靠容器级 `color` 继承**（`.composer-send` → `--vscode-button-foreground`、`.composer-stop` → `--vscode-errorForeground`、`.status-settings-btn`/`.status-extensions-btn`/`.chat-history-btn`/`.chat-new-session-btn`/`.chat-fork-btn`/`.search-box-icon` → `--vscode-descriptionForeground`、`.history-new-button` → `currentColor`（按钮已有 color:inherit）、`.history-item-edit`/`.history-item-delete` → `--vscode-descriptionForeground`（delete hover → `--vscode-errorForeground`；active 行 → `--vscode-list-activeSelectionForeground`）、`.extension-item-delete` → `--vscode-descriptionForeground`（hover → errorForeground））——旧 fill 图标的 path 级选择器痛点随迁移消失；尺寸由作用域化规则覆写（文件内 width=24：header 三钮/history-new 16px、send/stop/settings/extensions/搜索/history-item/extension-item 14px、统计条 11px、待办 12px；选择器为 `.lucide` 类——lucide 根元素 `class="lucide lucide-<name>"` 无 .icon 类）；**小尺寸 stroke 补偿**：11px（统计条）/12px（待办）覆写 `stroke-width: 2.5`（默认 2 在小尺寸下视觉偏细）；**待办状态三态（TodoPanel）**：`.todotask-icon` color → `--vscode-foreground`（pending，circle）、`.status-in_progress` → `--vscode-focusBorder`（circle-dot）、`.status-completed` → `--vscode-testing-iconPassed`（circle-check-big）——**状态色挂在 .todotask-icon 上，不与行文本色共用**（completed 行文本是 descriptionForeground 删除线灰，图标须保持绿）；**图标映射**：send/settings/history/search 同名、stop→square、extension→puzzle、new-session/add→plus、fork→git-fork、edit→pencil、delete→trash-2、up/down-arrow→arrow-up/arrow-down、dollar→dollar-sign、cache→database（lucide 无 cache 专属图标）；**统计条分支符号**：原 Maple Mono NF 字型 U+F418 → lucide git-branch 内联 SVG（块级元素须 `display:inline-block` + `vertical-align:-1px` 对齐文本基线）
- **模型/思考等级列表链路**：入口为按钮行 chip 锚定下拉 ModelPopover（2026-08-27 起唯一切换入口；原状态栏下拉 → ConfigPopover 内嵌列表 → chip 三代演进，宿主链路未变）；数据每次打开时拉取 `get_available_models`/`get_available_thinking_levels`，30s 超时；失败 notice + fire 空数组作为失败信号，webview 收到空数组**关闭下拉**；选中发 `set_model{provider,modelId}`/`set_thinking_level{level}`（选中即关闭拉层）；**set_model 响应只有 Model 对象（不含 thinkingLevel）**——pi 切模型会重新锎制思考等级并持久化 settings，必须先应用响应 model 再 `get_state` 回读刷新 model+thinkingLevel（回读失败 notice，保留 set_model 结果）；**set_thinking_level 响应无 data 且 pi 有 clamp 语义**——成功后同样 `get_state` 回读确认实际生效值；响应应用前必须校验 `this.client === client`（restart 竞态迟到响应丢弃）；防御解析在 `src/chat/models.ts`（模型项须 id/name/provider 非空字符串——set_model 依赖 provider+modelId 复合键，跨 provider 的 id 可能重复，列表项用复合键）；流式中允许切换（变更自下一回合生效）；`status.model === null` 时思考 chip 隐藏；`cycle_model`/`cycle_thinking_level` 保留供测试覆盖（UI 不再使用）
- **会话重命名/删除链路（lucide pencil/trash-2，2026-08-19 实现）**：会话列表（主侧边栏 HistoryApp + header 弹层 SessionListPopover，共用 history-item 结构）行右侧 hover 显示操作按钮——**history-item 是 div 容器**（原 button 无法嵌套按钮），内含 button.history-item-main（点击切换）+ div.history-item-actions（edit/delete 图标按钮，opacity 0 → hover/focus-within 显示）；**编辑态行整体换成 div（.history-item-main-editing）而非 button——input 嵌套于 button 内时 Chromium 隐式激活会让输入框里的 Enter（含中文输入法选词确认）click 父按钮误触发切换（实测 bug，见 commit c700d46）**；行内编辑（editingPath 本地状态，弹层打开时重置；Enter 提交需 `!e.nativeEvent.isComposing` 守卫 + preventDefault/optimistic 退出/Esc 取消/blur 取消）——**弹层全局 Esc 是 window capture 监听（先于 React 冒泡委托执行），input 侧 stopPropagation 不可行**，capture handler 内对 `closest('.history-item-edit-input')` 豁免实现两段式 Esc（只豁免编辑 input 类名，SearchBox 关窗行为保留）；**重命名双路径**：当前会话（path===sessionFile）→ RPC `set_session_name`（实测 pi 0.84.x 有、**docs/rpc.md 未收录**，trim 空名报错；成功后 force 重解析标题——lastTitleSessionFile 去重键 reset），非当前会话 → 宿主 `appendSessionName` 直接向 .jsonl 追加 session_info 条目（格式对齐 pi appendSessionInfo：id uuid8 查重/parentId=最后非 header 条目 id（**必须全文件扫描**，MAX_SCAN_LINES 是显示层截断）/timestamp/name 清洗，尾无换行先补 \n）；空名在 controller 双路径统一拦截视为取消；非当前操作是纯文件操作**不受 client running 守卫限制**；**删除无 pi RPC**（rpc-types 全命令确认）→ 宿主 fs.rm force:true + maxRetries（Windows 句柄），当前会话禁止删除（webview 禁用 + controller 执行时二次校验），删除前 modal 确认抽为**共享 seam `confirmSessionDelete`（controller.ts 导出，聊天面板与历史视图两个 handler 共用，controller 本体不内置——PinelTestApi 直调不卡确认框）**；成功后 fire `sessionListRefresh`（新 OutMessage：provider 立即 refresh 绕 5s 节流，连带重置节流窗口属良性；**必须同步加入 webview types.ts HostMessage 镜像**——App.tsx switch 无 default 分支）；聊天面板弹层数据由 panel 操作成功后重拉 getSessionList post sessionList 覆盖；测试：fake-pi set_session_name 向 currentSessionFile **物理落盘**（RENAME-FAIL 场景回 success:false），删除确认路径 stub vscode.window.showWarningMessage + 直调 seam
- **会话统计链路（get_session_stats，2026-08-19 实现）**：设置面板「显示会话信息」开关（`pinel.showSessionStats` 配置 Global 持久化 + **package.json contributes.configuration 声明**，重启保留；**不设 running 门控**——UI 偏好不依赖 pi 运行）；开关链路含 **onDidChangeConfiguration 订阅**（仅该配置变化时生效、同值写入自然跳过——toggle 写配置后直接更新 status 不双更新）与 **每次 start() 回读配置写 status**（restart 重置 status 后恢复，防静默复位）；`refreshSessionStats`：client.send get_session_stats → `parseSessionStats` 防御解析（session-stats.ts：tokens 核心四项缺一 → null，total 缺省按四值之和补齐，contextUsage 可缺省/percent 可 null（压缩后无新响应））→ fire `{type:"sessionStats"}`；**会话竞态：捕获发起时 sessionFile、fire 前校验未变**（连续切换旧统计丢弃，照抄 refreshSessionTitle）+ restart 竞态 client 校验；**失败语义：无旧值不 fire（webview 初始 null 占位）、有旧值静默保留** + Output 记录（不弹 notice）；**fireSnapshot 携带 sessionStats**（面板重显/重启恢复不留长期占位）+ restart 清空 + start 首拉（开关开启时）；刷新时机 settle/切换/新建/开关开启/start 首拉，流式中不刷（纯拉取无推送事件）；切换/新建后先 fire null 占位再拉取；**缓存命中率对齐 pi CLI**（interactive-mode.js /session-info）：cacheRead/(input+cacheRead+cacheWrite)，仅 cacheRead>0||cacheWrite>0 时显示；信息条 SessionStatsBar 纯展示（2026-08-20 起 p10k 风格：左环境段 `folderName on  branch [!?↑↓]`（branch 图标 lucide git-branch 内联 SVG）+ 右指标段（上下文 `X.X%/Y.YM`、缓存读↑、缓存写↓、缓存命中率 cache 图标、成本$；新序 git/上下文/缓存读/缓存写/缓存命中率/成本，两头分占）；**融合为单卡片：信息条与输入框/按钮行同处一张大卡片（.composer-stack 承载边框/背景/圆角/聚焦高亮，footer-card 与 session-stats-bar 透明化无分隔线）**；tooltip/加载中→英文；无新依赖）；**git 状态链路**：宿主 `readGitStatus`（git-status.ts：spawn `git status --porcelain --branch`，富化解析 `{branch,ahead,behind,trackedChanges,untracked}`——bracket 覆盖 `[ahead N,behind M]`/`[ahead N]`/`[behind N]`/`[gone]`；`??`→untracked、其余非 `## ` 行→trackedChanges；git 不可用/非仓库/超时 → null）+ `refreshSessionEnv`（**`gitStatus` 消息已更名 `sessionEnv`**：env = `{folderName: workspaceRoot basename, git}`，folderName 从捕获时 root 算 basename、fire 前校验 workspaceRoot 未变）+ 刷新时机 start/settle/切换/开关开启/保存文件（去抖 300ms，开关关闭短路）+ fire `{type:"sessionEnv"}` + snapshot 携带；**字体打包**：`media/fonts/MapleMono-NF-Regular.ttf`+**Bold**+**Italic**（+LICENSE.txt，SIL OFL 1.1，各 ~2.3MB）经 panel.ts `asWebviewUri` 注入三个 `@font-face`（400 normal / 700 normal / 400 italic），CSP `font-src` 放行；**2026-08-21 起作为全扩展统一字体**：styles.css `:root` 定义 `--pinel-font-family`/`--pinel-mono-font-family`（均以 `"Maple Mono NF"` 领先，回退 VS Code 字体），body/UI 文本/代码块全部经变量引用（2026-08-27 前会话信息条 git 分支图标用 U+F418 字型，现分支符号已换 lucide SVG——字体仅供 UI 文本）；**英文文案**：整个聊天面板 + 宿主 notice/error/删除确认（controller/session-history）用户可见文案全英文（注释保持中文）；测试：fake-pi get_session_stats 统计随会话/消息数派生（**switch_session 的 messages 赋值必须拷贝——引用赋值会被 prompt 流式 push 污染常量数组**），STATS-FAIL/STATS-NOCONTEXT 场景 env 激活
- **会话分支/回溯链路（fork/clone，2026-08-20 实现）**：header「分支」按钮（lucide git-fork，git 仓库分支风格）触发 ForkPopover 弹层——数据链路 `getForkMessages` 消息 → controller `getForkMessages()`（client.send get_fork_messages → `parseForkMessages` 防御解析（fork-messages.ts：entryId/text 非空字符串校验、部分损坏跳过、结构不符空列表）→ fire `{type:"forkMessages"}`）；**弹层生命周期 = close-on-select**（选中即关，失败仅 error notice 不重开——无 forkResult 消息，HostMessage 只增 forkMessages）；**runSessionChange 骨架**：switchSession/newSession/fork/clone 四者共用（不变量 a-e：早退双发 sessionSwitching:false / 置位在 ensureStarted+client 校验后 / cancelled 不走 afterSessionSwitch / 三处 client 身份校验（send 后 + afterSessionSwitch 内 get_messages/get_state 各一次）/ finally 复位；hook 形态 sendCommand/onCancelled/onSuccess/onError）；**afterSessionSwitch 重置 assembly/tools/todos**（2026-08-27 起待办随会话清零——旧会话 todo 快照不得残留，fireSnapshot 携带空列表）；**fork 成功后 pi 自动 rebind 新会话文件（不得再发 switch_session）**，被 fork 消息原文经既有 fillPrompt 机制回填输入框（替换草稿语义对齐 Ctrl+G；仅 `!cancelled && typeof text === "string"` 时——cancelled 时 pi 序列化省略 text 字段）；clone 无回填；**协议事实**：fork/clone 可被 session_before_fork 扩展钩子取消（data.cancelled:true）、clone 空会话（无 leaf）是 success:false error 而非 cancelled（rpc-mode.js:490）、get_fork_messages 仅返回非空 user 消息；**弹层数据与当前会话不匹配竞态**：App snapshot handler 在 sessionFile 变化时关 fork 弹层 + 清空 forkMessages；fork 列表 = 打开时快照语义不实时刷新；测试：fake-pi get_fork_messages 从内存态消息派生（entryId 用 **user 计数** `fork-msg-<n>` 而非数组索引——assistant/toolResult 交错）、fork 物理落盘经 `PINEL_FAKE_PI_SESSION_DIR` env 写入 `<timestamp>_<uuid>.jsonl`（header 对齐 pi createBranchedSession + 截断至 fork 点祖先链 + parentSession）、**FORK-FAIL/FORK-CANCELLED 场景检查必须先于 entryId 校验**（restart 后消息为空时场景仍生效）、流式中 fork 需 streaming=false+abortGeneration++ 复位流状态；集成测试：fork 全链路（sessionFile 变化/落盘可被 scanSessions 解析/消息截断/fillPrompt 回填/列表刷新）、clone（副本+切换）、FORK-FAIL/CANCELLED、空会话无效 entryId、流式中 fork
- **扩展管理链路（本地扩展 + packages，2026-08-21 实现）**：footer「扩展」按钮（lucide puzzle）触发 ExtensionPopover 弹层——数据链路 `getExtensionList` 消息 → controller `getExtensionList()`（纯文件扫描：`scanLocalExtensions`（全局 `<agentDir>/extensions` + 项目 `.pi/extensions`，镜像 pi collectAutoExtensionEntries 的 *.ts/.js + 子目录 index.ts 规则，跳过 dotfiles/node_modules + .gitignore/.ignore/.fdignore 过滤）+ `scanPackages`（settings.json packages 数组 + enabled 判定）合并 → fire `{type:"extensionList"}`；**agentDir 优先 `PI_CODING_AGENT_DIR` env**（默认 ~/.pi/agent，不硬编码）；**启停分流**：本地 = 文件重命名 `.ts/.js ↔ .disabled`（幂等可逆零 settings 耦合），包 = settings.json 字符串 ↔ 对象空数组 `{source, extensions:[], skills:[], prompts:[], themes:[]}`（applyPackageFilter 空数组=全禁用）；**卸载分流**：本地 = 删除文件/目录（fs.rm force+maxRetries），npm/git 包 = spawn `pi remove <source> [-l]`（复用 client.ts resolveSpawnSpec 的 Windows .cmd shim），本地路径包 = 删 settings 条目（pi remove 对 local source 抛 Unsupported remove source）；**settings.json 严格 JSON.parse（损坏中止绝不覆盖）+ 原子写（temp+rename）**；**修改后 reload 提示**：原生 `showInformationMessage("…","Reload")` → restart()（pi RPC 无 /reload）；卸载确认 seam `confirmExtensionUninstall` + reload seam `confirmExtensionReload`（独立导出供测试 stub）；**不设 running 门控**（纯文件操作，pi 未启动也能管理）；协议：入站 `setExtensionEnabled{id,kind,scope,enabled}` / `uninstallExtension{id,kind,scope,source,name}`；测试：extensions.test.ts 单测 + 集成测试经 `PI_CODING_AGENT_DIR` 临时目录激活（纯文件操作无需 restart）
- **模型状态自愈**：初始同步 get_state 最多 4 次尝试（间隔 2s/5s/10s），仍无模型时自动重启 pi 一次（在 `startWithHeal` 内顺序执行，**不走 restart 防重入守卫**——自愈常嵌套在手动重启链内会被守卫拦截）；`modelHealRestarted` 置位后短路为单次尝试，手动 restart 重置；`running` 在首次 get_state 成功后才置位（健康慢启动显示"启动中…"而非假警告）；运行中无模型由 App 状态横幅推导警告态（⚠ 无可用模型 + 重启按钮，2026-08-18 起替代 StatusBar 警告区），**不新增协议字段**；get_state 的 steeringMode/followUpMode/autoCompactionEnabled 三字段缺字段时保留默认值（all / one-at-a-time / true）

**Windows 专项约束（有回归测试 `src/test/spawn-spec.test.ts`）**：
- pi 启动解析：裸命令名经 `where.exe` 并**优先 `.cmd`/`.bat` 行**（PATH 中无扩展名 sh 脚本会遮蔽 shim）；`.cmd` 用 `cmd.exe /d /s /c` 包装且必须 `windowsVerbatimArguments: true`（Node 默认的反斜杠转义引号会破坏 cmd 解析）；cmd 路径用 ComSpec 反斜杠形式
- 进程终止：**优雅退出优先**——先关闭 stdin（pi RPC 模式在 EOF 时自行 flush 会话/释放锁并退出），优雅期 2.5s 后未退才硬杀：Windows `taskkill /pid <pid> /T /F`；POSIX spawn 需 `detached: true` 后负 PID 组 kill（SIGTERM → 2s 后 SIGKILL）——两侧都要杀整棵进程树（bash 工具子进程）；总时长 5s 契约（永不 reject、exit 事件先于 resolve 派发，`stop.test.ts` 覆盖两条路径）；stdin 需挂空 error 监听防异步 EPIPE

**安全约束**：
- webview CSP `default-src 'none'` + script nonce；markdown 用 react-markdown 且**不得启用 rehype-raw**
- 不把用户输入拼进 shell 命令字符串（piPath 配置除外——它本就是用户显式指定的本地命令）

**范围纪律**：以下功能属于 v0.2+，非明确需求不得提前实现：Plan Mode、edit diff 预览、@提及、同文件内分支/检查点/回退（文件内 rewind 依赖 pi RPC 游标移动能力，当前仅 TUI 支持；fork 式回溯已实现）。注：交互 UI（对话框卡片 + 待办面板）、/命令自动补全、问卷确认流程（ask_user_question 整卷 + 确认前修改 + 自动回填）、配置面板（footer 卡片 ⚙ 设置按钮触发 + 队列模式/自动压缩/模型思考内嵌列表，2026-08-18 起替代 `/settings` 命令入口与状态栏下拉）、模型/思考等级列表（`get_available_models`/`get_available_thinking_levels`/`set_model`/`set_thinking_level`，2026-08 实现）、会话重命名/删除（行内编辑 + 删除确认，2026-08-19 实现）、会话分支/回溯（fork 选择器弹层 + clone，2026-08-20 实现）与扩展管理（footer 扩展按钮 + ExtensionPopover 弹层 + 本地扩展/包启停卸载，2026-08-21 实现）均经用户明确要求提前实现（见 `src/chat/todos.ts`、`src/chat/questionnaire.ts`、`src/chat/models.ts`、`src/chat/session-history.ts`、`src/chat/extensions.ts`、`UiDialogs.tsx`、`Questionnaire.tsx`、`ConfigPopover.tsx`、`SessionListPopover.tsx`、`HistoryApp.tsx`、`SearchBox.tsx`、`ForkPopover.tsx`、`ExtensionPopover.tsx` 与 `webview-ui/src/command-match.ts`）。

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

**已有测试**（214 个，全部必须保持通过）：
- `framing.test.ts`：LF framing（U+2028、`\r\n`、粘包拆包）
- `stream-assembly.test.ts`：contentIndex 分块装配（多块交替、权威替换、乱序）
- `spawn-spec.test.ts`：Windows shim 解析（.cmd 包装、verbatim 参数、shell 模式）
- `stop.test.ts`：`RpcClient.stop()` 等待真实退出（exit 事件在 resolve 前派发、子进程已死）+ 优雅退出路径（stdin EOF 自退 exit code 0）+ 兜底硬杀路径（`PINEL_LONG_NO_EOF=1` 拒不退出）
- `todos.test.ts`：`parseTodoTasks` 防御解析（全量快照、部分损坏跳过、结构不符 null）
- `commands.test.ts`：`parseCommands` 防御解析（get_commands 响应：全量合法、部分损坏跳过、结构不符空列表、未知 source 兜底）
- `models.test.ts`：`parseModels`/`parseThinkingLevels` 防御解析（全量合法、部分损坏跳过、结构不符空列表、["off"] 原样解析）
- `fork-messages.test.ts`：`parseForkMessages` 防御解析（全量合法、部分损坏跳过、结构不符空列表、空列表原样返回）
- `extensions.test.ts`：`resolveAgentDir`/`packageDisplayName`/`scanLocalExtensions`（布局/排序/损坏跳过/.disabled 判定/dotfiles+node_modules 跳过/.gitignore 过滤）/`scanPackages`（字符串/对象空数组/部分过滤/autoload）/`setLocalExtensionEnabled` 重命名往返/`uninstallLocalExtension` 删除/`setPackageEnabled` round-trip 保其他键 + 损坏 JSON 不覆盖
- `questionnaire.test.ts`：`parseQuestionnaireArgs` 防御解析 + `parseQuestionnaireAnswer` 校验 + 回填映射（select 选项行/哨兵跟进标记、input 多选数字串/空串/自定义、标题归属）
- `session-stats.test.ts`：`parseSessionStats` 防御解析（全量合法/tokens 核心四项缺一 → null/total 缺省按四值之和/contextUsage 缺省与 null percent 容忍/cost 0 保留/部分损坏忽略不拖垮整体）
- `git-status.test.ts`：`parseGitStatus` 防御解析（干净分支/脏工作区/upstream+ahead-behind 剥离/detached HEAD/空输出与无 ## 头行 → null）+ `readGitStatus` 非 git 仓库目录回 null 不抛错
- `session-history.test.ts`：`encodeCwd`/`parseSessionMeta`/`scanSessions`（布局/排序/损坏跳过/大小写兑底）+ `appendSessionName`（追加可被 parseSessionMeta 解析/\r\n 清洗/仅 header 文件 parentId null/重命名两次取后一次/坏行跳过/空名抛错/**尾无换行先补 \n**/文件不存在抛错）
- `extension.test.ts`：集成测试（真实 VS Code + 假 pi：状态同步、端到端流式、abort、UI 自动取消、跨消息不串块、重启竞态回归、崩溃后重启恢复、模型自愈——NULLMODEL-FIRST 重试恢复无重启 / NULLMODEL-FOREVER 自动重启恰好一次后警告态、命令补全链路——启动送达/CMDADD settle 刷新/重启恢复不残留/NOCOMMANDS 旧版失败静默、问卷链路——整卷全链路含修改重答/取消无残留/通用对话框标题门控/**问卷重入——同 prompt 第二份问卷 id 变化 + 答案归零/答题广播后 id 稳定性断言（两次 getQuestionnaire id 相等且非空）**、用户消息去重——pi 的 user 事件不重复推送、配置面板——cycleModel 切下一模型且 thinkingLevel 同步/两模型循环回原点/cycleThinking 循环回绕/SINGLE-MODEL 回 null 不更新/NO-THINKING 回 null 不更新/CYCLE-FAIL 失败不更新/三种 set 命令状态更新/流式中切换不中断流/NOSTATE-FIELDS 缺字段保留默认值/重启后配置从状态文件恢复、模型/思考列表链路——getModels 送达全量/getThinkingLevels 送达/setModel 切换且思考等级经 get_state 回读（SETMODEL-CLAMP 同步为 medium）/setThinkingLevel 生效/SETMODEL-MISS 与 SETTHINK-FAIL error notice 状态不变/MODELS-FAIL 与 THINKLEVELS-FAIL warning notice 且空数组失败信号/THINKLEVELS-OFF 回 [off]/SETTHINK-CLAMP clamp 后回读确认/SETMODEL-READBACKFAIL 回读失败保留 set_model 结果/SETMODEL-SLOW 迟到响应 restart 不残留/流式中 setModel 不中断流、提示词编辑器——编辑→保存→回填→发送→关闭清理全链路/手动关标签页清理不回填/重复 Ctrl+G 关旧建新、聊天 header 会话列表——controller 实时扫描排序/元信息/损坏跳过/与历史视图扫描一致（共享链路）、会话标题广播——重启后 sessionTitle 消息送达（无真实文件 → undefined）、**/new 命令——本地拦截新建全链路（sessionFile 变化 + 消息清空 + message === "/new" 的 prompt 记录为 0）/带参数原样送达不新建/流式中 /new abort 后新建且无 steer 送达/带 fileRefs 原样发送（以 /new 开头含 <file> 注入）不新建**、**会话重命名/删除——非当前重命名追加 session_info + 列表立即刷新（不依赖 pi）/当前重命名 RPC 送达 + 落盘 + 标题刷新/RENAME-FAIL notice 且状态不变/删除非当前文件消失 + 刷新/删除当前拒绝 + 文件保留/删除确认 seam 拒绝与接受两路径**、**会话信息条——开关开启 status 同步 + 首拉统计广播（相对断言）/settle 后刷新（新回合统计增长）/切换后统计归属新会话/STATS-FAIL 无旧值不 fire 不弹 notice/STATS-NOCONTEXT contextUsage 缺省/开关持久化 restart 后保留且 start 回读恢复**、**会话分支/回溯——getForkMessages 送达（user 计数 entryId + 防御解析）/fork 全链路（sessionFile 变化 + 落盘可被 scanSessions 解析 + 消息截断至 fork 点 + fillPrompt 回填 + 列表刷新）/clone 副本切换/FORK-FAIL error notice 状态不变/FORK-CANCELLED info notice 不刷新不回填/空会话无效 entryId error notice/流式中 fork abort 后正常执行/切换后待办清零（TODOME 填充 → switchSession → 断言 getTodos 空）**、**扩展管理——getExtensionList 本地+包合并（enabled/filtered/scope 判定）/setExtensionEnabled 本地重命名往返 + 包 settings 编辑往返/uninstallExtension 本地删除 + 本地路径包 settings 条目移除/卸载确认 seam + reload seam 拒绝接受两路径**）
- `src/test-no-workspace/no-workspace.test.ts`：空窗口实例友好状态（no-workspace + 引导文本，不伪装成进程异常）

**新增功能覆盖要求**：
- 纯逻辑（framing/装配/spawn 解析类）→ 在 `src/test/` 加 mocha 单测，与现有 suite 风格一致
- 聊天行为/RPC 交互 → 扩展 `fixtures/fake-pi.js` 场景（新增 prompt 标记触发）后加集成测试，经 `PinelTestApi` 断言 controller 状态；**作用于首次 get_state 的场景**（如模型自愈）不能用 prompt 子串标记——首次 get_state 发生在任何 prompt 之前，改用环境变量 `PINEL_FAKE_PI_SCENARIO` 在 spawn 时激活（测试内先设 env 再 `api.restart()` 触发新进程，结束恢复 env + restart）
- 修改 RPC 命令/事件处理必须同步更新 `protocol.ts` 类型与假 pi
- 配置切换（cycle_model 等）与模型/思考列表（get_available_models/set_model/get_available_thinking_levels/set_thinking_level）经 `PINEL_FAKE_PI_SCENARIO` 环境变量场景激活（SINGLE-MODEL/NO-THINKING/CYCLE-FAIL/NOSTATE-FIELDS/MODELS-FAIL/THINKLEVELS-OFF/THINKLEVELS-FAIL/SETMODEL-CLAMP/SETMODEL-SLOW/SETMODEL-READBACKFAIL/SETTHINK-CLAMP/SETTHINK-FAIL）；**会话重命名失败路径经 `PINEL_FAKE_PI_SCENARIO=RENAME-FAIL` 激活**（set_session_name 回 success:false；fake-pi 的 set_session_name 成功时向 currentSessionFile **物理追加 session_info 条目**——标题/列表断言依赖真实落盘，勿改回仅内存态）；**会话统计失败/无上下文经 `STATS-FAIL`/`STATS-NOCONTEXT` 激活**（get_session_stats 由 settle 自动触发、无 prompt 关联，必须 env 激活；fake-pi 统计随消息数/会话派生）；假 pi 的「重启后配置恢复」经 `PINEL_FAKE_PI_STATE` 状态文件模拟 pi 的 settings 持久化（测试用唯一路径防跨运行污染，结束删除文件 + 恢复 env + restart）；fake-pi 的 `stateData()` 流式中回真实 `isStreaming`（客户端 set_model/set_thinking_level 后 get_state 回读依赖它，勿改回硬编码 false）

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
