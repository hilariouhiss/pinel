# subagent 卡片展开显示当前输出 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** subagent 卡片点击展开后不再显示 "N tool uses..."（多少次工具调用占位），改为显示**当前输出**：运行中（含后台）显示 live 活动预览（details.activity），完成后显示完整结果文本。

**Architecture:** 根因已实证（@gotgenes/pi-subagents v21.0.3 源码）：扩展在运行期间通过 `tool_execution_update` 发出的 content 是字面占位 `"${toolUses} tool uses..."`（foreground-runner.ts streamUpdate），子代理正文不流式暴露（进程内运行，live 文本只在内部 state.responseText；对父会话仅 `details.activity` 携带活动描述或截断响应文本预览）。因此"当前输出"的可靠数据源 = `card.activity`（宿主已实时合并 details.activity）。改动集中在 webview 的 `SubagentCard`（MessageView.tsx）：live 状态（running/background）下展开体显示 activity 而非 output；完成后仍显示 output（tool_execution_end content = "Agent completed in … + 完整 result"，现状已达）。统计行（N tool uses / N turns / tokens）保持不动——那是统计，不是占位。

**Tech Stack:** React（webview 组件条件渲染）；零新依赖；无宿主/插件改动。

**Spec:** 本会话用户需求（经澄清：仅需求 1；运行中数据源采用 activity 预览方案）。

## 需求明细

1. 运行中（running / background）展开 subagent 卡片：正文区显示当前活动/输出预览（`displayText = card.activity`），不显示 "N tool uses..." 占位。
2. activity 为空（如 background 一次性更新路径）时降级：无内容则不显示展开体（canExpand=false），不显示占位。
3. 完成后展开：显示完整结果文本（现状行为，回归不变）。
4. 统计行（activity / N turns / N tool uses / tokens / 时长 / Running in background）原样保留。

## Global Constraints

- 只改 `vscode/webview-ui/src/components/MessageView.tsx` 的 SubagentCard 组件；宿主（controller.ts / subagents.ts）与插件零改动。
- 判定 live = `status === "running" || status === "background"`（background 语义 = 仍在执行）。
- 展开体渲染与现有 output 路径同构（Markdown 渲染 + msg-text 样式），只换数据源。
- 自动开合 effect（background 自动展开 / 完成后收起 / 手动 toggle）行为不变。
- 零新依赖；中文注释；`npm run compile` / `npm run package` 全绿。
- 已知边界（挂账）：activity 是**截断**预览（describeActivity 无活动工具时 truncateLine，有工具时显示动作列表如 "reading 2 files…"），非完整流式正文——第三方扩展不暴露，属本方案天花板。

## File Structure

- 修改 `vscode/webview-ui/src/components/MessageView.tsx` — SubagentCard 内新增 `displayText` 派生（live → activity，否则 output），canExpand 与展开体改用 displayText。

---

### Task 1: SubagentCard 展开体数据源切换

**Files:**
- Modify: `vscode/webview-ui/src/components/MessageView.tsx`（SubagentCard 组件，约 :564-650）

**Interfaces:**
- Consumes: `card.status: "running" | "completed" | "error" | "background" | "stopped"`、`card.activity: string | null`、`output: string`（宿主 ToolCard.output，运行中为占位文本、完成后为完整结果）
- Produces: 展开体显示内容 `displayText: string`（live → activity ?? ""，否则 output）

- [ ] **Step 1: 修改 SubagentCard**

在 `const running = card.status === "running";` 之后插入 live 派生与 displayText，并替换 canExpand 与展开体：

```tsx
  const running = card.status === "running";
  // 运行中（含后台）的"当前输出" = details.activity 预览：扩展在运行期间只发
  // "N tool uses..." 占位 content（不流式子代理正文，进程内运行），activity 由
  // 宿主实时合并（含截断的实时响应文本或活动描述）；完成后 output = 完整结果
  const live = running || card.status === "background";
  const displayText = live ? (card.activity ?? "") : output;
```

原 `const canExpand = output.trim().length > 0;` 改为：

```tsx
  const canExpand = displayText.trim().length > 0;
```

展开体（`{open && output.trim() && (` 处）改为：

```tsx
      {open && displayText.trim() && (
        <div className="subagent-body msg-text">
          <Markdown content={displayText} />
        </div>
      )}
```

其余（stats 行、auto open/close effect、meta 行）一概不动。

- [ ] **Step 2: 类型检查 + 构建**

Run: `cd vscode && npm run check-types && node webview-ui/esbuild.js`
Expected: PASS；media/webview.js 构建成功。

- [ ] **Step 3: Commit**

```bash
git -C vscode add webview-ui/src/components/MessageView.tsx
git -C vscode commit -m "feat(subagent-card): 展开体运行中显示 activity 当前输出而非 tool uses 占位"
```

---

### Task 2: 端到端验证

**Files:**
- 无生产变更

**Interfaces:**
- Consumes: Task 1 产物
- Produces: 验证记录；F5 手动清单留用户

- [ ] **Step 1: 全门验证**

Run: `cd vscode && npm run compile && npm run package`
Expected: 全绿。

- [ ] **Step 2: F5 手动清单（人类步骤，记录在案）**

1. 主会话发起 subagent（foreground，description 可见）→ 运行中点击卡片展开：正文显示 `reading 2 files…` / 截断响应文本预览（随工具活动实时变化），**不再**显示 "N tool uses..."；统计行仍有 "N tool uses · N turns"。
2. 让子代理无工具活动（思考中）→ activity 显示截断的 responseText 预览。
3. 完成后：卡片自动收起；再点展开显示完整结果（"Agent completed in … " + 结果正文）。
4. `run_in_background: true` 的 subagent → 卡片自动展开显示 activity 预览（或降级不展开）；完成后收起。
5. activity 为空的运行瞬间 → 卡片不可展开（无占位出现）。
6. 浅色/深色主题各验一次；主会话其他工具卡（bash/read 等）行为不变。

- [ ] **Step 3: 无代码变更则跳过 commit**

---

## Self-Review

- **Spec coverage:** 需求 1/2/3/4 → Task 1 的 live/displayText 派生与两处替换；需求 3 回归由 Task 2 手动清单第 3 项覆盖。全覆盖。
- **Placeholder scan:** 无 TBD；步骤含确切代码。
- **Type consistency:** `displayText` 在 canExpand 与展开体两处一致；live 覆盖 running + background；activity 类型 `string | null` 用 `?? ""` 收窄；其余组件逻辑零改动。
- **风险记录:** activity 为截断预览（第三方扩展不暴露完整流式正文）——已在 Global Constraints 声明为本方案天花板，用户已确认采纳；background 路径若无 update 流则活动为 null → 降级不可展开（不显示占位，行为不劣化）。
