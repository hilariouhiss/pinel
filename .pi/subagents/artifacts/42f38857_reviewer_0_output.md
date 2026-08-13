核查完毕。本地无 VS Code 安装、无 `@types/vscode`，无法离线验证 auxiliarybar 断言；`pi --version` 已在 dist/cli/args.js 确认存在；"speak" 模式在 pi 文档与 dist 中均无踪迹。以下为评审结果。

---

## Review

### 一、协议正确性核验（与 docs/rpc.md 逐项比对）— 总体一致 ✅

- **Framing 规则**（§2.2）：LF 唯一分隔、容忍尾部 `\r`、禁用 Node `readline`（U+2028/U+2029）— 与 rpc.md "Framing" 节逐字一致 ✅
- **命令集**（§2.2）：`prompt`（含 `images`、`streamingBehavior: "steer"`）、`steer`、`abort`、`get_state`、`get_available_models`、`get_messages` 全部存在于 rpc.md，参数名/语义正确 ✅
- **事件清单**（§2.2）：`agent_start/agent_end`、`message_start/message_end`、`message_update`、`tool_execution_start/update/end`、`queue_update`、`extension_error` 均存在于 rpc.md 事件表 ✅
- **id 关联**：响应带同 id、`bash_execution_update` 带来源命令 id — 与 rpc.md 一致 ✅
- **`pi --version`** 检测安装：已在 pi dist/cli/args.js:22,285 确认 `--version`/`-v` 存在 ✅
- **崩溃恢复用 get_messages 回放**：pi 默认按 cwd 续接最近会话，spawn 后 get_messages 返回全量历史，方案自洽 ✅

### 二、发现的问题（按严重度排序）

**1. [遗漏/高] agent_settled 未纳入事件清单**（§2.2 事件列表、§3 任务 4）
rpc.md 明确 `agent_end` 只是"一次低层 agent run 完成，之后仍可能有 retry、compaction 或排队 continuation"。v0.1 包含 steer 队列（"流式中输入自动转 steer"），若 UI 以 `agent_end` 判定"流式结束/空闲"，在排队消息或自动重试场景会过早复位状态。建议：订阅 `agent_settled` 作为最终空闲信号（或轮询 `get_state.isStreaming` 兜底），`agent_end` 仅用于刷新消息列表。

**2. [遗漏/高] extension_ui_request/response 子协议未处理**（§2.2、§3 任务 6）
rpc.md 与 extensions.md:2902 均明确：RPC 模式 `ctx.hasUI === true`，扩展调用 `ui.select/confirm/input/editor` 会在 stdout 发 `extension_ui_request` 并阻塞等待 `extension_ui_response`；**无 timeout 的对话框若客户端不应答，agent 会永久阻塞**。v0.1 虽无权限确认 UI，但用户已安装的扩展/技能可能触发（如 skill 流程中的 `ctx.ui.confirm`）。建议：最低限度在 RpcClient 识别 `extension_ui_request` 并自动回复 `{"type":"extension_ui_response","id":...,"cancelled":true}`；fire-and-forget 类（notify/setStatus）可忽略或转状态栏。至少应在计划中写明"忽略"决策及后果。

**3. [遗漏/高] message_update 流式装配缺少 contentIndex 块跟踪**（§2.2/§2.3、§3 任务 5）
rpc.md 明确：`message_update` **不再携带累计 message 字段**，客户端必须用 `message_start` + 按 `contentIndex` 的增量组装部分消息，并以 `message_end.message` 为权威。计划只写"文本/thinking 增量"，若渲染器简单追加 delta，thinking 与 text 多块交替（contentIndex 0,1,2…）时会错位。建议：协议类型与 webview 渲染按 contentIndex 维护分块（text/thinking 各自累积），`message_end` 后整体替换为权威消息。

**4. [歧义/中] WebviewView 隐藏/重显的状态重放未定义**（§3 任务 5/6）
计划只写了"webview dispose 时解除订阅"。副侧边栏视图隐藏（切走/折叠）时 webview 会被销毁，重新显示会再次调用 `resolveWebviewView`；若流式中切走再切回，仅靠 `get_messages` 无法恢复未结束的增量消息（部分消息在 `message_end` 前不在历史里）。建议：明确 ChatController 持有内存消息缓冲，re-resolve 时全量重发当前状态；或设置 `retainContextWhenHidden: true` 并评估内存代价。

**5. [歧义/低] "speak 同款 RPC 协议"**（§3 任务 7）
pi 的 docs（usage.md 等）与 dist 中均无 speak 模式（grep 无匹配），疑为笔误或残留措辞。建议改为"实现与 rpc.md 一致的假 pi Node 脚本（确定性事件流）"。

**6. [边界/中] 进程树终止未覆盖**（§2.2 生命周期、§5 风险表）
`deactivate()` 时 `child.kill()` 只杀 pi 主进程；pi 的 bash 工具会派生子 shell（docs/windows.md 显示 pi 依赖 bash），可能遗留孤儿进程（如未完成的长命令）。建议：Windows 用 `taskkill /pid <pid> /T /F`，POSIX 用进程组负 PID `kill`（或 tree-kill 类库）。

**7. [遗漏/低] Windows 运行前提未提**（§5 风险表、§3 任务 8 文档）
docs/windows.md：pi 在 Windows 依赖 bash（Git Bash 等）。README 应列明该依赖；"未安装检测"可顺带检测 bash 缺失并给出提示。

**8. [遗漏/中] 命令失败路径未写明**（§3 任务 4/6）
rpc.md：`prompt` 被拒（preflight 拒绝）返回 `success: false` + `error`（如"流式中未带 streamingBehavior"）；响应也可能不带 id。计划未写明 success:false 的 UI 呈现与无 id 响应的兜底关联。建议：命令封装统一处理 `success:false` → 错误提示；无 id 响应按 `command` 字段兜底。

**9. [歧义/低] 脚手架生成到"已有空仓库根"的执行细节缺失**（§3 任务 1）
`yo code` 为交互式生成器，通常新建以扩展名命名的子目录；计划中 `--destination .` 与 `<选项>` 是否受支持未核实（且"无 @vscode/create-extension"断言无法离线核实）。建议：写明具体操作（生成到临时子目录后上移文件，或确认 `yo code` 的 destination/headless 选项），执行前验证。

**10. [断言待核实/低] "VS Code API 无法编程式将视图固定到副侧边栏"**（§2.1 决策表、§5 风险表）
VS Code 1.85+ 的 `contributes.viewsContainers` 支持声明 `"location": "auxiliarybar"` 将容器直接贡献到辅助栏（本机无 VS Code 安装，无法离线验证该版本行为）。建议：任务 2 先尝试 manifest 声明 location，若在目标 engine 版本生效则免去用户拖拽；不行再保留 README 一次性拖拽说明。

**11. [遗漏/低] 空工作区未处理**（§2.1 多工作区决策、§3 任务 3 spawn cwd）
`workspace.workspaceFolders` 为空（无文件夹打开）时 `workspaceRoot` 无定义，spawn 的 cwd 无从谈起。建议：面板显示"请先打开一个文件夹"错误态。

**12. [遗漏/低] 两个协议细节未指明**（§2.3、§3 任务 3）
- RPC 图片格式为 `{"type":"image","data":...,"mimeType":...}`，与 SDK 的 `source:{type:"base64",...}` 不同，计划 §2.3 未指明采用前者，易混淆；建议在 protocol.ts 明确并加注释。
- `get_state` 的 `model` 可能为 `null`（未认证/无可用模型），状态栏需处理 null 分支。

### 三、其他核查结论

- **任务顺序与依赖**（§3）：1→2/3→4→5→6→7→8→9 顺序合理，无环；测试（任务 7）依赖 3-6，位置正确 ✅
- **Windows .cmd shim**：风险识别准确，双方案（解析真实路径 / `spawn(process.execPath, [cliJs,...])`）均可行，且列为任务 3 必测项 ✅
- **风险表**：已覆盖 readline、XSS（CSP+DOMPurify）、多根工作区、协议漂移，质量好 ✅
- **Esc 行为**：流式时中断已定义，但空闲时 Esc 行为（清空输入？无操作？）未定义，属极小歧义，可在任务 5 一并写明。

### 总体结论

**需修订（小幅）**。计划架构正确、与 rpc.md 的协议引用高度一致，无阻断级（blocker）问题，任务拆解整体可执行。需在计划中补充/澄清的主要是：① `agent_settled` 空闲判定；② `extension_ui_request` 子协议的显式决策（防止 agent 静默阻塞）；③ `message_update` 的 contentIndex 块装配；④ WebviewView 隐藏重显的状态重放。其余为低严重度澄清项（#5-#12），可在对应任务中顺带补齐。建议修订后无需重审架构，仅复核上述补充点。