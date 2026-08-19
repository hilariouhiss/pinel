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
| `src/chat/` | 聊天层：`controller.ts`（会话控制器：事件映射/流装配/状态广播 + 会话重命名/删除：renameSession 双路径——当前会话 RPC set_session_name / 非当前 appendSessionName + deleteSession + confirmSessionDelete 确认 seam）、`panel.ts`（WebviewViewProvider + postMessage 协议 + CSP HTML）、`session-history.ts`（会话目录扫描纯函数：scanSessions/encodeCwd/SessionListItem/toItem/resolveSessionsRoot + appendSessionName（向会话文件追加 session_info 显示名，格式对齐 pi），provider 与 controller 共用）、`session-history-provider.ts`（主侧边栏会话历史视图）、`file-scanner.ts`（工作区文件扫描纯函数：gitignore 过滤 + 上限截断 + 图片判定，@ 添加文件数据源）、`stream-assembly.ts`（contentIndex 分块装配纯函数）、`todos.ts`（todo 工具结果快照解析纯函数）、`commands.ts`（get_commands 响应防御解析纯函数）、`models.ts`（get_available_models/get_available_thinking_levels 响应防御解析纯函数）、`questionnaire.ts`（ask_user_question 问卷参数解析与回填映射纯函数）、`prompt-editor.ts`（Ctrl+G 提示词编辑器：临时文件 + 保存回填 + 发送清理） |
| `src/extension.ts` | 入口：activate/deactivate、命令注册、面板注册、导出 `PinelTestApi` 测试钩子 |
| `src/test/` | 单元测试 + 集成测试 + `fixtures/fake-pi.js`（按 rpc.md 实现的假 pi）、`fixtures/long-running.js`（stop 测试用长命进程） |
| `src/test-no-workspace/` | 空窗口实例集成测试（独立 .vscode-test.mjs 配置，不传 workspaceFolder 启动） |
| `scripts/` | 测试辅助脚本（clean-test-userdata.mjs：每次 npm test 前清理 .vscode-test/user-data） |
| `webview-ui/` | React 聊天 UI（独立 tsconfig 与 esbuild 配置，与宿主完全隔离） |
| `media/` | 图标（send/settings/stop/history/new-session/search/add/edit/delete.svg 经 esbuild text loader 内联进 webview bundle、pinel-icon.svg 为扩展图标，均入库）；webview 构建产物（gitignored，构建生成） |

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
│  ├─ src/components/      # Composer（footer 卡片） / MessageView / Markdown / Notices / StatusBar（已删） / UiDialogs / TodoPanel / Questionnaire / ConfigPopover（含模型/思考内嵌列表） / SessionListPopover（含行内编辑重命名/删除） / SearchBox / ListPopover（已删）
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
- 质量门：`npm run compile` 与 `npm test` 必须全绿（当前 145/145 通过：主套件 142 + 空窗口套件 3）

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
- **提示词编辑器链路（Ctrl+G）**：键位经 package.json keybinding 注册（`ctrl+g → pinel.editPrompt`，when `pinel.inputFocused` 由 webview textarea focus/blur 事件 → `inputFocus` 消息 → 宿主 setContext 维护）——**webview 内 keydown 捕获不可行**（Ctrl+G 是 VS Code 默认全局键 gotoLine，工作台 capture 阶段拦截，vscode#320435/#139163）；命令执行 → `triggerEditPrompt` → webview 回发 `editPrompt{text}`（宿主不维护输入状态）→ `PromptEditorManager.edit` 开临时文件（`os.tmpdir()/pinel-prompt-<ts>.md`，preview:false 固定标签）；**载体必须真实文件**（untitled 保存不触发 onDidSaveTextDocument，vscode#25729）；保存 → `fillPrompt{text}` 回填输入框（**行尾规范化 `\r\n`→LF**——Windows 编辑器保存自动转换）；发送（sendPrompt 含早退分支）→ `disposeForSend`（先清 pendingUri 防双删竞态 → tabGroups.close → fs.rm 带 maxRetries 防 Windows 句柄占用）；**标签页关闭监听必须用 `tabGroups.onDidChangeTabs`（event.closed）而非 `onDidCloseTextDocument`**（后者跟踪文档对象生命周期，延迟数分钟，vscode#199282/#84505）；已确认坑：tabGroups.close 是 TabGroups 方法不是 TabGroup 方法；测试驱动 api.editPrompt + TestEventLog lastFillPrompt；F5 需验证 keybinding when 覆盖默认 gotoLine 是否生效（失效降级 Ctrl+Alt+G 已备）
- **@ 添加文件链路**：输入框末 token 以 `@` 开头触发文件补全弹窗（`getFileList` 消息 → `file-scanner.ts` 扫描工作区：ignore 包（^5.3.2，唯一运行时依赖）gitignore 过滤 + 硬编码跳过 .git/node_modules + 上限 1000 + 图片扩展名判定）→ `fileList` 响应 → 选中后附件区卡片 → 发送时 `sendPrompt` 带 fileRefs → controller **自读自拼**（实证：pi RPC 模式不支持 CLI @file 参数，main.js:508 直接报错——pinel 文本按 `<file name="绝对路径">` 格式注入对齐 pi CLI file-processor、图片转 base64 附件 + 空 `<file name>` 引用，2MB 截断，失败 notice 跳过）；**用户消息显示层剥离 `<file>` markup**（MessageView userText 替换为 📎 引用行——settle 后权威消息含整段文件内容，直接渲染会气泡突变）；踩坑：ignore 目录剪枝必须尾斜杠（`ig.ignores('dist/')`）、Windows 路径 / 分隔、测试日志结构 `{t, record:{dir, record:请求}}` 提取需双层 record
- **问卷链路（ask_user_question）**：插件逐题串行阻塞、已提交答案不可撤回——pinel 从 `tool_execution_start`（toolName `ask_user_question`）的完整参数在本地渲染整卷问卷，pi 发来的串行 select/input **标题门控后缓冲不展示**（不匹配题目的对话框走逐卡路径），用户答完确认后按游标自动回填（单选：选项原行/哨兵行+跟进 input；多选：`"1,3"` 数字串或空串；哨兵取 `request.options` 末项不硬编码文案）；**settled/handleExit/restart 清理时必须先对残留缓冲帧逐帧回 cancelled**（插件问卷无 timeout，pi 侧不会自动解锁，否则 agent 永久阻塞）；用户消息事件（pi 也发 message_start/message_end）必须门控跳过防重复显示（乐观渲染保留，权威列表走快照）
- **配置面板链路**：footer 卡片下半 ⚙ 设置按钮（`status-settings-btn`，settings.svg 图标）触发 ConfigPopover（2026-08-18 回归——此前因 emoji ⚙ 图标过小改为 `/settings` 命令触发，现以正式 SVG 图标恢复按钮入口，`/settings` 本地拦截逻辑已移除、输入恢复为普通文本发送；footer 卡片化后按钮位于卡片下半左）；webview 本地开合，点击外部/Esc 关闭，Esc 在 window capture 阶段拦截并 stopPropagation 让位于 Composer 的中断/清空分支；面板含队列模式双值点选（`set_steering_mode`/`set_follow_up_mode`）、自动压缩开关（`set_auto_compaction`）与**模型/思考强度内嵌展开列表**（2026-08-18 从状态栏下拉移入；展开状态在 App（`expandedSection`），空数组失败信号收起展开区且面板保持打开）
- **SVG 图标链路（send/settings/stop/history/new-session/search/add/edit/delete.svg）**：文件入库 `media/`（`.gitignore` 仅忽略 webview.js/css/map）；webview 侧经 esbuild `--loader:.svg=text` 以原始文本内联进 bundle（`webview-ui/esbuild.js` 的 loader 配置 + `global.d.ts` 的 `declare module "*.svg"`），`dangerouslySetInnerHTML` 渲染进 DOM（静态自有文件，无注入风险；CSP `img-src data:` 不涉及）；主题自适应靠 **path 级 CSS 选择器**覆盖（`.composer-send .icon path` → `--vscode-button-foreground`、`.composer-stop .icon path` → `--vscode-errorForeground`、`.status-settings-btn .icon path` / `.chat-history-btn .icon path` / `.chat-new-session-btn .icon path` / `.search-box-icon .icon path` → `--vscode-descriptionForeground`、`.history-new-button .icon path` → `currentColor`、`.history-item-edit .icon path` / `.history-item-delete .icon path` → `--vscode-descriptionForeground`（delete hover → `--vscode-errorForeground`；active 行 → `--vscode-list-activeSelectionForeground`））——fill 是 `<path>` 上的 presentation attribute，**根元素级选择器无法通过继承覆盖**，必须直接命中 path（specificity 0-2-1）；文件内 `#707070` 保留作兜底；图标 16px（搜索 14px、history-item 操作图标 14px）由作用域化规则覆写（文件内硬编码 200px）
- **模型/思考等级列表链路**：设置面板内「模型」「思考强度」行点击展开内嵌列表（展开状态在 App `expandedSection`；数据每次展开时拉取 `get_available_models`/`get_available_thinking_levels`，30s 超时；失败 notice + fire 空数组作为失败信号，webview 收到空数组**收起展开区**（面板保持打开））；选中发 `set_model{provider,modelId}`/`set_thinking_level{level}`（**选中后面板保持打开仅收起展开区**）；**set_model 响应只有 Model 对象（不含 thinkingLevel）**——pi 切模型会重新锎制思考等级并持久化 settings，必须先应用响应 model 再 `get_state` 回读刷新 model+thinkingLevel（回读失败 notice，保留 set_model 结果）；**set_thinking_level 响应无 data 且 pi 有 clamp 语义**——成功后同样 `get_state` 回读确认实际生效值；响应应用前必须校验 `this.client === client`（restart 竞态迟到响应丢弃）；防御解析在 `src/chat/models.ts`（模型项须 id/name/provider 非空字符串——set_model 依赖 provider+modelId 复合键，跨 provider 的 id 可能重复，列表项用复合键）；流式中允许切换（变更自下一回合生效）；`status.model === null` 时思考行隐藏；`cycle_model`/`cycle_thinking_level` 保留供测试覆盖（UI 不再使用）
- **会话重命名/删除链路（edit/delete.svg，2026-08-19 实现）**：会话列表（主侧边栏 HistoryApp + header 弹层 SessionListPopover，共用 history-item 结构）行右侧 hover 显示操作按钮——**history-item 是 div 容器**（原 button 无法嵌套按钮），内含 button.history-item-main（点击切换）+ div.history-item-actions（edit/delete 图标按钮，opacity 0 → hover/focus-within 显示）；行内编辑（editingPath 本地状态，input 替换名称 span，Enter 提交/optimistic 退出/Esc 取消/blur 取消）——**弹层全局 Esc 是 window capture 监听（先于 React 冒泡委托执行），input 侧 stopPropagation 不可行**，capture handler 内对 `closest('.history-item-edit-input')` 豁免实现两段式 Esc（只豁免编辑 input 类名，SearchBox 关窗行为保留）；**重命名双路径**：当前会话（path===sessionFile）→ RPC `set_session_name`（实测 pi 0.84.x 有、**docs/rpc.md 未收录**，trim 空名报错；成功后 force 重解析标题——lastTitleSessionFile 去重键 reset），非当前会话 → 宿主 `appendSessionName` 直接向 .jsonl 追加 session_info 条目（格式对齐 pi appendSessionInfo：id uuid8 查重/parentId=最后非 header 条目 id（**必须全文件扫描**，MAX_SCAN_LINES 是显示层截断）/timestamp/name 清洗，尾无换行先补 \n）；空名在 controller 双路径统一拦截视为取消；非当前操作是纯文件操作**不受 client running 守卫限制**；**删除无 pi RPC**（rpc-types 全命令确认）→ 宿主 fs.rm force:true + maxRetries（Windows 句柄），当前会话禁止删除（webview 禁用 + controller 执行时二次校验），删除前 modal 确认抽为**共享 seam `confirmSessionDelete`（controller.ts 导出，聊天面板与历史视图两个 handler 共用，controller 本体不内置——PinelTestApi 直调不卡确认框）**；成功后 fire `sessionListRefresh`（新 OutMessage：provider 立即 refresh 绕 5s 节流，连带重置节流窗口属良性；**必须同步加入 webview types.ts HostMessage 镜像**——App.tsx switch 无 default 分支）；聊天面板弹层数据由 panel 操作成功后重拉 getSessionList post sessionList 覆盖；测试：fake-pi set_session_name 向 currentSessionFile **物理落盘**（RENAME-FAIL 场景回 success:false），删除确认路径 stub vscode.window.showWarningMessage + 直调 seam
- **模型状态自愈**：初始同步 get_state 最多 4 次尝试（间隔 2s/5s/10s），仍无模型时自动重启 pi 一次（在 `startWithHeal` 内顺序执行，**不走 restart 防重入守卫**——自愈常嵌套在手动重启链内会被守卫拦截）；`modelHealRestarted` 置位后短路为单次尝试，手动 restart 重置；`running` 在首次 get_state 成功后才置位（健康慢启动显示"启动中…"而非假警告）；运行中无模型由 App 状态横幅推导警告态（⚠ 无可用模型 + 重启按钮，2026-08-18 起替代 StatusBar 警告区），**不新增协议字段**；get_state 的 steeringMode/followUpMode/autoCompactionEnabled 三字段缺字段时保留默认值（all / one-at-a-time / true）

**Windows 专项约束（有回归测试 `src/test/spawn-spec.test.ts`）**：
- pi 启动解析：裸命令名经 `where.exe` 并**优先 `.cmd`/`.bat` 行**（PATH 中无扩展名 sh 脚本会遮蔽 shim）；`.cmd` 用 `cmd.exe /d /s /c` 包装且必须 `windowsVerbatimArguments: true`（Node 默认的反斜杠转义引号会破坏 cmd 解析）；cmd 路径用 ComSpec 反斜杠形式
- 进程终止：**优雅退出优先**——先关闭 stdin（pi RPC 模式在 EOF 时自行 flush 会话/释放锁并退出），优雅期 2.5s 后未退才硬杀：Windows `taskkill /pid <pid> /T /F`；POSIX spawn 需 `detached: true` 后负 PID 组 kill（SIGTERM → 2s 后 SIGKILL）——两侧都要杀整棵进程树（bash 工具子进程）；总时长 5s 契约（永不 reject、exit 事件先于 resolve 派发，`stop.test.ts` 覆盖两条路径）；stdin 需挂空 error 监听防异步 EPIPE

**安全约束**：
- webview CSP `default-src 'none'` + script nonce；markdown 用 react-markdown 且**不得启用 rehype-raw**
- 不把用户输入拼进 shell 命令字符串（piPath 配置除外——它本就是用户显式指定的本地命令）

**范围纪律**：以下功能属于 v0.2+，非明确需求不得提前实现：Plan Mode、edit diff 预览、@提及、检查点/回退。注：交互 UI（对话框卡片 + 待办面板）、/命令自动补全、问卷确认流程（ask_user_question 整卷 + 确认前修改 + 自动回填）、配置面板（footer 卡片 ⚙ 设置按钮触发 + 队列模式/自动压缩/模型思考内嵌列表，2026-08-18 起替代 `/settings` 命令入口与状态栏下拉）、模型/思考等级列表（`get_available_models`/`get_available_thinking_levels`/`set_model`/`set_thinking_level`，2026-08 实现）与会话重命名/删除（行内编辑 + 删除确认，2026-08-19 实现）均经用户明确要求提前实现（见 `src/chat/todos.ts`、`src/chat/questionnaire.ts`、`src/chat/models.ts`、`src/chat/session-history.ts`、`UiDialogs.tsx`、`Questionnaire.tsx`、`ConfigPopover.tsx`、`SessionListPopover.tsx`、`HistoryApp.tsx`、`SearchBox.tsx` 与 `webview-ui/src/command-match.ts`）。

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

**已有测试**（145 个，全部必须保持通过）：
- `framing.test.ts`：LF framing（U+2028、`\r\n`、粘包拆包）
- `stream-assembly.test.ts`：contentIndex 分块装配（多块交替、权威替换、乱序）
- `spawn-spec.test.ts`：Windows shim 解析（.cmd 包装、verbatim 参数、shell 模式）
- `stop.test.ts`：`RpcClient.stop()` 等待真实退出（exit 事件在 resolve 前派发、子进程已死）+ 优雅退出路径（stdin EOF 自退 exit code 0）+ 兜底硬杀路径（`PINEL_LONG_NO_EOF=1` 拒不退出）
- `todos.test.ts`：`parseTodoTasks` 防御解析（全量快照、部分损坏跳过、结构不符 null）
- `commands.test.ts`：`parseCommands` 防御解析（get_commands 响应：全量合法、部分损坏跳过、结构不符空列表、未知 source 兜底）
- `models.test.ts`：`parseModels`/`parseThinkingLevels` 防御解析（全量合法、部分损坏跳过、结构不符空列表、["off"] 原样解析）
- `questionnaire.test.ts`：`parseQuestionnaireArgs` 防御解析 + `parseQuestionnaireAnswer` 校验 + 回填映射（select 选项行/哨兵跟进标记、input 多选数字串/空串/自定义、标题归属）
- `session-history.test.ts`：`encodeCwd`/`parseSessionMeta`/`scanSessions`（布局/排序/损坏跳过/大小写兑底）+ `appendSessionName`（追加可被 parseSessionMeta 解析/\r\n 清洗/仅 header 文件 parentId null/重命名两次取后一次/坏行跳过/空名抛错/**尾无换行先补 \n**/文件不存在抛错）
- `extension.test.ts`：集成测试（真实 VS Code + 假 pi：状态同步、端到端流式、abort、UI 自动取消、跨消息不串块、重启竞态回归、崩溃后重启恢复、模型自愈——NULLMODEL-FIRST 重试恢复无重启 / NULLMODEL-FOREVER 自动重启恰好一次后警告态、命令补全链路——启动送达/CMDADD settle 刷新/重启恢复不残留/NOCOMMANDS 旧版失败静默、问卷链路——整卷全链路含修改重答/取消无残留/通用对话框标题门控、用户消息去重——pi 的 user 事件不重复推送、配置面板——cycleModel 切下一模型且 thinkingLevel 同步/两模型循环回原点/cycleThinking 循环回绕/SINGLE-MODEL 回 null 不更新/NO-THINKING 回 null 不更新/CYCLE-FAIL 失败不更新/三种 set 命令状态更新/流式中切换不中断流/NOSTATE-FIELDS 缺字段保留默认值/重启后配置从状态文件恢复、模型/思考列表链路——getModels 送达全量/getThinkingLevels 送达/setModel 切换且思考等级经 get_state 回读（SETMODEL-CLAMP 同步为 medium）/setThinkingLevel 生效/SETMODEL-MISS 与 SETTHINK-FAIL error notice 状态不变/MODELS-FAIL 与 THINKLEVELS-FAIL warning notice 且空数组失败信号/THINKLEVELS-OFF 回 [off]/SETTHINK-CLAMP clamp 后回读确认/SETMODEL-READBACKFAIL 回读失败保留 set_model 结果/SETMODEL-SLOW 迟到响应 restart 不残留/流式中 setModel 不中断流、提示词编辑器——编辑→保存→回填→发送→关闭清理全链路/手动关标签页清理不回填/重复 Ctrl+G 关旧建新、聊天 header 会话列表——controller 实时扫描排序/元信息/损坏跳过/与历史视图扫描一致（共享链路）、会话标题广播——重启后 sessionTitle 消息送达（无真实文件 → undefined）、**会话重命名/删除——非当前重命名追加 session_info + 列表立即刷新（不依赖 pi）/当前重命名 RPC 送达 + 落盘 + 标题刷新/RENAME-FAIL notice 且状态不变/删除非当前文件消失 + 刷新/删除当前拒绝 + 文件保留/删除确认 seam 拒绝与接受两路径**）
- `src/test-no-workspace/no-workspace.test.ts`：空窗口实例友好状态（no-workspace + 引导文本，不伪装成进程异常）

**新增功能覆盖要求**：
- 纯逻辑（framing/装配/spawn 解析类）→ 在 `src/test/` 加 mocha 单测，与现有 suite 风格一致
- 聊天行为/RPC 交互 → 扩展 `fixtures/fake-pi.js` 场景（新增 prompt 标记触发）后加集成测试，经 `PinelTestApi` 断言 controller 状态；**作用于首次 get_state 的场景**（如模型自愈）不能用 prompt 子串标记——首次 get_state 发生在任何 prompt 之前，改用环境变量 `PINEL_FAKE_PI_SCENARIO` 在 spawn 时激活（测试内先设 env 再 `api.restart()` 触发新进程，结束恢复 env + restart）
- 修改 RPC 命令/事件处理必须同步更新 `protocol.ts` 类型与假 pi
- 配置切换（cycle_model 等）与模型/思考列表（get_available_models/set_model/get_available_thinking_levels/set_thinking_level）经 `PINEL_FAKE_PI_SCENARIO` 环境变量场景激活（SINGLE-MODEL/NO-THINKING/CYCLE-FAIL/NOSTATE-FIELDS/MODELS-FAIL/THINKLEVELS-OFF/THINKLEVELS-FAIL/SETMODEL-CLAMP/SETMODEL-SLOW/SETMODEL-READBACKFAIL/SETTHINK-CLAMP/SETTHINK-FAIL）；**会话重命名失败路径经 `PINEL_FAKE_PI_SCENARIO=RENAME-FAIL` 激活**（set_session_name 回 success:false；fake-pi 的 set_session_name 成功时向 currentSessionFile **物理追加 session_info 条目**——标题/列表断言依赖真实落盘，勿改回仅内存态）；假 pi 的「重启后配置恢复」经 `PINEL_FAKE_PI_STATE` 状态文件模拟 pi 的 settings 持久化（测试用唯一路径防跨运行污染，结束删除文件 + 恢复 env + restart）；fake-pi 的 `stateData()` 流式中回真实 `isStreaming`（客户端 set_model/set_thinking_level 后 get_state 回读依赖它，勿改回硬编码 false）

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
