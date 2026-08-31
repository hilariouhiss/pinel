# 删除 pinel.state/pinel.tree 死推送链 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两端（`pi/` 插件与 `vscode/` 宿主）整体删除已无消费端的 pinel.state/pinel.tree 推送管线：pi 每消息 O(n) 快照+树构建、stdout 帧、宿主防御解析/缓存/广播、webview 空转 case 全部移除。

**Architecture:** pi 插件 `pinel.ts` 退化为纯接线——保留会话事件循环（写 ctx 槽位 + 补发 MCP 状态，`pinel-workflows`/`mcp-status` 仍依赖），删除 PushScheduler/snapshot 构建与 `/pinel-state`、`/pinel-tree` 两条命令；vscode 宿主删除对应 parser、缓存、广播与类型，webview 删除空转 case；测试/冒烟改为断言仍然存活的帧（ponytail/mcp/pinel.mcp/pinel.workflow/pinel.prompt）。保留的推送契约 v:1 形状零变化。

**Tech Stack:** TypeScript（pi 包与 vscode 扩展既有约定）、vitest（pi 测试）、vscode-test（集成测试）、esbuild/tsc（宿主构建）、真实 pi 冒烟（`npm run smoke:plugin`，opt-in）。

**Spec:** 本会话用户需求（逐字）："编写计划，修复第一个问题，两端删掉。"——第一个问题 = 会话内审计报告第 1 项：`pinel.state`/`pinel.tree` 推送链已无消费端（webview `App.tsx` 两 case 明确不渲染；消息计数由 ponytail 状态 + `get_state` 替代，会话树弹层已移除），pi 端每个内容事件仍全量遍历计数 + 构建整树 + JSON 序列化出帧，宿主解析广播后 webview 丢弃，存续理由仅剩测试钩子。

## Global Constraints

- 两个独立 git 仓库：`c:/source_code/Other/pinel/pi` 与 `c:/source_code/Other/pinel/vscode`（root 非仓库）。两仓各自提交；命令一律用 `git -C <绝对路径>`。
- 纯删除，不新增任何 npm 依赖、不新增文件（除本计划）。
- 保留的推送契约 **v:1 形状零变化**：`pinel.prompt`、`pinel.mcp`、`pinel.workflow`/`pinel.workflows`（webview ContextBar/WorkflowBar/MCP chip 仍在消费，不得误删）。
- `pi/extensions/push-target.ts` **保留不动**：`pinel-workflows.ts` 与 `mcp-status.ts` 的生命周期推送/补发依赖 `getPinelCtx`，其测试（`mcp-status.test.ts`）直接 import `setPinelCtx`。
- 会话事件循环必须保留（10 个事件，pi 0.84.x 实测全部存在）：写 ctx 槽位 + `flushMcpStatus()` 是 `pinel.workflow`/`pinel.mcp` 推送的前置条件。
- pi 仓库约定：相对导入写 `.js` 后缀；测试与注释中文；Conventional Commits（pi 历史风格 `refactor(pi-pinel):`）。
- vscode 仓库约定：Conventional Commits（历史风格 `refactor(host):` / `refactor(webview):` / `test:` / `docs(smoke):`）；测试与注释中文。
- 历史计划文档（两仓 `docs/superpowers/plans/` 既有文件）一律不改。
- 验证命令固定：pi 侧 `cd c:/source_code/Other/pinel/pi && npx vitest run`；vscode 侧 `cd c:/source_code/Other/pinel/vscode && npm run check-types && npm run check-plugin`（tsc 跟随检查 `../pi/pinel.ts`，两仓同步改才能绿）、`npm run check:pinel-payload`、`npm run lint`、`npm test`（vscode-test 集成，Windows 下会下载 VS Code）、`npm run smoke:plugin`（需真实 pi 在 PATH）。

## File Structure

| 文件 | 职责 |
|------|------|
| `pi/extensions/snapshot.ts`（删除） | buildSnapshot/buildTree/countRoles/extractText——唯一消费方是 push.ts |
| `pi/extensions/push.ts`（删除） | PushScheduler + 事件常量——唯一消费方是 pinel.ts |
| `pi/extensions/snapshot.test.ts` / `push.test.ts`（删除） | 上述两模块的测试 |
| `pi/pinel.ts`（改写） | 删除调度器与两条命令；保留事件循环（setPinelCtx + flushMcpStatus）+ 采集器注册 |
| `vscode/src/chat/pinel-payload.ts`（修改） | 删 PinelStatePayload/PinelTreePayload 类型与 parsePinelState/parsePinelTree |
| `vscode/src/chat/controller.ts`（修改） | 删导入、缓存字段、handlePinelStatus/handlePinelWidget 死分支、OutMessage 成员、fireSnapshot 成员、两个测试钩子 |
| `vscode/src/extension.ts`（修改） | 删 PinelTestApi 两个声明与返回对象两个条目 |
| `vscode/webview-ui/src/types.ts`（修改） | 删 PinelTreeNode/PinelTree/PinelState、snapshot 成员、两个 HostMessage 变体 |
| `vscode/webview-ui/src/App.tsx`（修改） | 删 "pinelState"/"pinelTree" 两个空转 case |
| `vscode/src/test/pinel-payload.test.ts`（修改） | 删两个 describe + import 两个名字 |
| `vscode/src/test/extension.test.ts`（修改） | PINELUI 测试删 state/tree 断言，保留 ponytail/mcp/pinel.mcp/workflow |
| `vscode/src/test/fixtures/fake-pi.js`（修改） | 删 pinel-state-1/pinel-widget-1/bad-status-1 三帧 |
| `vscode/scripts/pinel-plugin-smoke.mjs`（修改） | 断言改为 pinel.prompt 启动帧 + pinel.mcp 基线帧 |
| `vscode/AGENTS.md`（修改） | 会话树导航行更新为「已整体删除」 |

---

### Task 1: pi 插件——删除构建/调度模块并改写 pinel.ts

**Files:**
- Delete: `pi/extensions/snapshot.ts`、`pi/extensions/push.ts`、`pi/extensions/snapshot.test.ts`、`pi/extensions/push.test.ts`
- Modify: `pi/pinel.ts`（全文替换）

**Interfaces:**
- Consumes: `push-target.ts` 的 `setPinelCtx`（保留模块，签名不变）；`prompt-composition.ts` 的 `registerPromptComposition`；`mcp-status.ts` 的 `registerMcpStatus`/`flushMcpStatus`。
- Produces: `SESSION_EVENTS`（10 个事件名数组，仅本文件内使用）；插件不再注册任何命令（get_commands 无 pinel 条目）；不再推送 pinel.state/pinel.tree 帧。

- [ ] **Step 1: 基线验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（push/snapshot/mcp-status/prompt-composition 等现有测试全部通过）。

- [ ] **Step 2: 删除四个文件**

Run: `git -C c:/source_code/Other/pinel/pi rm extensions/push.ts extensions/push.test.ts extensions/snapshot.ts extensions/snapshot.test.ts`

- [ ] **Step 3: 改写 pinel.ts（全文替换）**

`pi/pinel.ts` 全文替换为：

```typescript
/**
 * Pinel Pi 插件 — Pinel VS Code 面板与 pi 会话的桥。
 *
 * 仅在被 Pinel 扩展 spawn 的 pi（--mode rpc + PINEL_PLUGIN=1）内激活，
 * 其余场景（TUI 等）完全惰性：工厂直接 return，不注册任何东西。
 *
 * 通道（复用 stdio JSONL RPC，无新增传输层）：
 * - 推送（插件 → 面板）：各采集器经 ctx.ui.setStatus 推 JSON 帧
 *   （pinel.prompt 提示词组成 / pinel.mcp MCP 服务器状态 /
 *   pinel.workflow(s) 工作流生命周期状态），pi 以 extension_ui_request
 *   帧出 stdout，宿主转发 webview 渲染。
 * - 会话状态（模型/思考等级/消息计数/会话文件）：面板经原生 RPC
 *   get_state / get_session_stats 权威兑底，插件不重复推送（防双源漂移）；
 *   compact/fork/rename/switch 同为原生 RPC 命令。
 *
 * 本入口职责：守卫 env、注册会话事件（写入 ctx 槽位供工作流/MCP
 * 采集器复用 + 补发 MCP 基线/最新快照）、注册采集器。
 */
import { setPinelCtx } from "./extensions/push-target.js";
import { registerPromptComposition } from "./extensions/prompt-composition.js";
import { flushMcpStatus, registerMcpStatus } from "./extensions/mcp-status.js";

/** 会话事件（10 个，pi 0.84.x 实际 emit）：写入 ctx 槽位 + 补发 MCP 状态。 */
const SESSION_EVENTS = [
  "session_start",
  "agent_settled",
  "turn_end",
  "message_end",
  "session_compact",
  "session_compact_failed",
  "model_select",
  "thinking_level_select",
  "thinking_level_changed",
  "session_info_changed",
] as const;

export default function (pi: any) {
  if (process.env.PINEL_PLUGIN !== "1") {
    return; // 非 Pinel 面板会话：完全惰性
  }

  // 提示词组成采集（pinel.prompt 推送；首轮 before_agent_start 后的 agent_start 首发帧）
  registerPromptComposition(pi);

  // MCP 服务器状态采集（pinel.mcp 推送；适配器快照事件 + 配置基线）
  registerMcpStatus(pi);

  for (const name of SESSION_EVENTS) {
    pi.on(name, (_ev: any, ctx: any) => {
      if (ctx?.mode !== "rpc") return;
      setPinelCtx(ctx); // 供 pinel-workflows 生命周期推送与 MCP 补发复用
      flushMcpStatus(); // ctx 可用即补发 MCP 基线/最新快照
    });
  }
}
```

- [ ] **Step 4: 验证测试与类型**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（push/snapshot 测试已随文件删除；mcp-status/prompt-composition/collectors/contracts/pinel-workflows/plugin-usage-guide/auto-commit 测试不受影响）。

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-plugin`
Expected: 零错误（tsc 跟随 pinel.ts import 检查，push.ts/snapshot.ts 删除后 import 图收缩）。

- [ ] **Step 5: 提交（pi 仓库）**

```bash
git -C c:/source_code/Other/pinel/pi add -A
git -C c:/source_code/Other/pinel/pi commit -m "refactor(pi-pinel): drop dead pinel.state/tree push pipeline"
```

---

### Task 2: vscode 宿主——删除解析器与管线

**Files:**
- Modify: `vscode/src/chat/pinel-payload.ts`
- Modify: `vscode/src/chat/controller.ts`

**Interfaces:**
- Consumes: Task 1 的删除结果（pi 不再发 pinel.state/pinel.tree 帧；宿主对未知 statusKey/widgetKey 默认忽略，删除分支后帧自然被吞）。
- Produces: `pinel-payload.ts` 保留 `parsePinelWorkflow`、`parsePonytailStatus`、`parseMcpStatus`、`parsePinelMcp`、`parsePinelPrompt` 与内部 `parseJsonObject/toCount/stripAnsi`（其他解析器共用）；`controller.ts` 不再导出 `getPinelStateCache/getPinelTreeCache`。

- [ ] **Step 1: pinel-payload.ts 删除两类型两函数**

`vscode/src/chat/pinel-payload.ts`：
- 头部注释第三行 `payload 契约见 ../pi/pinel.ts` 改为 `payload 契约见各采集器头注释（pi/extensions/prompt-composition.ts、mcp-status.ts、pinel-workflows.ts，v:1）`。
- 删除整段（接口 + 函数，含注释，共 ~95 行）：

```typescript
/** pinel.state 快照（setStatus statusText 解析产物）。 */
export interface PinelStatePayload {
  v: 1;
  messages: { user: number; assistant: number; toolResult: number; total: number };
  model?: string;
  thinkingLevel?: string;
  leafId?: string;
  sessionFile?: string;
}

/** pinel.tree 节点（当前分支链消息；树导航目标）。 */
export interface PinelTreeNode {
  entryId: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

/** pinel.tree 载荷（setWidget widgetLines[0] 解析产物）。 */
export interface PinelTreePayload {
  v: 1;
  nodes: PinelTreeNode[];
  leafId?: string;
}

/** 防御解析 pinel.state JSON 字符串。 */
export function parsePinelState(text: unknown): PinelStatePayload | null {
  const raw = parseJsonObject(text);
  if (!raw || raw.v !== 1) {
    return null;
  }
  const messagesRaw = raw.messages;
  if (typeof messagesRaw !== "object" || messagesRaw === null) {
    return null;
  }
  const m = messagesRaw as Record<string, unknown>;
  const messages = {
    user: toCount(m.user),
    assistant: toCount(m.assistant),
    toolResult: toCount(m.toolResult),
    total: toCount(m.total),
  };
  const payload: PinelStatePayload = { v: 1, messages };
  const model = raw.model;
  if (typeof model === "string" && model.length > 0) {
    payload.model = model;
  }
  const thinkingLevel = raw.thinkingLevel;
  if (typeof thinkingLevel === "string") {
    payload.thinkingLevel = thinkingLevel;
  }
  const leafId = raw.leafId;
  if (typeof leafId === "string") {
    payload.leafId = leafId;
  }
  const sessionFile = raw.sessionFile;
  if (typeof sessionFile === "string") {
    payload.sessionFile = sessionFile;
  }
  return payload;
}

/** 防御解析 pinel.tree JSON 字符串（widgetLines 首元素）。 */
export function parsePinelTree(lines: unknown): PinelTreePayload | null {
  const raw = parseJsonObject(Array.isArray(lines) ? lines[0] : lines);
  if (!raw || raw.v !== 1) {
    return null;
  }
  const nodes: PinelTreeNode[] = [];
  if (Array.isArray(raw.nodes)) {
    for (const item of raw.nodes) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const n = item as Record<string, unknown>;
      const entryId = n.entryId;
      const role = n.role;
      const text = n.text;
      if (typeof entryId !== "string" || entryId.length === 0) {
        continue;
      }
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      if (typeof text !== "string" || text.length === 0) {
        continue;
      }
      const node: PinelTreeNode = { entryId, role, text };
      if (typeof n.timestamp === "number" && Number.isFinite(n.timestamp)) {
        node.timestamp = n.timestamp;
      }
      nodes.push(node);
    }
  }
  const payload: PinelTreePayload = { v: 1, nodes };
  if (typeof raw.leafId === "string") {
    payload.leafId = raw.leafId;
  }
  return payload;
}
```

注意：`parseJsonObject`、`toCount`、`stripAnsi` 三个内部函数**必须保留**（pinel.prompt/pinel.mcp/ponytail/mcp 解析器仍在用）。

- [ ] **Step 2: controller.ts 删除导入**

`vscode/src/chat/controller.ts` 第 45 行 import 改为：

```typescript
import { parseMcpStatus, parsePinelMcp, parsePinelPrompt, parsePinelWorkflow, parsePonytailStatus, type McpStatus, type PinelMcpPayload, type PinelPromptPayload, type PinelWorkflowPayload, type PonytailStatus } from "./pinel-payload";
```

- [ ] **Step 3: controller.ts 删除 OutMessage 成员与缓存字段**

- snapshot 变体（第 138 行）删除 ` pinelState: PinelStatePayload | null; pinelTree: PinelTreePayload | null;` 两个成员。
- OutMessage 联合（第 165-166 行）删除两个变体：

```typescript
  | { type: "pinelState"; state: PinelStatePayload }
  | { type: "pinelTree"; tree: PinelTreePayload }
```

- 字段声明（第 328-329 行）删除：

```typescript
  /** Pinel 插件推送缓存（webview 重建后经 snapshot 重放）。 */
  private pinelStateCache: PinelStatePayload | null = null;
  private pinelTreeCache: PinelTreePayload | null = null;
```

（注意：`pinelPromptCache`、`pinelWorkflowCache`、`ponytailStatusCache`、`mcpStatusCache`、`pinelMcpCache` **保留**——对应帧仍在消费。）

- [ ] **Step 4: controller.ts 删除两个处理分支**

`handlePinelStatus` 删除 `pinel.state` 分支（第 1804-1811 行）：

```typescript
    if (req.statusKey === "pinel.state") {
      const parsed = parsePinelState(req.statusText);
      if (!parsed) {
        return; // 解析失败：静默丢弃（插件版本漂移容缺）
      }
      this.pinelStateCache = parsed;
      this.fire({ type: "pinelState", state: parsed });
      return;
    }
```

（方法其余分支 `pinel.prompt`/`pinel.workflow`/`ponytail`/`mcp`/`pinel.mcp` 不动；方法头注释「白名单 statusKey 帧（pinel.*、ponytail、mcp）」仍准确。）

`handlePinelWidget` 删除 `pinel.tree` 分支，仅保留 `pinel.workflows`：

```typescript
  /** pinel.* setWidget 帧：同 setStatus 处理路径。 */
  private handlePinelWidget(req: ExtensionUiRequest): void {
    if (req.widgetKey === "pinel.workflows") {
      const parsed = parsePinelWorkflow(req.widgetLines?.[0]);
      if (!parsed) {
        return; // 空列表（工作流结束清空）不覆盖 status 权威状态
      }
      this.pinelWorkflowCache = parsed;
      this.fire({ type: "pinelWorkflow", workflow: parsed });
    }
  }
```

- [ ] **Step 5: controller.ts 删除 fireSnapshot 成员与测试钩子**

- `fireSnapshot`（第 2824-2825 行）删除 `pinelState: this.pinelStateCache,` 与 `pinelTree: this.pinelTreeCache,` 两行。
- 删除两个 getter（第 2907-2915 行）：

```typescript
  /** 最近一次 pinel.state 推送缓存（集成测试断言）。 */
  getPinelStateCache(): PinelStatePayload | null {
    return this.pinelStateCache;
  }

  /** 最近一次 pinel.tree 推送缓存（集成测试断言）。 */
  getPinelTreeCache(): PinelTreePayload | null {
    return this.pinelTreeCache;
  }
```

- [ ] **Step 6: 验证类型与自检**

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-types && npm run check-plugin && npm run check:pinel-payload && npm run lint`
Expected: 零错误（check-types 会报 extension.ts/webview 未同步，属预期——Task 3 立即修；若本步骤就要绿，可先做 Task 3 再一起验证。顺序执行时按计划走，Task 3 完成后统一验证。）

- [ ] **Step 7: 提交（vscode 仓库）**

```bash
git -C c:/source_code/Other/pinel/vscode add src/chat/pinel-payload.ts src/chat/controller.ts
git -C c:/source_code/Other/pinel/vscode commit -m "refactor(host): remove pinel.state/tree parse and cache pipeline"
```

---

### Task 3: vscode 宿主接口 + webview 类型与死 case

**Files:**
- Modify: `vscode/src/extension.ts`
- Modify: `vscode/webview-ui/src/types.ts`
- Modify: `vscode/webview-ui/src/App.tsx`

**Interfaces:**
- Consumes: Task 2 的删除结果（`controller.ts` 不再有 `getPinelStateCache/getPinelTreeCache` 与 `pinelState/pinelTree` 消息）。
- Produces: `PinelTestApi` 无 pinel 帧缓存钩子；`HostMessage` 无 `pinelState/pinelTree` 变体；App.tsx 无对应 case。

- [ ] **Step 1: extension.ts 删三个位置**

- 第 12 行 import 删 `PinelStatePayload, PinelTreePayload,` 两个名字：

```typescript
import type { McpStatus, PinelMcpPayload, PinelPromptPayload, PinelWorkflowPayload, PonytailStatus } from "./chat/pinel-payload";
```

- `PinelTestApi`（第 107-110 行）删除两个声明：

```typescript
  /** 最近一次 pinel.state 推送缓存（null=未收到）。 */
  getPinelStateCache(): PinelStatePayload | null;
  /** 最近一次 pinel.tree 推送缓存（null=未收到）。 */
  getPinelTreeCache(): PinelTreePayload | null;
```

- 返回对象（第 292-293 行）删除两个条目：

```typescript
    getPinelStateCache: () => ctrl.getPinelStateCache(),
    getPinelTreeCache: () => ctrl.getPinelTreeCache(),
```

- [ ] **Step 2: webview types.ts 删类型与消息变体**

`vscode/webview-ui/src/types.ts`：

- 删除 `PinelTreeNode` + `PinelTree` 两个接口（第 247-260 行，含上方注释行 `/** pinel.tree 载荷（插件推送 → 宿主 pinel-payload 解析 → 广播）。 */`）。
- 删除 `PinelState` 接口（第 295-304 行，含注释行 `/** pinel.state 快照（插件推送 → 宿主防御解析 → 广播）。 */`）。
- snapshot 变体删除 ` pinelState: PinelState | null; pinelTree: PinelTree | null;` 两个成员。
- `HostMessage` 删除两个变体：

```typescript
  | { type: "pinelState"; state: PinelState }
  | { type: "pinelTree"; tree: PinelTree }
```

- [ ] **Step 3: App.tsx 删两个空转 case**

`vscode/webview-ui/src/App.tsx` 的 `handleMessage` switch 中删除：

```typescript
      case "pinelState":
        // 消息计数指标已被 ponytail 状态替代，帧不再渲染；宿主管线/测试钩子保留
        break;
```

与：

```typescript
      case "pinelTree":
        // 会话树弹层已移除（双击 Esc 入口废除，与 Fork 弹层功能重叠）；
        // 帧不再消费——宿主 pinel.tree 推送管线保留（插件集成面 + 测试钩子）
        break;
```

（其余 case 不动；`pinelWorkflow`/`pinelPrompt`/`pinelMcp`/`ponytailStatus` 仍在消费。）

- [ ] **Step 4: 验证类型**

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-types`
Expected: 零错误（宿主 + webview 两套 tsc 全绿；`npm run check-plugin` 与 `npm run lint` 也应绿——本任务只动类型层，无 lint 影响，Task 4 前再跑一次全量）。

- [ ] **Step 5: 提交**

```bash
git -C c:/source_code/Other/pinel/vscode add src/extension.ts webview-ui/src/types.ts webview-ui/src/App.tsx
git -C c:/source_code/Other/pinel/vscode commit -m "refactor(webview): drop dead pinelState/pinelTree message types"
```

---

### Task 4: vscode 测试清理（单测 + 集成测试 + 假 pi）

**Files:**
- Modify: `vscode/src/test/pinel-payload.test.ts`
- Modify: `vscode/src/test/extension.test.ts`
- Modify: `vscode/src/test/fixtures/fake-pi.js`

**Interfaces:**
- Consumes: Task 2/3 删除后的真实实现（测试必须与实现同步删除，否则 compile-tests 红）。
- Produces: 测试套件不再引用已删除的 parser/缓存钩子/帧。

- [ ] **Step 1: pinel-payload.test.ts 删 import 与两个 describe**

- 第 3 行 import 改为：

```typescript
import { parsePinelWorkflow, parsePonytailStatus, parseMcpStatus, parsePinelMcp, parsePinelPrompt } from "../chat/pinel-payload";
```

- 删除 `describe("parsePinelState", ...)` 与 `describe("parsePinelTree", ...)` 两个整块（从 `describe("parsePinelState", () => {` 起到 `describe("parsePinelWorkflow", () => {` 之前，第 6-95 行）。`parsePinelWorkflow` 及其后全部保留。

- [ ] **Step 2: extension.test.ts 改写 PINELUI 测试**

`vscode/src/test/extension.test.ts` 的 `test("pinel 插件 setStatus/setWidget 帧：白名单过滤 + 防御解析 + 缓存", ...)`：

- 第 368 行注释改为：`// PINELUI：假 pi 依次发 ponytail 坏/好帧 → mcp 好/坏帧 → pinel.mcp 好/坏帧 → 工作流 status/widget/空/坏帧`
- 删除以下整段：

```typescript
    const state = api.getPinelStateCache();
    assert.ok(state, "pinel.state 必须被解析并缓存");
    assert.deepStrictEqual(state.messages, { user: 2, assistant: 3, toolResult: 1, total: 6 });
    assert.strictEqual(state.model, "deepseek/deepseek-v4-pro");
    assert.strictEqual(state.thinkingLevel, "max");

    const tree = api.getPinelTreeCache();
    assert.ok(tree, "pinel.tree 必须被解析并缓存");
    assert.strictEqual(tree.leafId, "e2");
    assert.strictEqual(tree.nodes.length, 2);
    assert.strictEqual(tree.nodes[0].entryId, "e1");

    // 干扰帧（非 pinel statusKey）与坏 JSON 帧均不得污染缓存（好值保留）
    assert.strictEqual(state.messages.total, 6, "坏 JSON 帧不得覆盖好缓存");
```

- 保留并原样不动：ponytail 断言（ANSI 解析）、mcp 断言（好帧 2/2 + 坏帧不污染）、pinel.mcp 断言（3 服务器明细）、工作流断言（widget 覆盖 status、空 widget/坏 JSON 不覆盖）、restart 后 mcp/pinel.mcp 缓存清空断言。
- 测试名与 PINELUI 标记机制不动（假 pi 的 PINELUI 分支仍发其余帧）。

- [ ] **Step 3: fake-pi.js 删三帧**

`vscode/src/test/fixtures/fake-pi.js` PINELUI 分支：

- 注释行 `// 模拟 Pinel 插件推送：setStatus/setWidget 帧（含 ponytail 状态帧、\n// ponytail 坏帧与 pinel.state 坏 JSON 干扰）` 改为 `// 模拟 Pinel 插件推送：ponytail/mcp/pinel.mcp/工作流 帧（含坏帧干扰）`。
- 删除 `pinel-status-1`（setStatus statusKey "pinel.state" 好帧）、`pinel-widget-1`（setWidget widgetKey "pinel.tree"）、`bad-status-1`（statusKey "pinel.state" statusText "not-json"）三个 `out({...})` 块。
- 其余帧（ponytail "loaded" 坏帧 + ANSI 好帧、mcp 好帧 + "garbage" 坏帧、pinel.mcp 好帧 + 坏帧、工作流 status/widget/空 widget/坏 JSON）全部保留。

- [ ] **Step 4: 验证**

Run: `cd c:/source_code/Other/pinel/vscode && npm run compile-tests`
Expected: 零错误（测试代码不再引用已删除符号）。

Run: `cd c:/source_code/Other/pinel/vscode && npm test`
Expected: 全绿（集成测试跑真 VS Code + 假 pi；PINELUI 测试断言 ponytail/mcp/pinel.mcp/workflow 缓存正确、restart 清空 mcp 缓存）。

- [ ] **Step 5: 提交**

```bash
git -C c:/source_code/Other/pinel/vscode add src/test/pinel-payload.test.ts src/test/extension.test.ts src/test/fixtures/fake-pi.js
git -C c:/source_code/Other/pinel/vscode commit -m "test: drop pinel.state/tree coverage, keep ponytail/mcp/workflow assertions"
```

---

### Task 5: 冒烟脚本 + AGENTS.md 文档对齐

**Files:**
- Modify: `vscode/scripts/pinel-plugin-smoke.mjs`
- Modify: `vscode/AGENTS.md`

**Interfaces:**
- Consumes: Task 1 的插件新行为（加载即推 pinel.prompt 启动帧与 pinel.mcp 基线帧；零命令注册）。
- Produces: 冒烟断言插件加载 + 帧通道 + 两个采集器存活。

- [ ] **Step 1: 改写冒烟脚本**

`vscode/scripts/pinel-plugin-smoke.mjs` 三处：

- 头部注释第 3-5 行改为：

```javascript
 * 3. session_start 后断言 pinel.prompt 启动帧与 pinel.mcp 基线帧
 *    （插件加载 + 帧通道 + 两个采集器存活；pinel.state/tree 推送链已整体删除）
 * 4. 清理临时目录与子进程
```

- 第 3 步断言段（`// 3. session_start 推送断言...` 到 `if (treeFrames.length === 0) fail(...)` 为止）替换为：

```javascript
  // 3. session_start 后断言采集器帧（插件被自动加载且帧通道正常）
  const seen = frames();
  const promptFrames = seen.filter(
    (f) => f.type === "extension_ui_request" && f.method === "setStatus" && f.statusKey === "pinel.prompt",
  );
  const mcpFrames = seen.filter(
    (f) => f.type === "extension_ui_request" && f.method === "setStatus" && f.statusKey === "pinel.mcp",
  );
  if (promptFrames.length === 0) fail("未收到 pinel.prompt 启动帧（插件未加载或通道失效）");
  if (mcpFrames.length === 0) fail("未收到 pinel.mcp 基线帧（MCP 采集器失效）");
```

- 删除原第 4 步整段（`// 4. get_commands 断言 + /pinel-state 命令派发` 到 `if (!notify) fail(...)` 为止），并删除 `const send = ...` 定义（不再使用）。
- 末尾 log 改为：

```javascript
  console.log("SMOKE OK: 插件加载 / pinel.prompt 启动帧 / pinel.mcp 基线帧全部通过");
```

- [ ] **Step 2: AGENTS.md 会话树导航行更新**

`vscode/AGENTS.md` 第 88 行「会话树导航/压缩」行改为：

```
| 会话树导航/压缩 | 树弹层与双击 Esc 入口已移除（与 Fork 弹层功能重叠），插件 /pinel-tree 命令与 pinel.state/pinel.tree 推送链已整体删除；compact 原生 RPC（protocol CompactCommand + controller.compact + 设置面板 Compact now）；阈值 setCompactionThreshold（百分比↔reserveTokens 写全局 settings.json + status.autoCompactPercent 回显） |
```

- [ ] **Step 3: 冒烟验证**

Run: `cd c:/source_code/Other/pinel/vscode && npm run smoke:plugin`
Expected: `SMOKE OK: 插件加载 / pinel.prompt 启动帧 / pinel.mcp 基线帧全部通过`（真实 pi 加载瘦身后插件；无 pinel.state/tree 断言）。

- [ ] **Step 4: 提交**

```bash
git -C c:/source_code/Other/pinel/vscode add scripts/pinel-plugin-smoke.mjs AGENTS.md
git -C c:/source_code/Other/pinel/vscode commit -m "docs(smoke): assert pinel.prompt/pinel.mcp frames after state/tree removal"
```

---

### Task 6: 全量回归与残留扫描

**Files:** 无新文件。

- [ ] **Step 1: 两仓全量验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿。

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-types && npm run check-plugin && npm run check:pinel-payload && npm run lint`
Expected: 零错误。

Run: `cd c:/source_code/Other/pinel/vscode && npm test`
Expected: 全绿。

- [ ] **Step 2: 残留扫描（必须零输出）**

Run:

```
grep -rn "pinel\.state\|pinel\.tree\|PinelState\|PinelTree\|PinelTreeNode\|parsePinelState\|parsePinelTree\|getPinelStateCache\|getPinelTreeCache\|PushScheduler\|buildSnapshot\|buildTree\|pinel-state\|pinel-tree" c:/source_code/Other/pinel/pi --include="*.ts" --exclude-dir=node_modules --exclude-dir=docs
grep -rn "pinel\.state\|pinel\.tree\|PinelState\|PinelTree\|PinelTreeNode\|parsePinelState\|parsePinelTree\|getPinelStateCache\|getPinelTreeCache\|pinel-state\|pinel-tree" c:/source_code/Other/pinel/vscode/src c:/source_code/Other/pinel/vscode/webview-ui/src c:/source_code/Other/pinel/vscode/scripts c:/source_code/Other/pinel/vscode/AGENTS.md
```

Expected: 两条均无输出（`docs/superpowers/plans/` 历史计划属豁免区，第一个 grep 已排除）。

- [ ] **Step 3: 两仓状态检查**

Run: `git -C c:/source_code/Other/pinel/pi status --short && git -C c:/source_code/Other/pinel/vscode status --short`
Expected: 两仓均干净（本计划文件已在 vscode 仓提交）。

---

## Self-Review

- **Spec coverage:** 审计报告第 1 项（两端死管线删除）→ Task 1（pi 生产者：push/snapshot 模块、调度器、两条命令、事件循环保留）+ Task 2/3（宿主 parser/缓存/广播/类型 + webview 死 case）+ Task 4（测试同步）+ Task 5（冒烟/文档同步）+ Task 6（全量回归 + 残留扫描）。保留契约（pinel.prompt/pinel.mcp/pinel.workflow）在 Task 2 的「保留清单」与 Task 4/5 的断言改写中显式覆盖，防误删。
- **Placeholder scan:** 无 TBD/TODO；所有代码块完整；删除边界给出精确的旧文与行号；Global Constraints 第 5 条写明事件循环保留理由（push-target 依赖链）。
- **Type consistency:** 删除面一致——`PinelStatePayload/PinelTreePayload`（host）↔ `PinelState/PinelTree/PinelTreeNode`（webview）↔ `parsePinelState/parsePinelTree`（parser）↔ `getPinelStateCache/getPinelTreeCache`（hook）四个层面在 Task 2/3/4 中逐一配对删除；Task 6 的残留 grep 是最终一致性兜底。Task 1 改写后的 pinel.ts 只 import 仍存在的三个模块（push-target/prompt-composition/mcp-status），`getPinelCtx` 不再被 pinel.ts 引用但 push-target.ts 仍导出（pinel-workflows/mcp-status 用）。
