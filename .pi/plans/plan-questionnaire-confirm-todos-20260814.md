# 计划：问卷确认流程 + 待办移位 + 用户消息重复修复

> 状态：待用户确认（/plan 轮次，仅规划未实现）
> 日期：2026-08-14
> 仓库：`C:/source_code/Other/pinel`

## 1. 背景与目标

用户提出三个需求：

1. **待办列表放到输入框上方**（现状在聊天流顶部）
2. **LLM 询问用户问题时自动聚焦到问题；用户回答完最后一个问题后，增加确认程序，允许确认前修改之前回答的问题**
3. **发送提示词后窗口显示两次用户消息**（bug，需修复）

## 2. 方案设计

### 2.1 需求 1：待办面板移位（独立小改）

- `App.tsx`：`TodoPanel` 从 `.pinel-scroll` 上方移到其下方（Composer 上方）
- `styles.css`：`.todopanel` 加 `max-height: 30vh` + flex column，`.todopanel-body` `overflow-y: auto`——任务多时面板内部滚动，不挤压消息区与输入框（已确认限高 30%）

### 2.2 需求 2：整卷问卷 + 确认前修改 + 回填（核心设计）

**实测约束（证据链）**：
- 插件 `@juicesharp/rpiv-ask-user-question`（`~/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/rpc-fallback.ts`）：RPC 模式**逐题串行**走 `ctx.ui.select()`/`ctx.ui.input()`，每题阻塞等待回复；已提交的回复被 pi 消费后**无法撤回**（pi `pendingExtensionRequests` 命中即删除，迟到响应忽略）
- 因此「确认前修改任一题」唯一可行路径（已确认选型）：**pinel 在本地渲染整卷问卷**——`tool_execution_start`（toolName `ask_user_question`）的完整题目参数（`questions: [{question, header, options: [{label, description}], multiSelect?}]`，1-4 题）一次性可见；pi 发来的串行对话框**缓冲不展示**；用户答完确认后 pinel **按序自动回填**

**宿主状态机（controller，权威状态，webview 镜像）**：
- 进入：`tool_execution_start` 且 toolName === "ask_user_question" 且 `parseQuestionnaireArgs(args)` 有效 → 问卷模式（questions + answers journal，phase: answering）
- 问卷模式下的 `extension_ui_request`（select/input）→ **标题门控后**记入缓冲（request.title 含题面文本/header 才属本问卷，否则走现有逐卡路径广播 uiRequest——MED-2）；缓冲与 pendingUi **分离存储**（LOW-6，避免现有 settled 清理与快照误伤）
- 入站操作：
  - `questionnaireAnswer {questionIndex, answer}` → 更新 journal；全部答完 → phase 自动转 reviewing
  - `questionnaireConfirm` → phase=submitting：按缓冲顺序回填；后续新到的串行对话框**自动回填**
  - `questionnaireCancel` → 对所有缓冲帧及后续到达的对话框回 `cancelled`，直到问卷结束
- 回填映射与游标推进规则（HIGH-1 修订，纯函数 `questionnaire.ts`）：
  - 非多选：答选项 → 回 `request.options[optionIndex]` 原行，**游标进下一题**；答自定义 → 回哨兵行（取 `request.options` 末项，LOW-1 不硬编码文案）+ **游标停留本题**，等跟进 input 到达后回自定义文本再进下一题
  - 多选：插件只发 input → 回 `"1,3"` 数字串（1 基升序；空选回 `""`，LOW-5）或自定义文本，**游标进下一题**
  - 题目归属：**标题匹配为主**（input 类用 `"Type your answer:"`/选项列表特征区分哨兵跟进与多选，LOW-1 注：标题随插件 i18n 可变，仅作主判据）+ 顺序游标兑底；单测覆盖混合题型（自定义+多选相邻）
- 退出与清理（HIGH-2 修订）：末题回填完 phase=submitted；`agent_settled`/`handleExit`/`restart` 清理时**先对残留缓冲帧逐帧回 `cancelled`**（插件问卷对话框无 timeout，pi 侧不会自动解锁，必须主动回复防 agent 永久阻塞——协议硬约束）再清状态并广播清除
- 重入语义（MED-3）：新 `tool_execution_start`（ask_user_question）到达时替换旧问卷（对旧缓冲帧补 cancelled）；submit 后 settle 前 UI 显示「已提交」态
- 防御（MED-4）：进入问卷模式时吸收 pendingUi 中标题匹配的帧入 journal（select 先于 tool_execution_start 到达的异常时序）
- `fireSnapshot()` 携带问卷状态（视图隐藏重显恢复）；参数解析失败/非本插件对话框 → 回退现有逐卡路径不变

**webview（Questionnaire.tsx 新组件）**：
- 整卷渲染：题面 Markdown + header 标签 + 选项按钮（单选）/复选框（多选）+ 自定义答案输入行（Type something）+ 选项 preview 折叠（可选）
- 答题进度（i/n）；Esc = 放弃整卷（与 TUI 一致）
- reviewing 阶段：确认面板——全部 Q&A 列表 + 每题「修改」按钮（重新进入编辑态，保留旧答案）+「确认提交」/「取消问卷」

**自动聚焦（已确认：滚动+聚焦输入，范围=所有对话框）**：
- 新 `uiRequest` 卡片到达 → 强制滚动卡片入视野 + 按方法聚焦：input/editor 聚焦输入框、select/confirm 聚焦首个选项/确认按钮、其余容器 tabIndex=-1 聚焦（快照恢复不抢焦点——用 ref 对比新旧请求 id，LOW-2；UiDialogs 卡片加稳定 id）
- 强制滚动后**同步 `stickToBottom.current`**（LOW-2，防后续消息更新把视图拉回）；聚焦前检查 webview 可见性
- 问卷：questionnaire 消息到达/阶段变化 → 滚动问卷 + 聚焦首个未答题（答完则聚焦确认按钮）
- 滚动用 instant（流式高负载下 smooth 有卡顿感）；问卷 Esc = 放弃整卷需**容器级 onKeyDown**（LOW-3，按钮聚焦时 Esc 才能生效），与 Composer Esc 分层语义在 F5 清单注明

**关键取舍**：

| 决策 | 选择 | 理由 |
|---|---|---|
| 问卷架构 | 宿主权威状态 + webview 镜像 | 与 todos/commands 同模式；webview 销毁（视图隐藏）不丢卷，snapshot 恢复 |
| 确认前修改 | 本地整卷 + 回填 | 唯一能让修改生效的方案（pi 已提交答案不可撤回）；已与用户确认 |
| 回填时机 | 确认后按串行顺序自动回填 | 插件每题阻塞，回填顺序由游标推进规则保证（评审 HIGH-1 修订） |
| 非问卷对话框 | 标题门控，不匹配走逐卡即时回复 | 防其他插件对话框被误缓冲错答（评审 MED-2） |
| 聚焦 | 仅新请求触发、instant 滚动 | 快照重放不抢焦点；避免流式期动画卡顿 |

### 2.3 需求 3：用户消息重复显示（bug 修复）

**根因**（已实测 pi dist/core/agent-session.js）：pi 的事件转发对 `message_start`/`message_end` **不按 role 过滤**，用户消息同样发出这两个事件（queue 清理逻辑以 `message_start(user)` 为钩子即佐证）。pinel `message_end` 分支 push + fire `message` → webview 追加第二条用户消息（乐观渲染一条 + pi 事件一条），直到 `agent_end` snapshot 全量替换才修正——整个流式期可见重复。

**修复**（controller）：
- `message_end`：`role === "user"` 跳过（不 push 不 fire；权威用户消息由 `agent_end`/settle `get_messages` 快照提供，乐观渲染保留即时反馈）
- `message_start`：对**全 role** 设置 `currentStreamRole`（LOW-4 防旧值残留）；`message_update` 仅当 `currentStreamRole === "assistant"` 时应用（防御：若 pi 未来对用户消息发 delta，不渲染成助手气泡）
- 新增 message 事件计数钩子：**只统计 pi 事件来源**（message_end 分支）的 user/assistant/toolResult 计数（乐观渲染不计入）；集成测试断言 user === 0 且消息列表恰好一条用户消息（MED-1）

## 3. 任务拆解（与 todo 镜像）

| id | 任务 | blockedBy |
|---|---|---|
| 11 | 问卷纯模块与单测 | — |
| 12 | 修复用户消息重复显示（含 fake-pi 默认流用户事件 + 集成断言） | — |
| 13 | 待办面板移到输入框上方 | — |
| 14 | 宿主问卷状态机 | 11 |
| 15 | 面板转发与测试钩子 | 14 |
| 16 | webview 类型镜像 | 14 |
| 17 | webview 问卷组件与自动聚焦 | 16 |
| 18 | 问卷与待办样式 | 17, 13 |
| 19 | fake-pi QUESTIONNAIRE 场景与集成测试 | 15, 17 |
| 20 | 验证与文档同步 | 11–19 |

执行顺序：11/12/13 并行 → 14 → 15/16 并行 → 17 → 18/19 并行 → 20。
提交粒度（一次一个完整变更，评审 MED-5 修订）：`fix:` 重复消息 = **T12 含 fake-pi 用户消息事件 + 集成测试**（自含验证闭环）；`feat:` 问卷确认流程 = 11+14~19 的问卷部分；`feat:` 待办移位 = 13 + T18 中的待办 30vh 样式（T18 按归属拆分：问卷样式进问卷提交、待办样式进待办提交）。

## 4. 涉及的文件

```
src/chat/questionnaire.ts          # 新：参数防御解析 + 回填映射纯函数（T11）
src/test/questionnaire.test.ts     # 新：纯函数单测（T11）
src/chat/controller.ts             # 消息 role 门控 + 问卷状态机 + 计数钩子（T12/T14）
src/chat/panel.ts                  # 新入站消息转发（T15）
src/extension.ts                   # PinelTestApi 新钩子（T12/T15）
webview-ui/src/types.ts            # QuestionnaireView/AnswerView 镜像（T16）
webview-ui/src/components/Questionnaire.tsx  # 新：整卷问卷 + 确认面板（T17）
webview-ui/src/components/UiDialogs.tsx      # 卡片稳定 id（T17）
webview-ui/src/App.tsx             # 待办移位 + 问卷接入 + 自动聚焦（T13/T17）
webview-ui/src/styles.css          # 问卷/确认/聚焦/待办 30vh 样式（T18）
src/test/fixtures/fake-pi.js       # QUESTIONNAIRE 场景 + 默认流用户消息事件（T19）
src/test/extension.test.ts         # 集成测试（T19）
README.md / CHANGELOG.md / AGENTS.md  # 文档同步（T20）
```

## 5. 验证方式与风险

**验证**：
- `npm run compile` + `npm test` 全绿（现有 46 + 新增单测与集成）
- 单测 `questionnaire.test.ts`：参数防御解析（合法/缺字段/结构不符/未知插件）、回填映射与游标推进（选项行/哨兵+跟进 input 停留/多选数字/自定义文本/**混合题型相邻**/空选回空串）、标题匹配归属（含两题同题面兑底）
- 集成测试（fake-pi QUESTIONNAIRE 场景：串行 select/input 逐一等响应、哨兵跟进 input、多选 input、响应序列日志断言）：问卷全链路（答题→reviewing→confirm→回填顺序→submit 后 settle 前状态→settle 清卷）、修改后确认（最终答案为准）、取消路径（**取消后无残留帧**）、问卷期间通用对话框走逐卡路径、用户消息重复修复（messages 恰好一条 user + pi 事件计数 user=0）、既有 ASKUI/UIREQUEST 通用对话框回归
- F5 人工验收：待办面板在输入框上方且 30vh 内滚动；真机触发 ask_user_question → 整卷显示、自动滚动聚焦、答完确认面板、修改重答、确认后 agent 拿到最终答案、取消整卷、发送消息只显示一次、通用对话框自动聚焦回归

**风险**：

| 风险 | 缓解 |
|---|---|
| 题目归属映射依赖插件串行顺序 | 标题匹配为主 + 顺序游标兑底（评审 HIGH-1）；单测覆盖混合题型 |
| 插件未来改名/改协议/i18n 变化 | toolName 门控 + 参数解析失败回退逐卡路径；哨兵取 options 末项不硬编码文案（LOW-1） |
| 问卷清理后插件 walker 永久 await（无 timeout） | 三处清理先对残留缓冲帧逐帧回 cancelled（评审 HIGH-2） |
| 问卷期间视图隐藏重显 | 宿主权威状态 + snapshot 携带，webview 重建后恢复 |
| 聚焦抢走 Composer 输入焦点 | 仅新请求触发（快照重放不抢）；滚动后同步 stickToBottom；聚焦前检查 webview 可见（LOW-2）；用户已确认接受 |
| 用户消息事件被误杀（会话重放场景） | 重放走 get_messages 全量 snapshot，不经 message 事件，不受影响 |
| 问卷卡死（用户不操作） | 取消按钮 + 容器级 Esc 放弃整卷；settled/handleExit 清理补 cancelled（LOW-3） |
| 其他插件对话框在问卷期间被误缓冲 | 标题门控：不匹配走现有逐卡路径（评审 MED-2） |
| 同一会话多次问卷 | 新问卷替换旧问卷 + 旧缓冲帧补 cancelled（评审 MED-3） |
| select 先于 tool_execution_start 到达 | 进入问卷模式时吸收 pendingUi 中标题匹配的帧（评审 MED-4） |

## 6. 需要用户确认的决策点

已确认（2026-08-14）：

1. ✅ 问卷方案：整卷问卷 + 确认后自动回填（唯一能让「确认前修改」生效的方案）
2. ✅ 自动聚焦：滚动 + 聚焦输入
3. ✅ 聚焦范围：所有对话框（含非问卷 ctx.ui 卡片）
4. ✅ 待办面板：限高 30% 内部滚动

## 7. 调研记录

- **本地源码实测**（无外部网络依赖）：插件 rpiv-ask-user-question 的 rpc-fallback.ts（串行 walker、哨兵行、多选 input 协议）、ask-user-question.ts（工具名与 schema）、pi dist agent-session.js（用户消息事件转发、queue 清理钩子）
- **web_search / context7**：不适用（无新库、无外部 bug 查询需求；全部行为本地实测佐证）

## 8. 评审修订记录（subagent 审查后）

- **HIGH-1**：回填游标规则细化——哨兵跟进 input 与多选 input 的区分（游标停留本题直至跟进消费；标题匹配为主+游标兑底）
- **HIGH-2**：清理路径（settled/handleExit/restart）先对残留缓冲帧逐帧回 cancelled（插件问卷无 timeout，pi 侧不会自动解锁）
- **MED-1~5**：计数钩子只统计 pi 事件来源；缓冲前标题门控；重入替换语义；select 先到吸收防御；T12 提交吸收 fake-pi 改动与集成测试（自含验证）
- **LOW-1~6**：哨兵取 options 末项；聚焦后同步 stickToBottom + 可见性检查；容器级 Esc；currentStreamRole 全 role 设置；多选空提交回空串；缓冲与 pendingUi 分离存储
