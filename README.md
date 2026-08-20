# Pinel — Pi for VS Code

在 VS Code 中使用 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码智能体的聊天面板扩展。类似 Claude Code 官方插件的形态：以 `pi --mode rpc` 子进程为引擎，在副侧边栏提供图形聊天界面。

## 功能（v0.1）

- **聊天面板**：副侧边栏 WebviewView，流式渲染助手回复（文本 / 思考过程 / 工具调用卡片）
- **流式控制**：流式输出中按 **Esc**（或点击停止按钮）中断当前操作；流式中继续输入会自动转为 steer 排队；发送/停止按钮使用 SVG 图标（send.svg/stop.svg，颜色随主题自适应）
- **图片附件**：粘贴图片随 prompt 发送（base64）
- **footer 卡片**：底部为圆角卡片——上半提示词输入框（Enter 发送、Shift+Enter 换行、Esc 中断、/ 补全命令、**Ctrl+G 在编辑器中编辑提示词**），下半左 ⚙ 设置按钮、右发送/停止按钮（流式中变停止）；pi 进程异常/无模型/未打开文件夹时输入框上方显示状态横幅（附重启/重试按钮）
- **配置面板**：点击 footer 卡片 ⚙ 设置按钮弹出——队列模式（steering/跟进：全部投递/一次一条）、自动压缩开关、**模型选择**（内嵌展开列表）与**思考强度选择**（内嵌展开列表）；点击外部或 Esc 关闭（面板打开时 Esc 只关面板、不中断对话）
- **模型/思考等级选择**：设置面板内「模型」「思考强度」行点击展开内嵌列表（数据每次展开时拉取），选中即切换（模型切换同步更新思考等级，切换自下一回合生效，流式中也可切换）；选择由 pi 持久化，重启 VS Code 后保留；列表失败时收起并提示
- **交互 UI**：扩展/技能的 `ctx.ui.*` 对话框（select/confirm/input/editor，如 ask_user_question 插件的问卷）渲染为聊天流内联卡片，用户作答/取消后回传 agent；新对话框自动滚动聚焦
- **问卷确认流程**：`ask_user_question` 问卷以整卷形式一次展示（题目/选项/多选/自定义答案），自动聚焦到首个未答题；答完最后一题弹出确认面板，可「修改」任一题重新作答，确认后自动按序回填给 Pi；Esc 放弃整卷
- **待办面板**：todo 工具（如 rpiv-todo 插件）的任务列表在输入框上方固定面板展示（可折叠，限高 30vh 内部滚动）
- **命令补全**：输入框键入 `/` 弹出候选列表（pi 的扩展命令/提示模板/技能，含描述与来源徽标），↑↓/Enter/Tab 选择、Esc 关闭、鼠标可点；接受后插入 `/命令 ` 继续输入参数
- **@ 添加文件**：输入框输入 `@` 弹出工作区文件补全列表（忽略 .gitignore 路径），选中后以附件卡片呈现（可移除）；发送时文本文件以 `<file name>` 格式注入 prompt、图片文件转为图片附件（pi RPC 模式不支持 CLI 的 @file 参数，pinel 自读自拼）
- **编辑器编辑提示词**：聚焦输入框时按 **Ctrl+G** 在 VS Code 原生编辑器中编辑提示词（带入当前输入内容，`.md` 临时文件）；**Ctrl+S 保存后自动回填输入框**，按 Enter 即可发送；发送后自动关闭编辑器标签页并清理临时文件
- **聊天界面会话历史**：顶部栏左侧显示当前会话标题，右侧按钮组——「会话历史」按钮（history.svg 图标）弹出会话列表（名称/摘要/相对时间/当前标记，含搜索框），选择即切换会话；「新会话」按钮（new-session.svg 图标）一键新建；主侧边栏会话历史面板同样支持搜索，新会话按钮为透明描边样式（add.svg 图标）
- **会话重命名/删除**：会话列表行右侧操作按钮（hover 显示）——edit.svg 行内编辑重命名（名称变输入框，Enter 提交 / Esc 取消，当前会话经 pi `set_session_name`、其他会话直接写入会话文件）；delete.svg 删除会话（删除前确认弹窗；当前会话不可删除）
- **会话分支/回溯**：顶部栏「分支」按钮（fork-repo.svg 图标）弹出历史用户消息选择器——选中某条即从该消息 fork 出新会话并切换过去（原会话保留在历史列表可随时返回），被 fork 消息原文自动回填输入框（可直接发送或编辑后重发，实现“回到这里重新开始”）；弹层底部「Clone current branch」把当前分支复制为新会话（开始新方向前的备份）；数据来自 pi `get_fork_messages`/`fork`/`clone`（0.84.2+）
- **会话信息条**：设置面板「显示会话信息」开关（持久化，重启保留）——开启后输入卡下方探出一条信息（与输入卡同宽）：左侧环境段 `文件夹名 on  分支 [!?↑↓]`（Maple Mono NF 字体）、右侧上下文占用/窗口、缓存读/写、缓存命中率与成本（数据来自 pi `get_session_stats` 与工作区 git，每回合结束与会话切换后刷新）

**暂不支持（v0.2+ 计划）**：Plan Mode 开关、edit 的 diff 预览、同文件内分支/检查点（文件内回退到历史消息继续，依赖 pi RPC 的游标移动能力——当前仅 TUI 支持）。

## 前置要求

- [Node.js](https://nodejs.org/) ≥ 20（扩展宿主自带，无需安装）
- 已安装 pi CLI：`npm install -g @earendil-works/pi-coding-agent`
- **Windows**：pi 依赖 bash（如 [Git Bash](https://git-scm.com/)），请确保可用
- VS Code ≥ 1.125

扩展启动时会 spawn `pi --mode rpc`；若 pi 未安装或不在 PATH 中，面板会显示"pi 进程异常"横幅并提供安装指引（pi 的 stderr 诊断可见于"Pinel"输出通道）。若窗口未打开文件夹，显示「⚠ 未打开文件夹」友好横幅（打开文件夹后自动连接）。也可在设置 `pinel.piPath` 指定其路径（如 `C:/Users/you/AppData/Roaming/npm/pi.cmd`，也支持完整命令），修改后重新加载窗口生效。

若显示「⚠ 无可用模型」横幅：扩展在启动时会重试获取模型并自动重启一次 pi 以恢复（如切换文件夹窗口重载后的瞬时竞态）；仍失败时通常为 pi 认证问题，请在终端运行 `pi` 验证认证状态，或点击横幅的「重启」按钮重试。

## 面板位置

- **主侧边栏（左侧活动栏）**：点击 Pinel 图标展示**会话历史**列表（顶部「新会话」按钮；点击任一会话切换到该会话）。
- **次侧边栏（右侧）**：聊天界面（`pinel-chat` 容器）。点击历史列表中的会话或「新会话」后，聊天界面自动出现在右侧；若次侧边栏已关闭会重新打开。

也可通过命令面板执行 `Pinel: 新会话` / `Pinel: 打开聊天面板`。

## 开发

```bash
npm install            # 安装依赖
npm run watch          # 监听构建（宿主 + webview）
npm run compile        # 类型检查 + lint + 构建
npm test               # 单元 + 集成测试（@vscode/test-electron，首次会下载 VS Code）
```

F5 启动扩展开发宿主调试（`launch.json` 已配置 esbuild 问题匹配器）。

## 架构

```
┌────────────────────────────────────────────┐
│ VS Code Extension Host (Node)              │
│  ┌──────────────────────────────────────┐  │
│  │ WebviewView（副侧边栏，React 聊天 UI）│  │
│  └───────────────┬──────────────────────┘  │
│                  │ postMessage              │
│  ┌───────────────▼──────────────────────┐  │
│  │ ChatController（生命周期/流状态/缓冲） │  │
│  │ RpcClient（spawn + JSONL 编解码 + id   │  │
│  │            关联 + 事件分发）           │  │
│  └───────────────┬──────────────────────┘  │
└──────────────────┼─────────────────────────┘
              stdin/stdout（严格 LF JSONL）
┌──────────────────▼─────────────────────────┐
│ pi --mode rpc（子进程，cwd = 工作区根目录） │
└────────────────────────────────────────────┘
```

- `src/rpc/`：RPC 协议类型（对齐 docs/rpc.md）、严格 LF framing（禁用 Node `readline`）、RpcClient（Windows `.cmd` shim 处理、进程树终止、无 id 响应按 command 兜底）
- `src/chat/`：流式块按 contentIndex 装配（`message_end` 为权威）、`agent_settled` 空闲判定、视图隐藏重显时的内存缓冲重放
- `webview-ui/`：React 19 + esbuild 打包为 `media/webview.js`，CSP（nonce + 禁止远程内容）+ react-markdown（无 rehype-raw，天然防 XSS）
- `src/test/`：framing / 流式装配单元测试；集成测试用 `fixtures/fake-pi.js`（按 rpc.md 实现的确定性假 pi，覆盖多块装配、abort、extension_ui_request 自动取消）

## 许可证

[MIT](LICENSE)
