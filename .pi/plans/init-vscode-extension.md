# 计划：初始化 Pinel — Pi 的 VS Code 扩展仓库

> 状态：待用户最终确认（/plan 轮次，仅规划未实现；全部决策点已定稿）
> 日期：2026-08-13
> 目标仓库：`C:/source_code/Other/pinel`（当前为空 git 仓库）

## 1. 背景与目标

为 Pi（`@earendil-works/pi-coding-agent`）开发一个类似 Claude Code 官方插件的 VS Code 扩展，仓库名 **pinel**。让用户在 VS Code 内通过图形聊天面板使用 Pi 的智能体能力，而无需切换终端。

**v0.1（本计划范围，已与用户确认）**：核心聊天体验

- 副侧边栏聊天面板（WebviewView）
- 流式渲染：文本 delta、thinking（可折叠）、工具调用卡片（开始/更新/结束状态）
- Esc / 按钮中断（RPC `abort`）
- 图片附件（粘贴/选择，base64 随 prompt 发送）
- 显示当前模型与思考等级（RPC `get_state` / `get_available_models`）
- Pi 进程异常处理（未安装、崩溃、重启）

**明确不在 v0.1**（留待 v0.2+）：会话列表/切换/重命名、Plan Mode 开关、edit diff 预览、@提及文件、检查点/回退、权限确认 UI。

## 2. 方案设计

### 2.1 总体架构（已确认：RPC 子进程模式）

与 Claude Code 官方插件同款架构：扩展宿主 spawn `pi --mode rpc` 子进程，JSONL over stdio 通信。扩展本身是"薄客户端"，认证/技能/扩展/会话全部由 pi 进程管理。

```
┌────────────────────────────────────────────┐
│ VS Code Extension Host (Node)              │
│  ┌──────────────────────────────────────┐  │
│  │ WebviewView（副侧边栏，React 聊天 UI）│  │
│  └───────────────┬──────────────────────┘  │
│                  │ postMessage              │
│  ┌───────────────▼──────────────────────┐  │
│  │ ChatController（会话生命周期/流状态）  │  │
│  │ RpcClient（spawn + JSONL 编解码 + id   │  │
│  │            关联 + 事件分发）           │  │
│  └───────────────┬──────────────────────┘  │
└──────────────────┼─────────────────────────┘
              stdin/stdout（严格 LF JSONL）
┌──────────────────▼─────────────────────────┐
│ pi --mode rpc（子进程，cwd = 工作区根目录） │
└────────────────────────────────────────────┘
```

**关键取舍**：

| 决策 | 选择 | 理由 |
|---|---|---|
| 集成方式 | RPC 子进程 | 用户已确认。进程隔离、复用用户已装 pi（认证/技能/扩展天然可用）、不随 pi 升级损坏、无扩展宿主 Node 版本耦合 |
| UI 容器 | 副侧边栏 WebviewView | 用户已确认。**执行期实测**：官方 contribution point 文档确认声明式 `viewsContainers` 仅支持 `activitybar`/`panel`，无 `location`/auxiliarybar 键 → 采用 activitybar 容器 + README 一次性拖拽说明（VS Code 会记忆位置） |
| Webview 框架 | React 19 + esbuild 打包（已确认） | 聊天流式 UI 组件化收益大，Claude Code 插件亦用 React；与宿主共用 esbuild，不引入第二套打包器 |
| 会话持久化 | 跟随 pi 默认行为（已确认） | 不加 `--no-session`，重启 VS Code 后历史仍在；v0.1 不做会话切换 UI |
| Markdown 渲染 | marked + DOMPurify 消毒 | 助手文本含 markdown；webview CSP 禁止远程内容 |
| 多工作区 | v0.1 仅支持第一个工作区文件夹 | 简化；多根支持列入 v0.2（每个根一个 pi 实例） |
| 空工作区 | 面板显示"请先打开一个文件夹"错误态 | `workspace.workspaceFolders` 为空时 spawn cwd 无定义，必须显式处理 |

### 2.2 RpcClient 设计要点（基于 docs/rpc.md 协议）

- **启动**：`spawn("pi", ["--mode", "rpc"], { cwd: workspaceRoot, env: process.env })`
- **Windows 陷阱**：npm 全局的 `pi` 是 `.cmd` shim，`spawn` 无 shell 时无法直接执行。方案：启动时解析 pi 可执行文件真实路径（优先 `pi.cmd`/`where pi`），回退 `shell: true`；或直接 `spawn(process.execPath, [piCliJs, "--mode", "rpc"])` 绕过 shim。实现时验证两种路径，选更稳健者
- **Framing（协议硬要求）**：只用 `\n` 切分记录、容忍尾部 `\r`；**禁止使用 Node `readline`**（它会把 U+2028/U+2029 当换行，而它们是 JSON 字符串合法字符，违反协议）
- **请求/响应关联**：每个命令带自增 `id`，响应按 `id` 关联 Promise；`bash_execution_update` 事件也带来源命令 `id`
- **命令**（v0.1 用到）：`prompt`（含 `images`、`streamingBehavior: "steer"`）、`steer`、`abort`、`get_state`、`get_available_models`、`get_messages`
- **图片格式**（易混点）：RPC 用 `{"type":"image","data":<base64>,"mimeType":"image/png"}`，**不是** SDK 的 `source:{type:"base64",...}`；在 protocol.ts 中注释标明
- **事件**（转发给 webview）：`agent_start/agent_end/agent_settled`、`message_start/message_end`、`message_update`（`text_delta`/`thinking_delta`，按 contentIndex 分块）、`tool_execution_start/update/end`、`queue_update`、`extension_error`、`extension_ui_request`
- **流式装配（协议硬要求）**：`message_update` 不携带累计消息，客户端必须用 `message_start` + 按 `contentIndex` 的增量自行组装部分消息（thinking 与 text 多块交替时不能简单追加），以 `message_end.message` 为权威替换
- **空闲判定**：`agent_end` 仅是单次低层 agent run 完成（后续仍可能有 retry/compaction/排队 continuation），**用 `agent_settled` 作为最终空闲信号**；`agent_end` 只用于刷新消息列表
- **extension_ui_request 子协议**：扩展/技能可能通过 `ctx.ui.confirm/select/input` 请求 UI，若无应答 agent 会永久阻塞。v0.1 不做交互 UI：RpcClient 识别该请求并自动回复 `{"type":"extension_ui_response","id":...,"cancelled":true}`（fire-and-forget 类如 notify/setStatus 忽略或转状态栏），此决策在代码注释中写明后果
- **命令失败路径**：`prompt` 被拒返回 `success:false`+`error`（如流式中未带 streamingBehavior）→ 统一转 webview 错误提示；不带 id 的响应按 `command` 字段兜底关联
- **生命周期**：懒启动（首次打开面板时 spawn）；`deactivate()` 时终止**整个进程树**（Windows：`taskkill /pid <pid> /T /F`；POSIX：进程组负 PID kill），否则 pi 的 bash 工具派生的子 shell 会成孤儿进程；崩溃 → webview 显示错误态 + "重启 Pi" 按钮（重新 spawn 并回放 `get_messages` 恢复历史）；启动时 `pi --version` 检测安装，未安装 → 引导安装提示（README 同时列明 Windows 下 pi 依赖 bash（Git Bash 等）的前提）

### 2.3 Webview ↔ 宿主消息协议

- 宿主 → webview：`history`（`get_messages` 全量）、`delta`（按 contentIndex 分块的文本/thinking 增量）、`toolStart/toolUpdate/toolEnd`、`agentStart/agentEnd/agentSettled`、`status`（模型名——**可为 null（未认证/无可用模型）**，需处理该分支/思考等级/流式状态/进程状态）、`error`
- **视图隐藏重显状态重放**：副侧边栏视图切走/折叠时 webview 会被销毁，重新显示时 `resolveWebviewView` 再次触发；ChatController 在内存中持有消息缓冲（含未结束的部分消息），re-resolve 时全量重发当前状态（`get_messages` 拿不到 `message_end` 前的增量消息，不能只靠它）
- webview → 宿主：`sendPrompt`（text + images[]）、`steer`、`abort`
- 图片：webview 侧压缩为 base64（PNG/JPEG），随 `prompt.images` 发送（协议原生支持）

### 2.4 工程脚手架（已确认：使用微软官方模板）

微软官方脚手架为 Yeoman `generator-code`（`microsoft/vscode-generator-code`，无 `@vscode/create-extension`）。在**当前空仓库内**生成：TypeScript + esbuild 打包模板，生成后裁剪示例代码、接入本架构。命令：

```bash
npx --package yo --package generator-code -- yo code --destination . <选项>
```

生成基线后按本计划改造；构建/测试/CI 采用"标准 TS + esbuild + 测试"档（用户原始选择，含 @vscode/test-electron 集成测试 + GitHub Actions lint/build/test）。

## 3. 任务拆解（可逐步执行）

1. **脚手架生成**：`yo code` 是交互式生成器且通常新建子目录——先核实其对现有目录/`--destination`/无头选项的支持；若不能原地生成，则在临时目录生成后把文件移入仓库根再 `git add`。验证 `npm run compile`、F5 启动；提交基线（`chore:`）
2. **清单配置**：`contributes.viewsContainers` + `views`（聊天视图、图标，尝试 `location` 声明侧栏位置并实测）、`onView` 激活事件、命令（打开面板、中断）、webview CSP 设置
3. **RpcClient**（`src/rpc/`）：spawn/可执行文件解析（含 Windows shim 处理）、严格 LF framing、id 关联、事件总线；**framing 单元测试**（覆盖 U+2028、`\r\n`、半包拼接）
4. **ChatController**（`src/chat/`）：pi 生命周期（懒启动/重启/进程树清理）、命令封装（prompt/steer/abort/get_state/get_available_models，含 `success:false` 与无 id 响应的兜底）、事件 → webview postMessage 映射（含 contentIndex 分块装配、agent_settled 空闲判定、extension_ui_request 自动 cancelled 回复）、内存消息缓冲 + 视图重显时全量重放、`get_messages` 历史恢复、空工作区错误态
5. **Webview 聊天 UI**（`webview-ui/`，React 19 + esbuild）：消息列表（用户/助手）、按 contentIndex 分块渲染的流式文本 + markdown（marked + DOMPurify）、可折叠 thinking 块、工具调用卡片、输入框（Enter 发送 / Shift+Enter 换行 / 流式中 Esc 中断 / **空闲时 Esc 清空输入** / 流式中输入自动转 steer）、图片粘贴/选择预览、状态栏（模型含 null 分支/思考等级/进程状态）、错误态 + 重启按钮
6. **错误与边界处理**：pi 未安装检测、进程崩溃恢复、JSONL 解码容错、webview dispose 时解除订阅
7. **测试**：单元（framing、协议类型、contentIndex 装配、状态机）+ 集成（@vscode/test-electron：面板打开、用一个按 rpc.md 实现的"假 pi" Node 脚本（确定性事件流，含多 contentIndex 块与 extension_ui_request）验证端到端流式渲染、abort 送达与 UI 请求自动取消）
8. **文档**：README（中文；内容：安装/开发/调试、副侧边栏位置说明、pi 依赖要求及 Windows 下 bash 依赖、`pi --version` 最低版本要求）、`.vscodeignore`、许可证
9. **终检**：lint + test + bundle 全绿；按"验证方式"清单人工验收；提交（`feat:`）

## 4. 涉及的文件

```
pinel/
├─ package.json                  # 清单：viewsContainers/views/命令/脚本/依赖
├─ tsconfig.json
├─ esbuild.js                    # 宿主 bundle（扩展生成器自带，裁剪）
├─ .vscode/                      # launch.json / tasks.json（F5 调试）
├─ .vscodeignore                 # 发布裁剪
├─ .github/workflows/ci.yml      # lint + build + test
├─ src/
│  ├─ extension.ts               # activate/deactivate
│  ├─ rpc/
│  │  ├─ client.ts               # spawn + framing + id 关联
│  │  ├─ protocol.ts             # RPC 命令/事件类型（对齐 docs/rpc.md）
│  │  └─ framing.test.ts
│  ├─ chat/
│  │  ├─ controller.ts           # 生命周期/流状态/事件映射
│  │  └─ panel.ts                # WebviewViewProvider + postMessage 协议
│  └─ test/                      # 集成测试（假 pi RPC 服务器脚本）
├─ webview-ui/
│  ├─ index.html
│  ├─ src/                       # React App + 组件（消息流/thinking/工具卡/输入框/状态栏）
│  └─ esbuild.js                 # webview bundle（复用宿主 esbuild）
├─ README.md
└─ .pi/plans/init-vscode-extension.md   # 本计划
```

## 5. 验证方式与风险

**验证**：

- 单元：framing（U+2028/`\r\n`/粘包拆包）、协议消息构造
- 集成（@vscode/test-electron）：面板打开 → 假 pi 响应流式事件 → webview 渲染正确；abort 命令送达
- 人工（F5）：真实 pi 发送 prompt 全程流式渲染、Esc 中断、图片附件、杀掉 pi 进程 → 错误态 → 重启恢复
- 质量门：`npm run lint` / `npm test` / `npm run compile` 全绿

**风险**：

| 风险 | 缓解 |
|---|---|
| Windows 下 spawn pi 的 `.cmd` shim 失败 | 解析真实可执行路径；回退 `shell:true` 或直接 `node <pi-cli-js>`；列入任务 3 必测项 |
| 副侧边栏定位需实测 | ✅ 已实测：声明式清单不支持（见 §2.1），README 说明一次性拖拽（位置会被记忆） |
| pi 版本演进导致 RPC 协议漂移 | `pi --version` 校验最低版本并在 UI 提示；protocol.ts 集中管理协议类型 |
| Node `readline` 违反 JSONL framing 协议 | 自实现 LF 切分；framing 单元测试覆盖 |
| webview XSS（markdown 渲染） | CSP 禁止远程内容 + DOMPurify 消毒 |
| 多根工作区语义未定义 | v0.1 明确仅第一工作区文件夹；README 标注限制 |
| 集成测试依赖无头 VS Code 环境 | CI 用 `@vscode/test-electron` 官方下载的稳定版；假 pi 脚本避免真实 LLM 依赖 |
| Windows 下 pi 依赖 bash（Git Bash 等） | README 列明前提；启动检测 bash 缺失并提示（docs/windows.md） |
| 扩展/技能请求 UI 对话框（extension_ui_request）无人应答致 agent 阻塞 | RpcClient 自动回复 cancelled（v0.1 决策，代码注释写明）；v0.2 再做真实交互 UI |
| 空闲判定错误（agent_end 过早复位导致 steer 队列丢失或 UI 状态错乱） | 以 agent_settled 为最终空闲信号，agent_end 仅刷新消息列表 |

## 6. 决策点定稿（全部已与用户确认）

1. **Webview UI 框架**：✅ React 19（用户确认）
2. **扩展元数据**（用户确认，发布者为他指定的 `hiss`）：
   - `name`: `"pinel"`（package.json 的 name 必须小写，vsce/Marketplace 强制约束）→ 完整扩展 ID `hiss.pinel`
   - `publisher`: `"hiss"`
   - `displayName`: `"Pinel - Pi for VS Code"`
   - 命令前缀：`pinel.*`（如 `pinel.openPanel`）
   - `engines.vscode`: `^1.85.0`
3. **会话持久化**：✅ 跟随 pi 默认（每工作区持久会话，重启保留历史）
4. **README 语言**：✅ 中文

## 7. 执行记录（实现后回溯更新）

- **engines.vscode**：generator-code 模板默认 `^1.125.0`，高于计划假设的 `^1.85.0`，保留模板默认
- **Markdown 渲染**：用 `react-markdown`（不启用 rehype-raw，天然防 XSS）等价实现计划中的 marked+DOMPurify 目标，少一个运行时消毒依赖
- **副侧边栏**：实测声明式清单仅支持 activitybar/panel，README 记录拖拽方式
- **Windows shim 三坑**（均修复并有回归测试）：① PATH 中无扩展名 `pi` sh 脚本遮蔽 `pi.cmd` → `where.exe` 解析并优先 `.cmd`；② cmd.exe 包装需 `windowsVerbatimArguments`（Node 默认反斜杠转义引号，cmd 不解析）；③ cmd 路径须用 ComSpec 反斜杠形式（正斜杠破坏其参数解析）
- **真实 pi 冒烟验证**：RpcClient 对真实 pi 0.84.1 完成 get_state（deepseek/deepseek-v4-pro）、get_available_models、prompt 接受、真实扩展 extension_ui_request 自动取消、进程树清理
- **测试**：21/21 通过（framing 7、流式装配 5、spawn 解析 4、集成 5——状态同步/端到端多块流式/abort 中断/UI 请求自动取消/跨消息装配不串块）
- **实现评审修复**（子代理评审后）：流式装配在 message_start/agent_settled 重置并门控 settle 后迟到的 message_update（防跨消息污染，含 TWOMSG 回归测试）；POSIX spawn detached 使进程组 kill 生效；webview ready 握手重发快照（视图重显重放竞态）；shell 命令模式自动拼入 `--mode rpc` 且命令发送带 30s 超时；webview 图片压缩（>1568px 转 JPEG）；默认 watch 任务含 webview 打包
- **与计划的等价偏差**（已确认）：agentStart/agentEnd/agentSettled 未作为独立 webview 消息转发，以 `status.isStreaming` 等价映射；pi 版本预检以 spawn 失败检测替代；`get_available_models` 类型/假 pi 已备但 v0.1 UI 仅用 get_state 展示模型（v0.2 模型切换时使用）
