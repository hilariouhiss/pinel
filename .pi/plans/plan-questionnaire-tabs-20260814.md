# 计划：问卷面板标签式改造（顶部横向标签切换）

> 状态：✅ 已实现（2026-08-14；F5 人工验收待用户执行）
> 日期：2026-08-14
> 仓库：`C:/source_code/Other/pinel`
> 关联：`f1e702a` 引入的整卷问卷（`plan-questionnaire-confirm-todos-20260814.md`）的交互形态改造

## 1. 背景与目标

当前问卷（`webview-ui/src/components/Questionnaire.tsx`）将所有题目**竖向堆叠**渲染。用户要求改为**标签式横向切换**：

1. 问题标题在面板顶部**横向排列**（标签栏）
2. 点击标签**跳转**到该问题
3. 题目排布由竖向堆叠改为**横向切换**（同一时刻只显示一道题）

## 2. 方案设计

### 2.1 结构（Questionnaire.tsx 重构）

```
┌─ 提问问卷（已答 i/n）· 已提交提示 ─────────┐
│ [q1✓] [Q2] [q3] [确认]          ← 横向标签栏 │
├──────────────────────────────────────────────┤
│ 当前激活题（或确认面板）——条件渲染，仅一道   │
└──────────────────────────────────────────────┘
```

- **标签栏** `qna-tabs`：每题一个标签 + 「确认」标签；`overflow-x: auto` 防窄面板溢出
- **条件渲染**：仅渲染当前激活题（候选 A 全渲染 + display:none 被否——DOM 全量无收益，且选项态/草稿均在宿主权威与父级 state，切换无状态丢失风险）
- **标签文案**（已确认：header 优先）：`header` 存在用 header；否则 `Q{i+1}`
- **✓ 标记**（已确认）：已答题标签显示 ✓；未答无标记；顶部「已答 i/n」计数保留

### 2.2 交互状态机

- `activeTab: number | "confirm"`；初始 = 首个未答题，**reviewing+ 阶段回退 "confirm"**（快照恢复时已全答完，无未答题可切，否则空白面板——评审 M1）
- **自动切换（全部由点击处理器显式驱动，评审 H1）**：
  - 单选：点击选项 → 答题并 `setActiveTab(下一未答题)`——**仅当存在下一未答题时前进**；最后一题的切换交给 answering→reviewing 跃迁 effect（避免乐观切确认标签时 phase 仍是 answering、确认标签未渲染的空窗——评审 M2）
  - 多选：勾选**不**切（防选到一半被跳走）；卡片底部「下一题」按钮（仅多选题渲染）显式切走（允许空选——宿主对空多选回空串，语义合法）
  - 「使用自定义答案」提交 → 视为完整答案自动切下一未答题（同上，仅当前方存在未答题时）
  - **reviewing 阶段点击处理器一律不前进**（修改重答不自动切回确认，用户手动点「确认」标签）
- **确认标签**（已确认：独立确认标签）：
  - 仅在 reviewing/submitting/submitted 阶段渲染（answering 时不渲染）
  - **自动切换仅在 answering→reviewing 单一跃迁发生**（prevPhase ref 检测）：切确认标签 + 聚焦确认按钮；其余 phase 变化（reviewing→submitting→submitted）不改变 activeTab（submitting 期用户可浏览题标签不被拽回——评审 M4）
  - reviewing：完整确认面板（Q&A 列表 + 「修改」+ 确认提交/取消问卷）；「修改」→ 切到对应题标签并聚焦该题首个选项
  - submitting/submitted：**只读 Q&A 列表**（复用 answerSummary 行）+ head 已提交文案，**隐藏确认提交/取消按钮**（提交中可取消会中断回填，与现状一致仅保留 Esc——评审 M3）
- **聚焦机制（评审 H1/L4 修订）**：
  - 跃迁 effect 依赖 `[q.phase, focusVersion]` 但分支内用 prevPhase ref 只对 **answering→reviewing 跃迁**与 **q.questions 引用变化（重入替换）**做响应（重入 → 重置 activeTab 首个未答题并聚焦）；**不得对每次广播无条件重算**（否则多选勾选/reviewing 修改被拽走，与已确认语义相悖）；App.tsx 零改动（focusVersion 仍作触发器）
  - activeTab 变化聚焦 effect 同样 **firstRun 门控**（挂载不聚焦，快照恢复不抢焦点）+ `document.hasFocus()` 守卫；聚焦目标：题目→首选项/输入，确认→确认按钮
- **保留行为**：容器级 Esc 放弃整卷、drafts 按题目保留（跨标签切换不丢）、锁定态（submitting/submitted 禁用答题控件但允许浏览标签）

### 2.3 关键取舍

| 决策 | 选择 | 理由 |
|---|---|---|
| 渲染方式 | 条件渲染仅激活题 | 状态均在宿主权威/父级 state（drafts/answers），卸载无丢失（仅 `<details>` 预览展开态属 DOM 态，切走需重展，可接受）；避免全量 DOM 与隐藏题目的聚焦干扰 |
| 自动切换驱动 | 点击处理器显式驱动（评审 H1） | 现有 focusVersion 每次广播都触发，若照搬会重算 activeTab 把多选/reviewing 修改拽走 |
| 多选切换 | 不自动切 + 「下一题」按钮 | 已确认；多选是连续交互，跳走打断选择 |
| 确认面板 | 独立确认标签 | 已确认；横向栏容纳 5 个标签仍可横向滚动兜底 |
| 修改后行为 | 停留题标签不自动回确认 | 连续修改多题时避免反复被拽回确认页 |
| 影响面 | 纯 webview（Questionnaire.tsx + styles.css） | 宿主/协议/状态机零改动；webview 无测试基建 → F5 人工验收（仓库惯例） |

## 3. 任务拆解（与 todo 镜像）

| id | 任务 | blockedBy |
|---|---|---|
| 21 | 问卷组件标签式重构（Questionnaire.tsx） | — |
| 22 | 标签栏样式（styles.css） | 21 |
| 23 | 验证与文档 | 21, 22 |

单提交 `feat:`（21+22+23 一个完整变更）。

## 4. 涉及的文件

```
webview-ui/src/components/Questionnaire.tsx   # 标签栏 + activeTab 状态机 + 条件渲染（T21）
webview-ui/src/styles.css                     # qna-tabs 横向布局/激活态/✓/确认标签样式（T22）
CHANGELOG.md                                  # 功能条目（T23）
```

## 5. 验证方式与风险

**验证**：
- `npm run compile` + `npm test` 全绿（宿主零改动，预期 59/59 不受影响）
- F5 人工验收：标签点击跳转；单选答完自动跳下一题；多选「下一题」与空选；自定义答案提交后切换；✓ 标记与「已答 i/n」；确认标签在答完全部后出现并自动切换；「修改」跳转回题标签并聚焦；连续修改不被打断；窄面板标签横向滚动与长 header 截断；视图隐藏重显快照恢复（reviewing 阶段回退确认标签、不抢焦点）；**多选勾选不自动切（负例）**；**最后一题为多选时勾选后切确认（接受该行为）**；新问卷重入替换（activeTab 重置 + drafts 清空）；drafts 跨标签保留；Esc 在题/确认两态均生效；submitting 锁定可浏览标签且确认标签无操作按钮；answering 下确认标签不渲染；亮/暗主题
- 真机触发 ask_user_question 问卷全流程

**风险**：

| 风险 | 缓解 |
|---|---|
| 窄面板标签溢出（≤4 题 + 确认 = 5 标签） | 标签栏 overflow-x: auto + 标签 flex-shrink: 0 + 标签自身 ellipsis（min-width: 0） |
| 广播驱动重算拽走多选/reviewing 修改（评审 H1） | 自动切换全部由点击处理器显式驱动；effect 仅响应 answering→reviewing 跃迁与 questions 重入 |
| 最后一题乐观切确认标签的空窗（评审 M2） | 点击处理器仅当前方存在未答题时前进；最后一题切换由跃迁 effect 完成 |
| 标签聚焦抢走用户输入 | document.hasFocus 守卫 + 两个 effect 均 firstRun 门控（评审 L4） |
| 多选「下一题」跳过未答（空选） | 空选语义合法（宿主回空串），确认面板显示「（未选择）」供用户发现 |
| 预览展开态跨标签丢失（评审 L1） | 条件渲染的固有退化，可接受；F5 不列为缺陷 |

## 6. 需要用户确认的决策点

已确认（2026-08-14）：

1. ✅ 标签文案：header 优先，无 header 用 Q题号
2. ✅ 自动切换：单选答完自动切下一题；多选/自定义用「下一题」按钮切走
3. ✅ 状态标记：✓ 标记已答题
4. ✅ 确认面板：独立「确认」标签（答完全部后出现并自动切换）

实现语义细化（执行时按此处理，如需调整请在确认时指出）：
- 「使用自定义答案」按钮点击视为完整答案 → 自动切下一题（与单选一致）
- reviewing 阶段修改重答后**不**自动切回确认标签（避免连续修改被拽走），用户手动点「确认」标签
- 多选「下一题」按钮允许未选任何选项直接切走（空选语义合法）

## 7. 调研记录

- **memory**：问卷实现与约束已在前序计划 `plan-questionnaire-confirm-todos-20260814.md` 与 memory-project 图（questionnaire-confirm-flow 实体）沉淀，本次为纯 UI 形态改造，无需外部调研
- **web_search / context7**：不适用（无新库、无外部信息需求；纯 React 组件重构）

## 8. 评审修订记录（subagent 审查后）

- **H1**：自动切换下沉到点击处理器显式驱动；跃迁 effect 用 prevPhase ref 仅响应 answering→reviewing 与 questions 重入，不做每次广播无条件重算（否则多选勾选/reviewing 修改被拽走，与已确认语义相悖）；App.tsx 零改动
- **M1**：activeTab 初始值 reviewing+ 阶段回退 "confirm"（无未答题时防空白面板）
- **M2**：最后一题切换由跃迁 effect 完成（点击处理器仅当前方存在未答题时前进，防确认标签未渲染的空窗）
- **M3**：submitting/submitted 确认标签 = 只读 Q&A 列表 + 已提交文案，隐藏确认/取消按钮（防提交中取消中断回填）
- **M4**：确认标签自动切换仅发生在 answering→reviewing 单一跃迁，其余 phase 变化不动 activeTab
- **L1-L6**：预览展开态跨标签丢失（接受）；标签 ellipsis 截断；最后一题多选勾选切确认（接受，F5 负例覆盖）；两个聚焦 effect 均 firstRun 门控；F5 清单补充负例与重入/锁定浏览；a11y 可选不强制

## 9. 执行记录（实施后回溯更新）

- **实施**：Questionnaire.tsx 标签式重构（activeTab 状态机、点击处理器驱动切换、双跃迁/重入与聚焦 effect、条件渲染）+ styles.css qna-tabs 样式；`npm run compile` 与 `npm test` 全绿（59/59，宿主零改动无回归）
- **待用户 F5 人工验收**：标签切换、单选自动跳下一题、多选「下一题」与空选、✓ 标记、确认标签出现与自动切换、修改跳转、连续修改不被打断、窄面板横向滚动、快照恢复、多选不自动切（负例）、最后一题多选勾选切确认、重入替换、drafts 跨标签保留、Esc 两态生效、锁定浏览、亮/暗主题
