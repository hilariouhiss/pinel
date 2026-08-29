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
├─ ../pi/                  # Pinel Pi 插件包（sibling 目录，npm 包 @hilariouhiss/pinel，pi install 安装；独立 tsc 检查不随主 bundle；发布：cd ../pi && npm publish）
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
npm run check-plugin # 仅插件（../pi）独立 tsc 检查（不在主 program，lint 亦不覆盖）
npm run check:smooth-text # webview 平滑揭示纯函数自检（node strip-types）
npm run lint         # eslint src
npm run package      # 生产构建（minify）
npm run smoke:plugin # 真实 pi 冒烟（临时项目 pi install -l + 帧/命令断言；需已装 pi）
```

- 首次 `npm test` 下载 VS Code 到 `.vscode-test/`（约 100MB）
- 质量门：`npm run compile`（含 check:smooth-text）+ `npm test` 全绿（当前 295/295：主套件 291 + 空窗口 4）

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

## Feature Map

| 功能 | 模块/要点 |
|---|---|
| 命令补全 | commands.ts；get_commands fire-and-forget，失败静默空列表 |
| 消息复制 | 区块级复制入口：正文块（copy-target DOM 提取所见即所得）/思考卡（getText 直拷全文，不受折叠与 60 字预览截断影响）/工具卡（args pretty + output 直拷）各自悬浮按钮 + 右键菜单；剪切板桥：webview postMessage copyText → 宿主 vscode.env.clipboard（webview 内 navigator.clipboard 不可靠）；Pi 块不再提供块级复制（防正文复制携带思考全文） |
| 最近回合悬浮条 | RecentRoundBar 经高 0 sticky 锚点（.recent-round-anchor）钉滚动视口顶部，与消息卡片结构级同宽；随视口切换显示上下文用户消息（roundbar-rule.ts 纯函数：贴底仅当最近一条已滚出视口才钉住、顶部越过即切上一条、越最早隐藏）；纯消息文本 3 行截断；data-msg-index 滚回 + scroll-margin-top 防遮挡；点击滚回后隐藏（roundBarHidden），computeVisible 内视口离开判定重现，重置键 sessionFile |
| /new 拦截 | controller.sendPrompt 精确匹配本地拦截 → newSession；RPC 不展开 slash |
| /reload 拦截与 header 重载按钮 | controller.sendPrompt 精确匹配 /reload → restart（进程重载，会话经 --session 恢复）；header 右上角 rotate-cw 按钮复用 restart 消息 |
| Ctrl+G 编辑提示词 | prompt-editor.ts；真实临时文件 + 保存回填 + 发送清理 |
| @ 添加文件 | at-refs.ts 发送时文本解析 @引用（引号路径/标点剥离/大小写不敏感）+ file-scanner；panel.ts 透传 fileRefs；controller 自读自拼 file 标记注入 + 图片 base64 |
| 问卷 | questionnaire.ts；tool_execution_start 整卷本地渲染 + 游标回填；分段进度条 |
| 配置面板/模型思考 chip | ConfigPopover（队列/压缩阈值/Compact now/会话信息）+ ModelPopover chip 下拉（models.ts） |
| lucide 图标 | lucide-static SVG esbuild text loader 内联；stroke=currentColor 主题自适应 |
| 会话重命名/删除 | set_session_name（当前）/ appendSessionName（非当前）；seam confirmSessionDelete |
| 会话恢复 | controller 持久化最后会话文件（workspaceState `pinelLastSessionFile`）；spawn 时存在磁盘则 `--session` 恢复（已删除回退新建）；覆盖窗口重载/手动重启/模型自愈重启 |
| 会话统计/信息条 | session-stats.ts + git-status.ts + session-env；Maple Mono NF 全扩展字体；指标段：ponytail 状态（●/○ 激活/空闲 + 档位，解析 ponytail 插件自推 statusKey 帧，ANSI 剥离）+ 上下文占用 + ↑输入 ↓输出 token（对齐 pi CLI footer 语义）+ 缓存命中率 + 成本（缓存读/写不单列） |
| fork/clone | fork-messages.ts + runSessionChange 骨架；fork 后 pi 自动 rebind |
| subagent 卡片 | subagents.ts；tool_execution details 防御解析 + 专属卡片（内联 assistant 消息工具调用原位，统计行 + Markdown 输出；继承主会话兕底主会话实际模型/思考等级 mainModelName/mainThinkingLevel props；状态驱动自动开合 background 展开、running 不自动展开）+ 图标 lucide bot |
| 流式文本平滑显示 | StreamFlushThrottle（stream-flush.ts 纯模块）40ms 尾部节流合并 stream 广播 + KeyedFlushThrottle 同节奏合并工具卡广播（toolCallId 记忆最新，重置点同步 cancel 防陈旧卡片复活）+ webview 流式中纯文本渲染与平滑揭示（smooth-text.ts revealAdvance 纯函数 + use-smooth-text.ts rAF hook：逐帧追加、积压追赶、大积压直接落位；.msg-text-live 免 Markdown 逐 delta 全量重解析，message_end 后切回 Markdown；正文/thinking/toolcall 参数三处统一；工具输出不做 reveal——累计全文突发到达，逐字揭示负体验）；重置/重启/切换/退出路径 cancel 防陈旧块迟到 |
| 工具结果内联 | 工具调用结果展示在原 assistant 消息卡片（ToolCallCard：lucide wrench/bot + spinner/check/x + 预览，展开 args+output；标题工具本名三层兕底 name→toolCard.toolName→result.toolName→Tool call，isSubagent 判定同源；status 驱动自动开合）；toolResult 消息命中匹配则跳过独立卡片、孤儿兑底独立卡片；webview 内部映射（App.tsx useMemo），宿主/协议零改动 |
| 输入框自适应 | Composer scrollHeight 自适应（软换行计入，上限面板高 60%） |
| 扩展管理 | extensions.ts；本地重命名启停 + packages settings 编辑（字符串↔对象空数组，无同 identity 条目 upsert 覆盖）+ pi remove 卸载；弹层 All/Global/Project/Catalog 四态切换（project 视图含继承全局包 inherited 行，开关写项目覆盖条目；all 包按 identity 去重 project 优先；panel 记忆最近视图刷新沿用） |
| 插件目录与一键安装 | catalog.ts（静态清单 20 项 + installedIdentities/defaultInstallSpecs/installSpecsForGroup 纯函数）+ controller.getCatalogState（全局+项目 packages identity 并集判已装）/installCatalogEntries（逐个 pi install 全局 120s，顺序执行防 settings 并发写）+ panel 路由（getCatalogState/installCatalogEntry/installCatalogGroup → postCatalogState + Reload 流）+ ExtensionPopover Catalog 视图（分组/徽标/默认集批量/installing busy 防重复）；安装验证：installPinelPlugin 先例 + spike 实测 npm: 条目格式；compat 判定来自 plan-plugin-catalog-integration-20260829 §7.5 矩阵 |
| Pinel 插件（npm 包） | ../pi/（@hilariouhiss/pinel，PINEL_PLUGIN=1 + rpc 守卫）；pinel-install.ts 安装态检测（settings.json packages + 曾安装标记不复活）；pinel-payload.ts 白名单过滤 pinel.* + 防御解析；controller 缓存 + snapshot 重放；panel 一键 pi install（runPiCommand）；pinel.workflow 工作流状态条（WorkflowBar，rpiv-workflow 生命周期推送，会话切换清空） |
| 会话树导航/压缩 | 插件 /pinel-tree 扩展命令（RPC 派发，control 消息不渲染不写条目；宿主 pinel.tree 推送管线保留）；webview 树弹层与双击 Esc 入口已移除（与 Fork 弹层功能重叠）；compact 原生 RPC（protocol CompactCommand + controller.compact + 设置面板 Compact now）；阈值 setCompactionThreshold（百分比↔reserveTokens 写全局 settings.json + status.autoCompactPercent 回显） |
| 模型自愈 | get_state 重试 4 次 → 自动重启一次（不走 restart 守卫） |

## Testing Guidelines

- 280 个测试必须全绿：`src/test/` 单测 18 文件（framing/stream-assembly/spawn-spec/stop/todos/commands/models/fork-messages/extensions/questionnaire/session-stats/git-status/session-history/subagents/pinel-payload/pinel-install/catalog/notice-dedup）+ `extension.test.ts` 集成（真实 VS Code + 假 pi）+ no-workspace 4 个
- 新增覆盖：纯逻辑 → mocha 单测；聊天/RPC 行为 → `fixtures/fake-pi.js` 加 prompt 标记场景 + `PinelTestApi` 断言；改 RPC 必须同步 protocol.ts 与假 pi
- 作用于首次 get_state/get_commands/get_session_stats 的场景用 `PINEL_FAKE_PI_SCENARIO` env 激活（不能 prompt 标记）
- 插件本体（../pi/，不在主 tsc program）由 `npm run check-plugin` + `npm run smoke:plugin` 真实 pi 冒烟覆盖（临时项目 pi install -l，不进 CI）

## Agent Instructions

1. 动手前先理解，RPC 行为查 protocol.ts 头注释与 pi docs/rpc.md，不凭想象写协议
2. 改完后按需测试，中大改动 `npm run compile` + `npm test` 全绿才可交付；Conventional Commits（feat/fix/refactor/docs/chore），一次一个完整变更，无 AI 署名
3. 用户可见变更同步 README.md/CHANGELOG.md；结构/命令/架构约束变更同步本文件；
