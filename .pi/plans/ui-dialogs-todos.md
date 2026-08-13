# 移除图片按钮、修复工具结果缩进、实现交互界面（对话框 + 待办列表）

> 状态：待用户确认后执行
> 日期：2026-08-13

## 1. 背景与目标

用户提出三个需求：

1. **移除「添加图片」按钮**（保留 Ctrl+V 粘贴图片能力，已确认）。
2. **修复工具调用结果左侧缩进**：与其他消息相比左侧短了一点。
3. **实现交互界面**：适配两个用户安装的 pi 插件——`@juicesharp/rpiv-ask-user-question`（AI 提问）与 `@juicesharp/rpiv-todo`（待办列表），使其在 pinel 面板中正常显示（已确认：对话框用内联卡片，待办面板放聊天流顶部）。

## 2. 根因分析（全部经实测验证）

### 2.1 图片按钮

`webview-ui/src/components/Composer.tsx`：🖼 按钮 + 隐藏 `<input type="file">` + `onPick`/`fileInput`。粘贴（`onPaste`）是独立路径，保留。

### 2.2 工具结果缩进

`webview-ui/src/styles.css`：`.toolresult { margin: 6px 0 6px 12px; }` —— 左侧 12px 缩进；而 `.toolchip`（工具调用）与消息均为无左缩进。一行 CSS 修复。

### 2.3 交互界面（实测协议行为）

**对话框（AI 提问）**：
- 当前 controller 对 `select/confirm/input/editor` 一律自动回复 `cancelled: true`（v0.1 策略），导致 `rpiv-ask-user-question` 问卷首题即被取消。
- 实测该插件在 RPC 模式下走标准协议：单选 → `extension_ui_request method: select`（title 含 `[header]` 前缀与 preview 折叠文本，options 为 `"N. label — description"` 行 + `"N. Type something."` 哨兵行）；选哨兵行后 → `input` 对话框；多选 → `input`（数字列表指令）。逐题串行询问。
- pi 侧对带 `timeout` 的 dialog 自动超时 resolve（客户端无需管超时）；客户端迟到回复会被 pi 忽略（安全）。
- dialog 阻塞 agent（期间不会 `agent_settled`），同一时刻通常只有一个待决对话框；按 id 用 Map 管理即可。

**待办列表**：
- `rpiv-todo` 通过 `setWidget("rpiv-todos", 组件工厂)` 注册 TUI 组件；pi 0.84.1 的 RPC 模式对工厂函数**静默忽略**（只透传 `content === undefined` 的清除帧），pinel 收不到任何内容。
- 实测可行替代：`tool_execution_end`（`toolName === "todo"`）的 `result.details.tasks` 是**每次执行后的全量任务快照**（create/update 均返回），字段 `{id, subject, status: "pending"|"in_progress"|"completed"|"deleted", description?, activeForm?}`，另有 `nextId`。pinel 可自行解析维护。
- 该字段未写入 pi 官方 rpc.md（未文档化依赖）→ 解析必须防御性（结构不符时静默降级）。

**setStatus/setWidget（字符串数组）**：pi 当前对 `mcp`/`subagent-async` 等只发无内容（清除）帧，暂无可显示内容；**本轮不实现渲染**（未来 pi 支持字符串数组 widget 时再扩展）。

## 3. 方案设计

### 3.1 移除图片按钮

- `Composer.tsx`：删除 🖼 按钮、隐藏 file input、`onPick`、`fileInput` ref；保留 `onPaste`、`attachments` 状态、附件预览与移除按钮、`send` 中图片随 prompt 发送逻辑。
- README/CHANGELOG 同步。

### 3.2 工具结果缩进

- `.toolresult` margin 改为 `6px 0`（与 `.toolchip` 一致）。

### 3.3 对话框（内联卡片）

**宿主侧（controller）**：
- `extension_ui_request` 的 dialog 方法（select/confirm/input/editor）不再自动 cancelled，改为：存入 `pendingUi: Map<id, ExtensionUiRequest>`，广播新 OutMessage `{ type: "uiRequest", request }`。
- 新增 webview 入站消息 `{ type: "uiResponse", id, value?, confirmed?, cancelled? }`：**id 不在 `pendingUi` 中时静默忽略**（防御跨进程同 id 复用/迟到双答）；命中则 `writeRaw({ type: "extension_ui_response", id, ... })` 回复 pi，从 `pendingUi` 删除并广播 `{ type: "uiResolved", id }`。
- 批量清除广播：新 OutMessage `{ type: "uiCleared" }`（一次性清空 webview 全部对话框卡片，避免逐 id N 条消息）。
- `agent_settled` 时清空 `pendingUi`（pi 超时自动 resolve 或 abort 后残留的对话框不再显示）并广播 `uiCleared`。**该清扫正确性依赖「对话框阻塞期间不会 settle」这一实测断言，实现注释中记录该假设，并列入 F5 验证清单。**
- `handleExit`（进程崩溃）同样清空 `pendingUi` + 广播 `uiCleared`（防崩溃后卡片滞留、作答无效）。
- `restart()` 在重置状态时**随状态广播一并发送 `uiCleared`**（防旧卡片在重启窗口内被应答，且新进程可能复用同 id），并清空 `pendingUi`。
- `fireSnapshot()` 携带 `pendingUi` 数组（webview 重载/重显后对话框恢复显示）。
- `notify` 保留现有 notice 处理；`setStatus/setWidget/setTitle/set_editor_text` 继续忽略（本轮范围外）。

**webview 侧**：
- 新组件 `UiDialogs.tsx`：渲染 `pendingUi` 列表（内联在聊天流末尾）：
  - `select`：标题（Markdown 渲染，支持 preview 折叠文本）+ 选项按钮列表（选项行整串 `"N. label — description"` 作为按钮文本渲染，与 TUI 显示一致；哨兵行 `"N. Type something."` 即普通选项——选中后 pi 会跟进发 `input` 对话框，流程自然）+ 取消按钮；`options` 缺失时渲染空态提示，取消按钮仍可用。
  - `confirm`：标题 + message + 「确认 / 拒绝 / 取消」；
  - `input`：标题 + 单行输入（placeholder）+ 「提交 / 取消」（Enter 提交）；
  - `editor`：标题 + 多行 textarea（prefill）+ 「提交 / 取消」（Ctrl+Enter 或按钮提交）。
- **对话框内的 Esc 键 = 取消当前对话框**（输入框 keydown 处理，不触发 Composer 的全局 abort——两者是独立元素，互不干扰）。
- 用户操作 → `vscode.postMessage({ type: "uiResponse", ... })`。
- 类型镜像更新 `webview-ui/src/types.ts`（UiRequest、uiRequest/uiResolved/uiCleared/todos 消息）。
- 样式：高亮卡片（区别于消息气泡），选项按钮竖向排列。
- `App.tsx` 自动滚动 effect 依赖加入 `pendingUi`（新卡片出现在流末尾时自动滚到底部，否则用户看不到）。

**行为变更**：v0.1「对话框自动取消防阻塞」策略移除——现在用户可见并可作答/取消（用户主动需求，属 v0.2 范围提前实现）。

### 3.4 待办列表面板（流顶部固定）

**宿主侧**：
- 新纯模块 `src/chat/todos.ts`：`parseTodoTasks(result: unknown): TodoTask[] | null`——从 `tool_execution_end` 的 result 防御解析 `details.tasks`（校验数组与字段类型；**逐条防御：跳过损坏条目，至少 1 条有效即返回有效列表**；全部无效/结构不符返回 null）。
- controller：`tool_execution_end` 且 `toolName === "todo"` 时解析成功则更新 `todos` 状态并广播 `{ type: "todos", todos }`；解析失败静默（不打断工具卡片显示）。
- `fireSnapshot()` 携带 `todos`；`restart()`/新会话清空 `todos`。
- 空列表 → 面板隐藏。
- **已知限制（计划内注明）**：todo 状态为运行期内存态（restart 后 pi 新进程本身也重置，一致）；历史消息中的 todo 结果不含 `details`，不做历史重建。

**webview 侧**：
- 新组件 `TodoPanel.tsx`：聊天流顶部固定面板（`pinel-scroll` 上方），`<details>` 折叠；任务行：状态图标（○ pending / ● in_progress 带 spinner / ✓ completed；deleted 不渲染）+ subject + activeForm（in_progress 时）+ description 截断。
- `App.tsx`：`todos` 状态 + 渲染。
- 样式：卡片面板，紧凑单行任务。

### 3.5 测试

**单测**（`src/test/todos.test.ts`）：
- `parseTodoTasks`：create 快照、update 快照（含 activeForm）、空 tasks、缺失 details、非数组 tasks、损坏 JSON、**数组内部分条目损坏（跳过坏条目保留好条目）** → 正确解析或 null。

**集成测试**（`src/test/extension.test.ts`，fake-pi 新场景；**waitForSettled 基线必须在触发动作前捕获（AGENTS.md 纪律）**）：
- 改写现有「extension_ui_request 对话框被自动取消」测试：行为已变——UIREQUEST 场景改为「对话框请求被广播（getPendingUi 可见）→ 经新钩子 `uiRespond` 回复 → 假 pi 收到 `extension_ui_response`（非 cancelled）→ 流式正常完成」。
- 新增「todo 工具结果解析为待办列表」：prompt 含 `TODOME` → fake-pi 发 `tool_execution_start/end`（toolName todo、details.tasks 快照）→ 断言 `getTodos()` 内容；snapshot 后待办状态仍在。
- 新增「settled 清理未决对话框」：**fake-pi 新增 `ASKUI-TIMEOUT` 场景**（发带 timeout 的对话框帧，**不等待响应**，定时器到点后直接走完流并 settle——现有 UIREQUEST 场景不回复时会永久等待、abort 在 streaming=false 时不发 settle，不可复用）→ 断言 settled 后 `getPendingUi()` 为空。
- 新增「进程退出清理对话框」：`CRASHME` 组合（或新场景）在对话框 pending 时崩溃 → 断言 error 态时 `getPendingUi()` 为空。

**PinelTestApi 扩展**：`uiRespond(id, response)`、`getPendingUi()`、`getTodos()`。

**fake-pi 扩展**：
- `ASKUI` 场景：发 `select` 对话框帧（带 options）→ 等 `extension_ui_response`（现有 `waitForUiResponse` 复用）→ 记录收到的响应（dir: "ui-response"）→ 正常完成流。
- `ASKUI-TIMEOUT` 场景：发带 timeout 的对话框帧后不等待，延时后直接走完流（模拟 pi 超时自动 resolve）。
- `TODOME` 场景：prompt 中发两轮 `tool_execution_start/end`（todo 快照：2 个任务、第 2 个 in_progress）。

### 3.6 关键取舍

- **待办列表数据源**：解析 `details.tasks` 是当前 pi 版本唯一可行路径（上游 pi 吞掉组件工厂）。未文档化依赖 → 防御解析 + 静默降级；若未来 pi 在 RPC 模式支持字符串数组 widget 或提供 todo 专用事件，再迁移（在代码注释与 AGENTS.md 记录）。
- **setStatus/setWidget 渲染不做**：pi 当前只发无内容帧，实现无意义（YAGNI）。
- **editor 对话框**：pi 0.84.1 的 RPC UI 不发 editor，但与 input 共用 textarea 组件成本≈0，一并实现（协议类型已备好）。
- **不修改协议层类型**（ExtensionUiRequest 字段已完备）；todo 解析在独立纯模块防御完成。
- **不引入新依赖**；webview 侧复用 react-markdown 渲染对话框标题中的 preview 文本。

## 4. 任务拆解

1. **移除图片按钮**：`Composer.tsx` 删按钮/file input/onPick/ref；README/CHANGELOG 同步。
2. **修复缩进**：`.toolresult` margin → `6px 0`。
3. **宿主对话框处理**：controller `extension_ui_request` 分支重构（pendingUi Map + uiRequest/uiResolved 广播 + uiResponse 入站处理 + settled 清理 + restart 清理 + snapshot 携带）；panel.ts 转发 `uiResponse` 消息类型。
4. **宿主 todo 解析**：新建 `src/chat/todos.ts`（parseTodoTasks 纯函数）+ controller 集成（tool_execution_end 分支、todos 状态、snapshot、restart 清理）。
5. **webview 对话框 UI**：新建 `UiDialogs.tsx`；`App.tsx` 接入 pendingUi 状态与渲染（流末尾内联）；types.ts 镜像。
6. **webview 待办面板**：新建 `TodoPanel.tsx`（流顶部固定、可折叠）；`App.tsx` 接入；types.ts 镜像。
7. **样式**：`.toolresult` 修复 + 对话框卡片样式 + 待办面板样式（复用 VS Code CSS 变量）。
8. **测试钩子与假 pi**：`PinelTestApi` 加 `uiRespond/getPendingUi/getTodos`；fake-pi 加 `ASKUI`/`ASKUI-TIMEOUT`/`TODOME` 场景。
9. **测试**：`todos.test.ts` 单测 + 集成测试（改写 UIREQUEST 测试 + 新增 TODO 解析 + settled 清理 + 进程退出清理）。
10. **验证**：`npm run compile` + `npm test` 全绿（既有 25 个必须保持通过，其中 UIREQUEST 测试按新行为改写）；F5 手动验证：真机发含决策点 prompt 触发问卷卡片作答、todo 面板随任务更新。
11. **文档同步**：README（移除图片按钮说明、交互界面）、CHANGELOG、AGENTS.md（范围纪律段更新：交互 UI 已实现；v0.2 剩余项调整；todo 数据源踩坑记录）。

## 5. 涉及文件

- `webview-ui/src/components/Composer.tsx`（移除按钮）
- `webview-ui/src/styles.css`（缩进修复 + 新组件样式）
- `webview-ui/src/components/UiDialogs.tsx`（新）
- `webview-ui/src/components/TodoPanel.tsx`（新）
- `webview-ui/src/App.tsx`（pendingUi/todos 状态接入）
- `webview-ui/src/types.ts`（协议镜像）
- `src/chat/controller.ts`（对话框重构 + todo 集成）
- `src/chat/todos.ts`（新：解析纯函数）
- `src/chat/panel.ts`（uiResponse 消息转发）
- `src/extension.ts`（测试钩子）
- `src/test/todos.test.ts`（新）
- `src/test/extension.test.ts`（改写 + 新增）
- `src/test/fixtures/fake-pi.js`（新场景）
- `README.md`、`CHANGELOG.md`、`AGENTS.md`

## 6. 验证方式与风险

**验证**：
- 自动化：`npm run compile`、`npm test`（25 既有中 1 条按新行为改写 + 新增约 5 条）。
- 手动：F5 真机——发送含明确决策点的 prompt，验证问卷卡片出现、作答后模型拿到答案；触发 todo 工具，验证顶部面板随 create/update 刷新；折叠/展开面板；粘贴图片仍工作；工具结果与其他消息左对齐；**专项检查：对话框 pending 期间观察面板不出现「就绪/settled」状态翻转（agent_settled 清扫正确性的前提）**；对话框卡片上按 Esc 只取消对话框不中断流式。

**风险与缓解**：
- `details.tasks` 是 pi 未文档化字段：防御解析，任何结构不符静默降级（工具卡片仍显示）；在 AGENTS.md 记录该依赖与迁移路径。
- 对话框阻塞 agent：用户不回复时 agent 永久阻塞（v0.1 的自动取消动机）。缓解：取消按钮始终可用；pi 侧 `timeout` 字段自动超时；`agent_settled` 清理残留 UI。文档提示用户注意阻塞语义。
- webview 重载（视图隐藏/折叠）时对话框丢失：snapshot 携带 pendingUi 恢复 ✓；todo 面板同理。
- 多对话框并存（理论上单线程，但保险按 Map 渲染全部）：UI 顺序渲染，各自独立 id 回复。
- 现有集成测试 UIREQUEST 场景依赖自动取消：按新行为改写（必须与实现同步提交）。

## 7. 决策点（已与用户确认）

1. 图片：仅移除按钮，保留 Ctrl+V 粘贴（含附件预览/移除）✓
2. 待办实现路径：适配 `rpiv-ask-user-question`（标准对话框）+ `rpiv-todo`（解析工具结果快照）✓
3. 对话框形式：内联卡片 ✓
4. 待办面板位置：流顶部固定面板 ✓

## 8. 执行记录（2026-08-13）

**已完成**：计划 §4 任务 1-11 全部落实；实现评审（subagent）结论「通过（无 blocker）」，3 项次要问题已修订：
- TodoPanel 补 description 截断渲染（`.todotask-desc`）
- `parseTodoTasks` 空数组语义修正：`tasks: []` 为合法空快照返回 `[]`（删光任务后面板隐藏），非空但全损坏才返回 null（保留旧状态）
- 清理 `.composer-icon-btn` 死 CSS

**验证**：`npm run compile` + `npm test` 连续多轮全绿（34/34：main 33 + no-workspace 1）。

**待用户手动验证（F5 真机）**：问卷卡片作答链路（ask_user_question）、todo 面板随任务刷新、对话框 pending 期间无「就绪」状态翻转、卡片内 Esc 只取消对话框、粘贴图片、工具结果左对齐。
