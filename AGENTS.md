# AGENTS.md — Pinel 仓库指南

> 供 AI Agent 与维护者遵循；修改仓库结构后需同步更新本文件。**踩坑沉淀与功能链路完整细节存于 memory**（实体 `pinel-feature-links` / `pinel-testing-pitfalls` / `pinel-platform-pitfalls` / `pinel-agents-md-policy`，压缩前全文见 git 历史的 AGENTS.md）与 `.pi/plans/` 计划文档，本文件只保留规则与索引。

## Project Overview

**Pinel**（扩展 ID `hilariouhiss.pinel`）：VS Code 扩展，为 Pi 编码智能体（`@earendil-works/pi-coding-agent`）提供类似 Claude Code 插件的图形聊天面板。v0.1，范围仅核心聊天体验。

**技术栈**：TypeScript strict 宿主（Node16/ES2022）spawn `pi --mode rpc` 子进程（严格 LF JSONL over stdio，薄客户端，协议见 `src/rpc/protocol.ts` 头注释与 pi docs/rpc.md）；React 19 + react-markdown webview（esbuild 单文件 IIFE，CSP nonce）；mocha + @vscode/test-electron 真实 VS Code 测试；npm lockfile 入库，CI 用 `npm ci`。

## Repository Structure

```
pinel/
├─ src/                    # 扩展宿主（CJS，仅此目录参与宿主 bundle）
│  ├─ extension.ts         # 激活入口 + PinelTestApi 测试钩子导出
│  ├─ rpc/                 # protocol.ts（协议类型+头注释）/ framing.ts（LF JSONL）/ client.ts（子进程生命周期+请求关联）；不依赖 vscode
│  ├─ chat/                # controller.ts（会话控制器）+ 各功能纯函数模块（见 Feature Map）
│  └─ test/                # *.test.ts 单测 + extension.test.ts 集成 + fixtures/（fake-pi.js、long-running.js）
├─ src/test-no-workspace/  # 空窗口实例集成测试（独立套件）
├─ scripts/                # clean-test-userdata.mjs（npm test 前清理共享 user-data）+ pinel-plugin-smoke.mjs（真实 pi 冒烟，opt-in）
├─ pinel-plugin/           # Pinel Pi 插件包（npm 包 @hilariouhiss/pinel，pi install 安装；独立 tsc 检查不随主 bundle；发布：cd pinel-plugin && npm publish）
├─ webview-ui/             # React webview（browser 平台，禁 import 宿主/vscode）；src/components/ + command-match.ts + types.ts（OutMessage 镜像，手工同步）+ esbuild.js
├─ media/                  # webview 图标用 lucide 内联进 bundle 不入库；pi-glyph.svg/pi-icon.png 品牌图标入库；webview 产物 gitignored
├─ .pi/plans/              # 计划文档（入库；v0.1/v0.2 边界与历史决策）
├─ esbuild.js              # 宿主打包：src/extension.ts → dist/extension.js（external: vscode）
└─ .vscode-test.mjs        # 双套件测试配置（main 工作区 + no-workspace 空窗口）
```

## Build and Test

```bash
npm install          # npm 12 需批准 esbuild postinstall：npm install-scripts approve esbuild
npm run compile      # 类型检查（宿主+webview+插件）→ lint → 宿主 bundle → webview bundle
npm run watch        # 监听模式；F5 调试前必跑
npm test             # 全部测试（pretest 自动 compile + lint）
npm run check-types  # 仅 tsc 双 tsconfig
npm run check-plugin # 仅 pinel-plugin 独立 tsc 检查（不在主 program，lint 亦不覆盖）
npm run lint         # eslint src
npm run package      # 生产构建（minify）
npm run smoke:plugin # 真实 pi 冒烟（临时项目 pi install -l + 帧/命令断言；需已装 pi）
```

- 首次 `npm test` 下载 VS Code 到 `.vscode-test/`（约 100MB）
- 质量门：`npm run compile` + `npm test` 全绿（当前 260/260：主套件 256 + 空窗口 4）

## Coding Guidelines

- 注释与提交信息中文，标识符英文；类/组件 PascalCase，其余 camelCase；测试 `*.test.ts`，夹具 `fixtures/`
- ESLint 警告级（curly/eqeqeq/semi 等），修改后必须零警告；勿留死代码/死导入
- 纯函数（无 vscode 依赖）拆独立模块便于单测；webview 组件放 `webview-ui/src/components/`
- 宿主消息类型变更必须**同步** `webview-ui/src/types.ts` 镜像（App.tsx switch 无 default 分支）；构建产物不入库

## Architecture Rules

1. 依赖方向：`src/chat` → `src/rpc`；`src/rpc` 不依赖 vscode；webview 与宿主零代码共享，仅 postMessage 通信
2. 宿主 bundle 唯一入口 `src/extension.ts`，`vscode` 保持 external；webview 依赖全部打进 bundle（发布包不含 node_modules）
3. 协议硬约束（改动前先读 `src/rpc/protocol.ts` 头注释）：JSONL 只用 LF 切分、禁止 readline；流式按 contentIndex 装配、message_end 权威、settle 后迟到 update 丢弃；空闲判定用 agent_settled；extension_ui_request 必须回复否则 agent 永久阻塞；命令 30s 超时、无 id 响应按 command 兜底
4. 安全：CSP `default-src 'none'` + nonce；markdown 禁 rehype-raw；用户输入不拼 shell（piPath 配置除外）
5. Windows 专项（spawn-spec/stop 测试覆盖）：where.exe 解析优先 .cmd/.bat 行；.cmd 用 cmd.exe /d /s /c + windowsVerbatimArguments；进程终止优雅优先（关 stdin → 2.5s 后 taskkill /T /F 或 POSIX 负 PID 组杀），总时长 5s 契约

## Feature Map（一句话索引；完整链路与踩坑见 memory `pinel-feature-links`）

| 功能 | 模块/要点 |
|---|---|
| 命令补全 | commands.ts；get_commands fire-and-forget，失败静默空列表 |
| 消息复制按钮 | MessageView CopyButton；navigator.clipboard 可选链兑底；innerText 所见即所得提取（排除角色行） |
| 最近回合悬浮条 | RecentRoundBar 锚 header（absolute 入滚动区会随内容滚走）；纯消息文本 3 行截断；data-msg-index 滚回 + scroll-margin-top 防遮挡；点击滚回后隐藏（roundBarHidden），onScroll 视口离开判定重现（函数式 setState 避空依赖闭包，重置键 sessionFile） |
| /new 拦截 | controller.sendPrompt 精确匹配本地拦截 → newSession；RPC 不展开 slash |
| Ctrl+G 编辑提示词 | prompt-editor.ts；真实临时文件 + 保存回填 + 发送清理 |
| @ 添加文件 | at-refs.ts 发送时文本解析 @引用（引号路径/标点剥离/大小写不敏感）+ file-scanner；panel.ts 透传 fileRefs；controller 自读自拼 file 标记注入 + 图片 base64 |
| 问卷 | questionnaire.ts；tool_execution_start 整卷本地渲染 + 游标回填；分段进度条 |
| 配置面板/模型思考 chip | ConfigPopover（队列/压缩阈值/Compact now/会话信息）+ ModelPopover chip 下拉（models.ts） |
| lucide 图标 | lucide-static SVG esbuild text loader 内联；stroke=currentColor 主题自适应 |
| 会话重命名/删除 | set_session_name（当前）/ appendSessionName（非当前）；seam confirmSessionDelete |
| 会话统计/信息条 | session-stats.ts + git-status.ts + session-env；Maple Mono NF 全扩展字体 |
| fork/clone | fork-messages.ts + runSessionChange 骨架；fork 后 pi 自动 rebind |
| subagent 卡片 | subagents.ts；tool_execution details 防御解析 + 专属卡片（内联 assistant 消息工具调用原位，统计行 + Markdown 输出；继承主会话兕底主会话实际模型/思考等级 mainModelName/mainThinkingLevel props；状态驱动自动开合 running||background 展开）+ 图标 lucide bot |
| 工具结果内联 | 工具调用结果展示在原 assistant 消息卡片（ToolCallCard：lucide wrench/bot + spinner/check/x + 预览，展开 args+output；标题工具本名三层兕底 name→toolCard.toolName→result.toolName→Tool call，isSubagent 判定同源；status 驱动自动开合）；toolResult 消息命中匹配则跳过独立卡片、孤儿兑底独立卡片；webview 内部映射（App.tsx useMemo），宿主/协议零改动 |
| 输入框自适应 | Composer scrollHeight 自适应（软换行计入，上限面板高 60%） |
| 扩展管理 | extensions.ts；本地重命名启停 + packages settings 编辑（字符串↔对象空数组，无同 identity 条目 upsert 覆盖）+ pi remove 卸载；弹层 All/Global/Project 三态切换（project 视图含继承全局包 inherited 行，开关写项目覆盖条目；all 包按 identity 去重 project 优先；panel 记忆最近视图刷新沿用） |
| Pinel 插件（npm 包） | pinel-plugin/（@hilariouhiss/pinel，PINEL_PLUGIN=1 + rpc 守卫）；pinel-install.ts 安装态检测（settings.json packages + 曾安装标记不复活）；pinel-payload.ts 白名单过滤 pinel.* + 防御解析；controller 缓存 + snapshot 重放；panel 一键 pi install（runPiCommand） |
| 会话树导航/压缩 | 插件 /pinel-tree 扩展命令（RPC 派发，control 消息不渲染不写条目）+ PinelTreePopover（双击 Esc 打开，锚定 header 分支按钮，焦点门控）；compact 原生 RPC（protocol CompactCommand + controller.compact + 设置面板 Compact now）；阈值 setCompactionThreshold（百分比↔reserveTokens 写全局 settings.json + status.autoCompactPercent 回显） |
| 模型自愈 | get_state 重试 4 次 → 自动重启一次（不走 restart 守卫） |

## Testing Guidelines

- 245 个测试必须全绿：`src/test/` 单测 16 文件（framing/stream-assembly/spawn-spec/stop/todos/commands/models/fork-messages/extensions/questionnaire/session-stats/git-status/session-history/subagents/pinel-payload/pinel-install）+ `extension.test.ts` 集成（真实 VS Code + 假 pi）+ no-workspace 3 个
- 新增覆盖：纯逻辑 → mocha 单测；聊天/RPC 行为 → `fixtures/fake-pi.js` 加 prompt 标记场景 + `PinelTestApi` 断言；改 RPC 必须同步 protocol.ts 与假 pi
- 作用于首次 get_state/get_commands/get_session_stats 的场景用 `PINEL_FAKE_PI_SCENARIO` env 激活（不能 prompt 标记）
- 插件本体（pinel-plugin/，不在主 tsc program）由 `npm run check-plugin` + `npm run smoke:plugin` 真实 pi 冒烟覆盖（临时项目 pi install -l，不进 CI）
- 集成测试踩坑（waitForSettled baseline 前置、isStreaming 等待、日志切片、env 场景清单等）见 memory `pinel-testing-pitfalls`

## Agent Instructions

1. 动手前先理解：读 `.pi/plans/` 与相关模块源码；RPC 行为查 protocol.ts 头注释与 pi docs/rpc.md，不凭想象写协议
2. 优先复用既有模块；不随意新增依赖（体积/安全权衡；webview 优先 react-markdown + VS Code CSS 变量）
3. 不修改无关文件、不动构建产物；涉及功能链路行为时先查 memory `pinel-feature-links` 对应条目
4. 改完 `npm run compile` + `npm test` 全绿才可交付；Conventional Commits（feat/fix/refactor/docs/chore），一次一个完整变更，无 AI 署名
5. 用户可见变更同步 README.md/CHANGELOG.md；结构/命令/架构约束变更同步本文件；新踩坑沉淀写 memory（不进本文件）
6. 范围纪律：v0.2+ 功能（Plan Mode、edit diff 预览、@提及、文件内 rewind）非明确需求不得提前实现；既有提前实现项清单见 memory `pinel-feature-links` 末条
