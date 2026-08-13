# Pinel — Pi for VS Code

在 VS Code 中使用 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码智能体的聊天面板扩展。类似 Claude Code 官方插件的形态：以 `pi --mode rpc` 子进程为引擎，在副侧边栏提供图形聊天界面。

## 功能（v0.1）

- **聊天面板**：副侧边栏 WebviewView，流式渲染助手回复（文本 / 思考过程 / 工具调用卡片）
- **流式控制**：流式输出中按 **Esc**（或点击停止按钮）中断当前操作；流式中继续输入会自动转为 steer 排队
- **图片附件**：粘贴图片或点击图片按钮选择，随 prompt 发送（base64）
- **状态栏**：当前模型、思考等级、待处理队列、进程状态；pi 进程异常时可一键重启（历史自动恢复）
- **扩展 UI 兜底**：扩展/技能通过 `ctx.ui.*` 请求交互时自动回复 cancelled 并在面板提示（v0.1 无交互 UI）

**暂不支持（v0.2+ 计划）**：会话列表/切换/重命名、Plan Mode 开关、edit 的 diff 预览、@提及文件、检查点/回退、权限确认 UI。

## 前置要求

- [Node.js](https://nodejs.org/) ≥ 20（扩展宿主自带，无需安装）
- 已安装 pi CLI：`npm install -g @earendil-works/pi-coding-agent`
- **Windows**：pi 依赖 bash（如 [Git Bash](https://git-scm.com/)），请确保可用
- VS Code ≥ 1.125

扩展启动时会 spawn `pi --mode rpc`；若 pi 未安装或不在 PATH 中，面板状态栏会显示"pi 进程异常"并提供安装指引（pi 的 stderr 诊断可见于"Pinel"输出通道）。也可在设置 `pinel.piPath` 指定其路径（如 `C:/Users/you/AppData/Roaming/npm/pi.cmd`，也支持完整命令），修改后重新加载窗口生效。

## 面板位置

VS Code 的声明式清单仅支持把视图容器贡献到活动栏（`activitybar`）或底部面板，**无法编程式固定到副侧边栏**。首次使用请把 Pinel 图标从活动栏**拖拽到副侧边栏（右侧）**，VS Code 会记忆该位置。

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
