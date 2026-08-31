# 每轮清空 Todos（上一轮任务不残留）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一会话中每个新回合开始时清空 Todos 面板；运行中 todo 快照只显示**本回合**任务，上一轮任务不再回流。

**Architecture:** 根因与数据契约已实证（@juicesharp/rpiv-todo v2.8.0 源码 + 宿主既有注释）：
- todo 工具是**会话级持久 store**（按 session id 分区，存活 /reload 与 compaction），任务跨回合累积；
- 每次工具执行返回**全量快照** `details.tasks` + `details.nextId`（会话内单调递增）；
- `clear` action 重置 store（`tasks: [], nextId: 1`）——这是 id 过滤的坑。
宿主方案（不改扩展、不依赖 agent 行为）：每回合开始时捕获基线 `baseline = max(当前面板任务 id)` 并清空面板；本回合每个快照只显示 `id > baseline` 的任务（旧回合任务永不回流）；快照 `nextId <= baseline` 说明回合内发生 `clear`（计数器归 1）→ 基线归零（后续新任务正常显示）。

**Tech Stack:** TypeScript（宿主 controller + 纯函数模块 + node:test 单测）；app 侧（webview TodoPanel）零改动。零新依赖。

**Spec:** 本会话用户需求（无独立 spec，本 plan 即规范）。

## 需求明细

1. 每回合（用户发消息 = 新回合）开始时 Todos 面板清空；随后本回合开始使用 todo 工具。
2. 同会话中上一回合的任务不残留在面板（无论本回合是否调用 todo 工具、调用后快照是否含旧任务）。
3. 回合内 `todo clear` 后新建的任务（id 从 1 重新计数）正常显示。
4. 控制命令（`/pinel-*`，`input.control`）不触发清空——它们不是回合；steer（排队消息，同回合延续）不触发清空。
5. 会话切换 / 新建 / 重启仍从零开始（既有行为保持）——基线随之归零。
6. 完成状态（completed/deleted）仍按现状显示（本轮内更新的任务照常展示，过滤只按 id 归属回合）。

## Global Constraints

- **rpiv-todo v2.8.0 数据契约（本计划前提，源码实证）**：store 按 session id 分区、跨回合存活；每次执行返回全量 `details.tasks` + `details.nextId`（单调递增，`clear` 后归 1）；顶层 id 由 reducer 分配。
- 只改 `vscode/src/chat/todos.ts`、`vscode/src/chat/controller.ts`、`vscode/src/test/todos.test.ts`（+ 集成测试如可行）；webview / 插件零改动。
- 清空时机 = `sendPrompt` 的 else 分支（真实 prompt 发送），门控 `!input.control`；steer 分支（`status.isStreaming`）不清空。
- 既有 `this.todos = []` 重置点（restart `:643`、新会话/切换 `:1326`）一律连带 `this.todoBaseline = 0`。
- 零新依赖；中文注释；`npm run compile` / `npm test` 全绿（280 测试底线，见 vscode/AGENTS.md）。
- 已知天花板（挂账）：宿主不主动调用工具的 `clear` action（仅 agent 可调用）；本方案以「面板显示归属本回合的任务」为目标，**store 本身**不重置——若未来要求 store 级清空，需 agent 侧在回合开始调用 `todo clear`（或扩展改造），超出本仓库能力。

## File Structure

- 修改 `vscode/src/chat/todos.ts` — 新增纯函数 `parseTodoNextId`、`selectRoundTasks`、`resolveRoundBaseline`；`parseTodoTasks` 不动（既有契约与测试保留）。
- 修改 `vscode/src/test/todos.test.ts` — 纯函数用例。
- 修改 `vscode/src/chat/controller.ts` — `todoBaseline` 字段 + 三处接线（重置点、sendPrompt 回合清空、todo 快照过滤）。
- 修改（如可行）`vscode/src/test/extension.test.ts` + `vscode/src/test/fixtures/fake-pi.js` — 集成断言（回合清空 + 过滤）；若 fake-pi 无法驱动 sendPrompt 时序则以纯函数测试 + 手动清单为准（报告注明）。

---

### Task 1: todos.ts — 纯函数（nextId 解析 / 回合过滤 / 基线解析）

**Files:**
- Modify: `vscode/src/chat/todos.ts`

**Interfaces:**
- Consumes: `TodoTask`（既有）、`result` 形状 `{details: {tasks: TodoTask[], nextId: number}}`
- Produces:
  - `parseTodoNextId(result: unknown): number | null` — 防御解析 `details.nextId`（有限数字 ≥1 才返回，否则 null）
  - `selectRoundTasks(tasks: TodoTask[], baseline: number): TodoTask[]` — 只保留 `id > baseline`
  - `resolveRoundBaseline(prev: number, nextId: number | null): number` — `nextId !== null && nextId <= prev` → 0（回合内 clear 计数器归 1），否则原值

- [ ] **Step 1: 追加纯函数（文件末尾）**

```ts
/** 防御解析 details.nextId（会话内单调递增的任务计数器；clear 后归 1）。 */
export function parseTodoNextId(result: unknown): number | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const nextId = (details as Record<string, unknown>).nextId;
  return typeof nextId === "number" && Number.isFinite(nextId) && nextId >= 1 ? nextId : null;
}

/** 回合任务视图：只保留 id > 基线的新任务（上一回合任务即便在快照中也不回流）。 */
export function selectRoundTasks(tasks: TodoTask[], baseline: number): TodoTask[] {
  return tasks.filter((t) => t.id > baseline);
}

/**
 * 回合基线解析：快照 nextId ≤ 基线 ⇒ 会话内发生 clear（计数器归 1，
 * 后续新任务 id 从头计）⇒ 基线归零；否则保持（nextId 会话内单调）。
 */
export function resolveRoundBaseline(prev: number, nextId: number | null): number {
  return nextId !== null && nextId <= prev ? 0 : prev;
}
```

- [ ] **Step 2: 跑既有测试确认无回归**

Run: `cd vscode && npx tsc --noEmit`
Expected: PASS（纯追加，无签名变更）。

- [ ] **Step 3: Commit**

```bash
git -C vscode add src/chat/todos.ts
git -C vscode commit -m "feat(todos): 纯函数——nextId 解析/回合过滤/基线解析"
```

---

### Task 2: todos.test.ts — 纯函数用例

**Files:**
- Modify: `vscode/src/test/todos.test.ts`

**Interfaces:**
- Consumes: Task 1 的三个导出
- Produces: 覆盖「跨回合快照含旧任务 → 只显新任务」「clear 计数器归 1 → 基线归零」「缺 nextId → 基线保持」的断言

- [ ] **Step 1: 追加用例（文件末尾 suite）**

```ts
suite("parseTodoNextId / selectRoundTasks / resolveRoundBaseline", () => {
  test("nextId 防御解析：合法数字、缺字段、非法值", () => {
    const result = (nextId: unknown) => ({ details: { tasks: [], nextId } });
    assert.strictEqual(parseTodoNextId(result(3)), 3);
    assert.strictEqual(parseTodoNextId({ details: {} }), null);
    assert.strictEqual(parseTodoNextId({ details: { nextId: "x" } }), null);
    assert.strictEqual(parseTodoNextId({ details: { nextId: 0 } }), null);
    assert.strictEqual(parseTodoNextId(null), null);
  });

  test("回合过滤：只保留 id > 基线（旧任务不回显）", () => {
    const tasks = [
      { id: 1, subject: "旧一", status: "completed" as const },
      { id: 2, subject: "旧二", status: "completed" as const },
      { id: 3, subject: "旧三", status: "pending" as const },
      { id: 4, subject: "新一", status: "pending" as const },
    ];
    assert.deepStrictEqual(selectRoundTasks(tasks, 3), [
      { id: 4, subject: "新一", status: "pending" as const },
    ]);
    assert.deepStrictEqual(selectRoundTasks(tasks, 0), tasks);
  });

  test("基线解析：nextId ≤ 基线 → 归零（clear 计数器重置）；否则保持", () => {
    assert.strictEqual(resolveRoundBaseline(3, 5), 3, "单调递增保持");
    assert.strictEqual(resolveRoundBaseline(3, 1), 0, "clear 后归 1 → 基线归零");
    assert.strictEqual(resolveRoundBaseline(0, 1), 0, "首回合基线保持 0");
    assert.strictEqual(resolveRoundBaseline(3, null), 3, "nextId 缺失保持基线");
  });
});
```

- [ ] **Step 2: 跑单测**

Run: `cd vscode && npm test`
Expected: 新增 suite 3 用例通过；既有 280 测试全绿。

- [ ] **Step 3: Commit**

```bash
git -C vscode add src/test/todos.test.ts
git -C vscode commit -m "test(todos): nextId/回合过滤/基线解析纯函数用例"
```

---

### Task 3: controller.ts — 接线（字段 / 重置点 / 回合清空 / 快照过滤）

**Files:**
- Modify: `vscode/src/chat/controller.ts`
- Modify（如可行）: `vscode/src/test/fixtures/fake-pi.js`、`vscode/src/test/extension.test.ts`

**Interfaces:**
- Consumes: Task 1 三函数 + Task 2 契约
- Produces: `private todoBaseline: number`（初始 0）；时序：真实 prompt 发送（sendPrompt else 分支、`!input.control`）→ 捕获基线并清空面板；todo 快照 → 基线解析 + 过滤后广播

- [ ] **Step 1: import 与字段**

`controller.ts` 顶部 `import { parseTodoTasks, type TodoTask } from "./todos";` 改为：

```ts
import { parseTodoNextId, parseTodoTasks, selectRoundTasks, resolveRoundBaseline, type TodoTask } from "./todos";
```

`private todos: TodoTask[] = [];`（:309）旁加：

```ts
  /** 本回合起始任务 id 基线（回合清空时捕获；快照只显示 id > 基线的本回合任务）。 */
  private todoBaseline = 0;
```

- [ ] **Step 2: 既有重置点连带归零**

1. restart 区（`this.todos = [];` :643 附近）——同处加 `this.todoBaseline = 0;`。
2. 新会话/切换区（`this.todos = [];` :1326 附近）——同处加 `this.todoBaseline = 0;`。

- [ ] **Step 3: sendPrompt 回合清空**

`sendPrompt` 的 else 分支（`await this.client.send({ type: "prompt", ...` 之前）：

```ts
      } else {
        // 新回合开始（真实 prompt，非控制命令）：清空上一回合残留待办。
        // 基线 = 当前面板最大任务 id（清空前捕获）；本回合 todo 快照只显示
        // id > 基线的任务，旧回合任务即便在快照中也不回流
        if (!input.control) {
          this.todoBaseline = this.todos.reduce((m, t) => Math.max(m, t.id), 0);
          if (this.todos.length > 0) {
            this.todos = [];
            this.fire({ type: "todos", todos: [] });
          }
        }
        await this.client.send({
          type: "prompt",
          message: text,
          images,
          streamingBehavior: "steer",
        });
      }
```

- [ ] **Step 4: todo 快照过滤**

`case "tool_execution_end"` 的 todo 分支（`const tasks = parseTodoTasks(e.result); if (tasks) { this.todos = tasks; ...}` 处）替换为：

```ts
        if (e.toolName === "todo") {
          const tasks = parseTodoTasks(e.result);
          if (tasks) {
            this.todoBaseline = resolveRoundBaseline(this.todoBaseline, parseTodoNextId(e.result));
            this.todos = selectRoundTasks(tasks, this.todoBaseline);
            this.fire({ type: "todos", todos: this.todos });
          }
        }
```

（既有注释「todo 工具：解析全量任务快照并更新待办面板（未文档化字段，防御解析）」更新为含回合过滤语义的一句。）

- [ ] **Step 5: 类型检查 + 既有集成测试**

Run: `cd vscode && npm run check-types && npm test`
Expected: 全绿（fake-pi 集成测试不驱动 sendPrompt 时序，此步验证无回归）。

- [ ] **Step 6: 集成断言（如可行）**

查看 `src/test/extension.test.ts` 与 fake-pi 时序约定：若测试 API 能在两次「回合」间驱动 tool_execution_end 快照并走一遍 sendPrompt（如存在现成的发送/回合驱动 helper），追加断言：回合 1 快照 [id1,id2] → 面板 [1,2]；模拟回合 2 发送 → 面板空；回合 2 快照 [1,2,3] → 面板仅 [3]。若 harness 无法驱动 sendPrompt 时序，报告注明并以 Task 2 纯函数用例 + Task 4 手动清单为准（不要造新 harness）。

- [ ] **Step 7: Commit**

```bash
git -C vscode add src/chat/controller.ts src/test/fixtures/fake-pi.js src/test/extension.test.ts
git -C vscode commit -m "feat(controller): 每回合清空 Todos 并按 id 基线过滤快照，上一轮任务不回流"
```

---

### Task 4: 端到端验证

**Files:**
- 无生产变更

**Interfaces:**
- Consumes: Task 1-3 全部
- Produces: 验证记录；F5 手动清单留用户

- [ ] **Step 1: 全门**

Run: `cd vscode && npm run compile && npm run package && npm test`
Expected: 全绿。

- [ ] **Step 2: 真实会话复核（自动记录）**

用 `pi --mode rpc`（或 F5 面板）在真实会话验证 store 语义：回合 1 建 task A；回合 2 不调用 todo → 面板空（核心修复）；回合 2 调用 todo 建 task B → 面板仅 B（旧任务不回流）。记录实际结果写入报告。

- [ ] **Step 3: F5 手动清单（人类步骤，记录在案）**

1. 回合 1：让 agent 创建多个任务 → 面板显示。
2. 回合 2 发普通消息（不提 todo）→ 面板立即清空，不再显示回合 1 任务。
3. 回合 2 让 agent 新建任务 → 面板只显示本回合新任务。
4. 回合内 agent 更新回合 1 的任务（id 小）→ 不回显。
5. 回合内 agent 调用 `todo clear` 再新建 → 新任务正常显示（基线归零）。
6. 控制命令（/pinel-state 类）与 steer 排队 → 面板不清空。
7. 新建/切换会话 → 面板与基线均从零开始。

---

## Self-Review

- **Spec coverage:** 需求 1 → Task 3 Step 3；需求 2 → Task 3 Step 4（过滤）；需求 3 → resolveRoundBaseline（Task 1）+ Task 4 手动清单 5；需求 4 → `!input.control` 门控 + steer 分支不动；需求 5 → Task 3 Step 2；需求 6 → 过滤仅按 id，状态展示逻辑不动。全覆盖。
- **Placeholder scan:** 无 TBD；步骤含确切代码/命令。
- **Type consistency:** `todoBaseline` 三处一致（字段/重置/sendPrompt/快照）；`resolveRoundBaseline(prev, nextId|null)`、`selectRoundTasks(tasks, baseline)` 签名在 Task 1/2/3 一致；`parseTodoNextId` 与快照 `details.nextId` 形状匹配（rpiv-todo response-envelope.ts 实证）。
- **风险记录:** 已知天花板——store 级清空需 agent 调用 `todo clear`（宿主无法调工具）；id 基线过滤依赖 rpiv-todo 的 nextId 单调性（源码实证）；如扩展未来改变快照契约（无 nextId / 非全量），解析防御降级（nextId null → 基线保持，过滤仍按 id 工作，仅 clear 重置场景退化）。
