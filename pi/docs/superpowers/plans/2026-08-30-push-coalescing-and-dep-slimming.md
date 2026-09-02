# Pinel pi 插件：推送调度优化 + 依赖瘦身 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 `pi/pinel.ts` 的冗余推送（每个事件都全量重建快照+树、突发不合并），并删除 `pi/package.json` 中 20 个从未被插件代码 import、也从未被 pi 加载的直依赖。

**Architecture:** 推送侧新增纯模块 `extensions/push.ts`（PushScheduler）：按事件类别分流（内容事件推快照+树，模型/思考等级事件只推快照）、30ms 尾沿合并突发、按会话 append-only 签名记忆化角色计数与树 JSON、快照按 JSON 去重。`pinel.ts` 只做接线。依赖侧按 pi 官方 packages.md 语义裁剪：保留唯一被代码 import 的 `@juicesharp/rpiv-workflow`，`typebox` 移入 peerDependencies（pi 核心捆绑包清单），其余删除，README 更正安装说明。

**Tech Stack:** TypeScript（pi 包现有约定）、vitest（fake timers）、pi 扩展 API（`pi.on` / `ctx.ui.setStatus/setWidget`）、npm。

**Spec:** 本会话用户需求（逐字）："编写计划，进行优化1+4，我确认后再开始实施"——优化1 = `pi/pinel.ts` 推送风暴（10 个事件每个都全量重建 snapshot+tree）；优化4 = `pi/package.json` 依赖冗余（23 个直依赖，插件代码只 import 其中 2 个）。

## Global Constraints

- 不新增任何 npm 依赖；只删依赖、挪位置（typebox → peerDependencies）。
- 推送 payload 契约 **v:1 不变**：`pinel.state` / `pinel.tree` JSON 形状零变化，`vscode/` 宿主与 webview **零改动**。
- 行为契约：`/pinel-state`、`/pinel-tree` 命令仍**立即**全量推送 + notify（不经过合并延迟）；事件推送可合并、可去重，但不得丢失状态（合并用 `pendingTree ||=` 取并集）。
- pi 仓库约定：相对导入写 `.js` 后缀；测试放 `pi/extensions/*.test.ts`（vitest include 已覆盖）；无 tsconfig，类型门 = vscode 侧 `npm run check-plugin`（tsc `--ignoreConfig ../pi/pinel.ts`，跟随 import 检查）；测试与注释中文。
- 提交 Conventional Commits（pi 仓库历史风格：`feat(pi-pinel):` / `test:` / `refactor(pi-pinel):` / `docs(pi-pinel):`），英文摘要。
- `pi/package-lock.json` 入库：Task 5 改 package.json 后必须 `npm install` 同步 lockfile 并一并提交。

## 背景依据（研究结论，执行者勿重复验证）

1. **append-only 语义**（pi `dist/core/session-manager.js:982` 注释原文）："Get all session entries (excludes header). Returns a shallow copy. The session is append-only: use appendXXX() to add entries, branch() to change the leaf pointer. Entries cannot be modified or deleted." ⇒ `sessionFile + entries.length + leafId + 末条目 id` 不变 ⇒ 树与角色计数必不变，可整段跳过 `buildTree`/计数。
2. **事件名核实**：pi 0.84.x `dist/core/agent-session.js` 实际 emit 的事件含 `session_start`、`agent_settled`、`turn_end`、`message_end`、`model_select`、`thinking_level_select`、`thinking_level_changed`、`session_info_changed`、`session_compact`、`session_compact_failed` —— 现注册的 10 个全部真实存在，无死监听；优化点是分流 + 合并 + 记忆化，不是删事件。
3. **依赖不自动加载**（pi `docs/packages.md` Dependencies 节）："When pi installs a package from npm or git, it runs npm install, so those dependencies are installed automatically. Other pi packages must be bundled… reference their resources through node_modules/ paths." + manifest 示例带 `bundledDependencies`。pinel 的 manifest 只有 `./pinel.ts` 等自包路径 ⇒ 现直依赖（9 个 @gotgenes、8 个 rpiv-* 中除 rpiv-workflow 外 7 个、sherpa-onnx-node、decibri、jiti、spec、typebox）**只占安装重量，从未注册任何工具/技能**。`@juicesharp/rpiv-workflow` 是唯一被代码 import 的依赖（`pinel-workflows.ts`/`workflows/*.ts`），pi 在包根跑 npm install，模块根解析成立（现有安装路径已证明）。`typebox` 被 `workflows/sp-shared.ts` 直接 import，而 packages.md 列其为 pi 核心捆绑包 ⇒ 正确位置是 `peerDependencies`（"list them in peerDependencies with a `*` range and do not bundle them"）。
4. **冒烟测试兼容**：`vscode/scripts/pinel-plugin-smoke.mjs` 断言 session_start 后收到 `pinel.state`/`pinel.tree` 帧（等待 4000ms ≫ 30ms 合并延迟）与 `/pinel-state` notify —— 本计划不改帧形状、不删命令，冒烟应原样通过（Task 4/6 实跑验证）。

## File Structure

| 文件 | 职责 |
|------|------|
| `pi/extensions/snapshot.ts`（修改） | 提取 `countRoles(entries)` 供调度器复用；`buildSnapshot(ctx, counts?)` 接受预计算计数 |
| `pi/extensions/push.ts`（新建） | `PushScheduler`（合并/记忆化/去重）+ `FULL_PUSH_EVENTS`/`SNAPSHOT_ONLY_EVENTS` 常量 |
| `pi/extensions/push.test.ts`（新建） | 调度器单元测试（fake timers + fake ctx/ui） |
| `pi/pinel.ts`（修改） | 接线：事件分流注册、命令改 `flushNow` |
| `pi/package.json` + `pi/package-lock.json`（修改） | 依赖裁剪 |
| `pi/README.md`（修改） | 更正安装说明（lane/问卷工具需单独安装） |

---

### Task 1: snapshot.ts 提取 countRoles（重构前置）

**Files:**
- Modify: `pi/extensions/snapshot.ts`

**Interfaces:**
- Produces: `export interface MessageCounts { user: number; assistant: number; toolResult: number; total: number }`、`export function countRoles(entries: ReadonlyArray<any>): MessageCounts`、`buildSnapshot(ctx: any, counts?: MessageCounts): object`。Task 2 依赖这些导出。

- [ ] **Step 1: 基线验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（现 snapshot.test.ts 等全部通过）。

- [ ] **Step 2: 提取 countRoles**

`pi/extensions/snapshot.ts` 顶部 `buildSnapshot` 内联循环改为：

```typescript
/** 角色计数（user/assistant/toolResult；meta 条目不计入，total 与三桶之和一致）。 */
export interface MessageCounts {
  user: number;
  assistant: number;
  toolResult: number;
  total: number;
}

export function countRoles(entries: ReadonlyArray<any>): MessageCounts {
  let user = 0;
  let assistant = 0;
  let toolResult = 0;
  for (const e of entries) {
    const role = e?.message?.role;
    if (role === "user") user++;
    else if (role === "assistant") assistant++;
    else if (role === "toolResult") toolResult++;
  }
  return { user, assistant, toolResult, total: user + assistant + toolResult };
}

/** 会话统计快照（防御聚合；结构未知字段一律容缺）。counts 可选——调用方已
 *  按 append-only 签名记忆化计数时传入，避免重复遍历。 */
export function buildSnapshot(ctx: any, counts?: MessageCounts): object {
  const sm = ctx?.sessionManager;
  const entries = sm?.getEntries?.() ?? [];
  const messages = counts ?? countRoles(entries);
  const snap: Record<string, unknown> = {
    v: 1,
    // total 与三桶之和一致，保证 UI 数字与悬浮明细不漂移（meta 条目不计入）。
    messages: { ...messages },
  };
  if (ctx?.model?.provider && ctx?.model?.id) {
    snap.model = `${ctx.model.provider}/${ctx.model.id}`;
  }
  if (typeof ctx?.thinkingLevel === "string") {
    snap.thinkingLevel = ctx.thinkingLevel;
  }
  if (typeof sm?.getLeafId?.() === "string") {
    snap.leafId = sm.getLeafId();
  }
  if (typeof sm?.getSessionFile?.() === "string") {
    snap.sessionFile = sm.getSessionFile();
  }
  return snap;
}
```

（删除原 `buildSnapshot` 函数体内的循环与 `let user = 0;` 等声明；`buildTree` 与 `extractText` 不动。）

- [ ] **Step 3: 验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（snapshot.test.ts 调用 `buildSnapshot(ctx)` 不带 counts，行为不变）。

- [ ] **Step 4: 提交**

```bash
git -C c:/source_code/Other/pinel/pi add extensions/snapshot.ts
git -C c:/source_code/Other/pinel/pi commit -m "refactor(pi-pinel): extract countRoles for scheduler reuse"
```

---

### Task 2: push.ts 调度器（TDD）

**Files:**
- Create: `pi/extensions/push.test.ts`
- Create: `pi/extensions/push.ts`

**Interfaces:**
- Consumes: Task 1 的 `countRoles`、`buildSnapshot(ctx, counts?)`、`buildTree(ctx)`。
- Produces: `export const FULL_PUSH_EVENTS`（6 个字符串）、`export const SNAPSHOT_ONLY_EVENTS`（4 个字符串）、`export class PushScheduler { constructor(getCtx: () => any, coalesceMs?: number); schedule(withTree: boolean): void; flushNow(withTree?: boolean): void; pushNow(withTree: boolean, opts?: { force?: boolean }): void; reset(): void }`。Task 3 依赖这些导出。

- [ ] **Step 1: 写失败测试**

`pi/extensions/push.test.ts`：

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushScheduler, FULL_PUSH_EVENTS, SNAPSHOT_ONLY_EVENTS } from "./push.js";

interface FakeEntry {
  id: string;
  message?: { role: string; content: unknown };
}

/** fake ctx：可变 state + 记录 setStatus/setWidget 调用串。 */
function makeCtx(overrides: {
  entries?: FakeEntry[];
  sessionFile?: string;
  leafId?: string;
  thinkingLevel?: string;
} = {}) {
  const state = {
    entries: overrides.entries ?? [],
    sessionFile: overrides.sessionFile ?? "s1.json",
    leafId: overrides.leafId ?? "e1",
    thinkingLevel: overrides.thinkingLevel ?? "high",
  };
  const calls: { status: string[]; widgets: string[] } = { status: [], widgets: [] };
  const ctx = {
    sessionManager: {
      getEntries: () => state.entries,
      getLeafId: () => state.leafId,
      getSessionFile: () => state.sessionFile,
    },
    model: { provider: "p", id: "m" },
    get thinkingLevel() {
      return state.thinkingLevel;
    },
    ui: {
      setStatus: (_k: string, v: string) => calls.status.push(v),
      setWidget: (_k: string, v: string[]) => calls.widgets.push(v.join(",")),
    },
  };
  return { ctx, calls, state };
}

const E: FakeEntry[] = [
  { id: "e1", message: { role: "user", content: "hello" } },
  { id: "e2", message: { role: "assistant", content: "hi" } },
];

describe("PushScheduler 合并/分流/记忆化", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("同一突发内的多次调度只推一次（取并集）", () => {
    const { ctx, calls } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.schedule(false);
    s.schedule(true);
    s.schedule(true);
    expect(calls.status.length).toBe(0); // 合并延迟内不推
    vi.advanceTimersByTime(30);
    expect(calls.status.length).toBe(1);
    expect(calls.widgets.length).toBe(1); // pendingTree ||= 并集
  });

  it("快照专属事件不推树", () => {
    const { ctx, calls } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.schedule(false);
    vi.advanceTimersByTime(30);
    expect(calls.status.length).toBe(1);
    expect(calls.widgets.length).toBe(0);
  });

  it("状态未变时连续两次全量推送不产生第二帧（去重）", () => {
    const { ctx, calls } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.flushNow(true);
    s.flushNow(true); // force 语义见下条；此处用 schedule 验证去重
    expect(calls.status.length).toBe(2); // flushNow 是强制路径
    const s2 = new PushScheduler(() => ctx);
    s2.schedule(true);
    vi.advanceTimersByTime(30);
    s2.schedule(true);
    vi.advanceTimersByTime(30);
    expect(calls.status.length).toBe(3); // s2 第二次被去重，只 +1
    expect(calls.widgets.length).toBe(1); // 树去重贯穿：s 两次 flushNow 仅首推（签名未变），s2 两次均去重
  });

  it("追加条目触发树与快照重推", () => {
    const { ctx, calls, state } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.schedule(true);
    vi.advanceTimersByTime(30);
    state.entries = [...state.entries, { id: "e3", message: { role: "assistant", content: "done" } }];
    s.schedule(true);
    vi.advanceTimersByTime(30);
    expect(calls.widgets.length).toBe(2);
    expect(calls.status.length).toBe(2); // 计数变化 → 快照 JSON 变化
  });

  it("leafId 变化触发树重推", () => {
    const { ctx, calls, state } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.schedule(true);
    vi.advanceTimersByTime(30);
    state.leafId = "e1"; // branch 回指：条目不变，leaf 变
    s.schedule(true);
    vi.advanceTimersByTime(30);
    expect(calls.widgets.length).toBe(2);
  });

  it("思考等级变化只推快照", () => {
    const { ctx, calls, state } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.schedule(true);
    vi.advanceTimersByTime(30);
    state.thinkingLevel = "low";
    s.schedule(false);
    vi.advanceTimersByTime(30);
    expect(calls.status.length).toBe(2); // JSON 变化 → 推送
    expect(calls.widgets.length).toBe(1); // 树未动
  });

  it("flushNow 立即推送并取消待决合并", () => {
    const { ctx, calls } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.schedule(true);
    s.flushNow(true);
    expect(calls.status.length).toBe(1); // 立即，不等 30ms
    expect(calls.widgets.length).toBe(1);
    vi.advanceTimersByTime(100);
    expect(calls.status.length).toBe(1); // 待决定时器已取消
  });

  it("flushNow 强制推送即使状态未变", () => {
    const { ctx, calls } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.flushNow(true);
    s.flushNow(true);
    expect(calls.status.length).toBe(2); // force 绕过快照去重（命令显式刷新语义）
    expect(calls.widgets.length).toBe(1); // 树不重复：签名未变即不重发（宿主有 payload 缓存，重发无意义）
  });

  it("签名含 sessionFile：切会话即使计数相同也重推", () => {
    const { ctx, calls, state } = makeCtx({ entries: E });
    const s = new PushScheduler(() => ctx);
    s.schedule(true);
    vi.advanceTimersByTime(30);
    state.sessionFile = "s2.json";
    s.schedule(true);
    vi.advanceTimersByTime(30);
    expect(calls.widgets.length).toBe(2);
  });

  it("事件常量覆盖已核实的 10 个 pi 事件", () => {
    expect([...FULL_PUSH_EVENTS, ...SNAPSHOT_ONLY_EVENTS].sort()).toEqual(
      [
        "session_start", "agent_settled", "turn_end", "message_end",
        "session_compact", "session_compact_failed",
        "model_select", "thinking_level_select", "thinking_level_changed", "session_info_changed",
      ].sort(),
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run extensions/push.test.ts`
Expected: FAIL（`Cannot find module './push.js'`）。

- [ ] **Step 3: 实现 push.ts**

`pi/extensions/push.ts`：

```typescript
/**
 * 推送调度器 — 合并事件突发、按会话 append-only 签名记忆化树与计数。
 *
 * 依据（pi session-manager 官方注释）：会话 append-only，条目不可修改/删除，
 * branch 只改 leaf 指针 ⇒「sessionFile + 条目数 + leafId + 末条目 id」不变，
 * 树与角色计数必不变，可整段跳过 buildTree/计数。
 *
 * 快照 JSON 很小（计数 + 模型/思考等级/leafId/sessionFile），每次重建但
 * 仅在与上次推送不同时才发帧（去重）；树仅在签名变化时重建并发帧。
 * 命令路径（/pinel-state、/pinel-tree）用 flushNow 立即强制推送。
 */
import { buildSnapshot, buildTree, countRoles, type MessageCounts } from "./snapshot.js";

/** 内容事件：快照 + 树全量推送。 */
export const FULL_PUSH_EVENTS = [
  "session_start",
  "agent_settled",
  "turn_end",
  "message_end",
  "session_compact",
  "session_compact_failed",
] as const;

/** 快照专属事件：仅模型/思考等级/会话信息变化，树不受影响。 */
export const SNAPSHOT_ONLY_EVENTS = [
  "model_select",
  "thinking_level_select",
  "thinking_level_changed",
  "session_info_changed",
] as const;

export class PushScheduler {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pendingTree = false;
  #lastSig: string | null = null;
  #counts: MessageCounts | null = null;
  #lastTreeJson: string | null = null;
  #lastSnapshotJson: string | null = null;

  constructor(
    private readonly getCtx: () => any,
    private readonly coalesceMs = 30,
  ) {}

  /** 调度一次推送（事件路径）：同一突发合并，尾沿后推。withTree 取并集。 */
  schedule(withTree: boolean): void {
    this.#pendingTree ||= withTree;
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const tree = this.#pendingTree;
      this.#pendingTree = false;
      this.pushNow(tree);
    }, this.coalesceMs);
  }

  /** 立即推送并取消待决合并（命令路径）。默认全量（快照+树），force 绕过去重。 */
  flushNow(withTree = true): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pendingTree ||= withTree;
    this.pushNow(this.#pendingTree, { force: true });
    this.#pendingTree = false;
  }

  pushNow(withTree: boolean, opts: { force?: boolean } = {}): void {
    const ctx = this.getCtx();
    const ui = ctx?.ui;
    if (!ui?.setStatus || !ui?.setWidget) return;
    const sm = ctx?.sessionManager;
    const entries: ReadonlyArray<any> = sm?.getEntries?.() ?? [];
    const sig = `${sm?.getSessionFile?.() ?? ""}|${entries.length}|${sm?.getLeafId?.() ?? ""}|${lastEntryId(entries)}`;
    let treeChanged = false;
    if (sig !== this.#lastSig) {
      this.#lastSig = sig;
      this.#counts = countRoles(entries);
      this.#lastTreeJson = JSON.stringify(buildTree(ctx));
      treeChanged = true;
    }
    const snapJson = JSON.stringify(buildSnapshot(ctx, this.#counts ?? undefined));
    if (opts.force || snapJson !== this.#lastSnapshotJson) {
      this.#lastSnapshotJson = snapJson;
      ui.setStatus("pinel.state", snapJson);
    }
    if (withTree && treeChanged) {
      ui.setWidget("pinel.tree", [this.#lastTreeJson as string]);
    }
  }

  /** 重置记忆（测试用；会话切换不需要——sessionFile 在签名内）。 */
  reset(): void {
    this.#lastSig = null;
    this.#counts = null;
    this.#lastTreeJson = null;
    this.#lastSnapshotJson = null;
  }
}

function lastEntryId(entries: ReadonlyArray<any>): string {
  return entries.length > 0 ? String(entries[entries.length - 1]?.id ?? "") : "";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（新增 10 条 + 原有全部）。

- [ ] **Step 5: 提交测试与实现（分开，对齐仓库历史风格）**

```bash
git -C c:/source_code/Other/pinel/pi add extensions/push.test.ts
git -C c:/source_code/Other/pinel/pi commit -m "test: push scheduler coalescing and memoization"
git -C c:/source_code/Other/pinel/pi add extensions/push.ts
git -C c:/source_code/Other/pinel/pi commit -m "feat(pi-pinel): coalesced state pushes with append-only tree memo"
```

---

### Task 3: pinel.ts 接线（事件分流 + 命令直推）

**Files:**
- Modify: `pi/pinel.ts`

**Interfaces:**
- Consumes: Task 2 的 `PushScheduler`、`FULL_PUSH_EVENTS`、`SNAPSHOT_ONLY_EVENTS`；既有 `push-target.ts` 的 `setPinelCtx`/`getPinelCtx`。
- Produces: 行为不变——事件触发推送（合并延迟 ≤30ms）、`/pinel-state`、`/pinel-tree` 立即推送 + notify、`navigateTree` 导航语义保留。

- [ ] **Step 1: 改写 pinel.ts**

`pi/pinel.ts` 全文替换为（头部注释保留，补一句调度说明）：

```typescript
/**
 * Pinel Pi 插件 — Pinel VS Code 面板与 pi 会话的桥。
 *
 * 仅在被 Pinel 扩展 spawn 的 pi（--mode rpc + PINEL_PLUGIN=1）内激活，
 * 其余场景（TUI 等）完全惰性：工厂直接 return，不注册任何东西。
 *
 * 通道（复用 stdio JSONL RPC，无新增传输层）：
 * - 推送（插件 → 面板）：ctx.ui.setStatus("pinel.state", <JSON>) /
 *   ctx.ui.setWidget("pinel.tree", [<JSON>]) —— fire-and-forget，
 *   pi 以 extension_ui_request 帧出 stdout，宿主转发 webview 渲染。
 * - 控制（面板 → 插件）：RPC prompt 派发扩展命令 /pinel-state、/pinel-tree
 *   （rpc.md：扩展命令立即执行；实测不写入会话条目）。
 *
 * payload 契约（v:1；宿主/ webview 防御解析）：
 * - pinel.state: {v:1, leafId?, sessionFile?, messages:{user,assistant,toolResult,total}, model?, thinkingLevel?}
 * - pinel.tree:  {v:1, leafId?, nodes:[{entryId, role, text, timestamp?}]}（当前分支链消息节点）
 *
 * 推送经 PushScheduler：事件分流（内容事件推快照+树，模型/思考等级事件仅快照）、
 * 30ms 尾沿合并突发、按会话 append-only 签名记忆化树与计数、快照 JSON 去重。
 * 说明：token/cost 不在此推送（宿主 get_session_stats 权威兑底，防双源漂移）；
 * compact/fork/rename/switch 已有原生 RPC 命令，本插件不重复实现。
 */
import { PushScheduler, FULL_PUSH_EVENTS, SNAPSHOT_ONLY_EVENTS } from "./extensions/push.js";
import { getPinelCtx, setPinelCtx } from "./extensions/push-target.js";

const VERSION = "0.1.0";

export default function (pi: any) {
  if (process.env.PINEL_PLUGIN !== "1") {
    return; // 非 Pinel 面板会话：完全惰性
  }

  const scheduler = new PushScheduler(() => getPinelCtx());

  for (const name of FULL_PUSH_EVENTS) {
    pi.on(name, (_ev: any, ctx: any) => {
      if (ctx?.mode !== "rpc") return;
      setPinelCtx(ctx); // 供 pinel-workflows 生命周期推送复用
      scheduler.schedule(true);
    });
  }
  for (const name of SNAPSHOT_ONLY_EVENTS) {
    pi.on(name, (_ev: any, ctx: any) => {
      if (ctx?.mode !== "rpc") return;
      setPinelCtx(ctx);
      scheduler.schedule(false);
    });
  }

  pi.registerCommand("pinel-state", {
    description: "推送当前会话状态快照到 Pinel 面板",
    handler: async (_args: any, ctx: any) => {
      setPinelCtx(ctx);
      scheduler.flushNow(true);
      ctx.ui.notify(`Pinel: 状态已刷新（插件 ${VERSION}）`, "info");
      return "pushed";
    },
  });

  pi.registerCommand("pinel-tree", {
    description: "会话树导航：无参推送树；带 entryId 导航到该节点",
    handler: async (args: any, ctx: any) => {
      const target = typeof args === "string" ? args.trim() : "";
      if (!target) {
        setPinelCtx(ctx);
        scheduler.flushNow(true);
        ctx.ui.notify("Pinel: 已推送会话树", "info");
        return "pushed";
      }
      const result = await ctx.navigateTree?.(target);
      if (result?.cancelled) {
        ctx.ui.notify("Pinel: 导航已取消", "warning");
        return "cancelled";
      }
      // 导航后写入 ctx：快照/树反映导航后 leafId
      setPinelCtx(ctx);
      scheduler.flushNow(true);
      ctx.ui.notify("Pinel: 已导航到目标节点", "info");
      return "navigated";
    },
  });
}
```

- [ ] **Step 2: 类型与单测验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run` 与 `cd c:/source_code/Other/pinel/vscode && npm run check-plugin`
Expected: vitest 全绿；check-plugin 零错误（tsc 跟随 pinel.ts import 检查 push.ts/snapshot.ts）。

- [ ] **Step 3: 提交**

```bash
git -C c:/source_code/Other/pinel/pi add pinel.ts
git -C c:/source_code/Other/pinel/pi commit -m "feat(pi-pinel): route events through push scheduler"
```

---

### Task 4: 端到端验证（冒烟）

**Files:** 无新文件。

- [ ] **Step 1: 真实 pi 冒烟**

Run: `cd c:/source_code/Other/pinel/vscode && npm run smoke:plugin`
Expected: `SMOKE OK: 插件加载 / pinel.state+tree 帧 / get_commands / /pinel-state 派发全部通过`（session_start 后 30ms 内帧到达，远小于脚本 4000ms 等待）。

- [ ] **Step 2: 若冒烟失败**

先查 `pi/docs/rpc.md` 与 `vscode/src/rpc/protocol.ts` 头注释核对帧形状；确认 `setPinelCtx` 在每次 schedule 前执行（事件 handler 内），以及 PushScheduler 的 `getCtx` 闭包引用的是 push-target 模块级槽位而非过期局部变量。修复后重跑 Step 1 与 Task 2 测试。

---

### Task 5: package.json 依赖瘦身

**Files:**
- Modify: `pi/package.json`（dependencies/peerDependencies）
- Modify: `pi/package-lock.json`（npm install 生成）

- [ ] **Step 1: 编辑 package.json**

`pi/package.json` 的 `dependencies` 与 `peerDependencies` 改为：

```json
  "dependencies": {
    "@juicesharp/rpiv-workflow": "^2.7.1"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
```

删除项：全部 9 个 `@gotgenes/*`、`@juicesharp/rpiv-args`、`rpiv-ask-user-question`、`rpiv-todo`、`rpiv-voice`、`rpiv-config`、`rpiv-i18n`、`rpiv-pi`、`@standard-schema/spec`、`decibri`、`jiti`、`sherpa-onnx-node`；`typebox` 移入 peerDependencies（pi 核心捆绑包，packages.md 明确要求列 peerDependencies `*` 且不捆绑）。

- [ ] **Step 2: 同步 lockfile 并做残留 import 扫描**

Run: `cd c:/source_code/Other/pinel/pi && npm install`
Run: `cd c:/source_code/Other/pinel/pi && grep -rn "@gotgenes\|rpiv-ask-user-question\|rpiv-todo\|rpiv-voice\|rpiv-args\|rpiv-config\|rpiv-i18n\|rpiv-pi\|sherpa\|decibri\|jiti\|standard-schema" --include="*.ts" . | grep -v node_modules | grep -v ".test.ts"`
Expected: npm install 成功、lockfile 更新；grep 无输出（源码零引用已删包；仅 rpiv-workflow 与 typebox 合法保留）。

- [ ] **Step 3: 全量验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run` 与 `cd c:/source_code/Other/pinel/vscode && npm run check-plugin` 与 `cd c:/source_code/Other/pinel/vscode && npm run smoke:plugin`
Expected: 全绿。冒烟在临时项目 `pi install -l` 安装瘦身后的包（npm install 只装 rpiv-workflow + 传递依赖），插件加载与帧通道不受影响。

- [ ] **Step 4: 提交**

```bash
git -C c:/source_code/Other/pinel/pi add package.json package-lock.json
git -C c:/source_code/Other/pinel/pi commit -m "refactor(pi-pinel): drop unused direct dependencies, typebox to peer"
```

---

### Task 6: README 更正安装说明

**Files:**
- Modify: `pi/README.md`

- [ ] **Step 1: 更新「安装」节**

`pi/README.md` 安装节替换为：

```markdown
## 安装

pi install <本包路径或 npm 源>
pi install git:github.com/obra/superpowers@v6.3.0   # 工作流按名引用这些技能
pi install npm:@juicesharp/rpiv-pi npm:@juicesharp/rpiv-ask-user-question

> rpiv-workflow 随本包依赖自动安装。rpiv-pi（停靠提问的 lane）与
> rpiv-ask-user-question（问卷工具）需单独安装并在 settings.json packages
> 中加载；其余生态包（@gotgenes/*、rpiv-todo、rpiv-voice 等）按需安装，
> Pinel 面板的插件目录提供一键批量安装。
```

（删除原 "> rpiv-pi / rpiv-workflow / rpiv-ask-user-question 等随本包依赖自动安装" 一行——旧表述不实：依赖只被 npm 安装到包内 node_modules，pi 不会自动加载它们的扩展/工具。）

- [ ] **Step 2: 提交**

```bash
git -C c:/source_code/Other/pinel/pi add README.md
git -C c:/source_code/Other/pinel/pi commit -m "docs(pi-pinel): correct install instructions after dep slimming"
```

---

## Self-Review

- **Spec coverage:** 优化1 → Task 1-4（countRoles 提取、PushScheduler 分流/合并/记忆化/去重、pinel.ts 接线、冒烟验证）；优化4 → Task 5-6（依赖裁剪 + typebox 移 peer + README 更正）。契约 v:1 不变（Global Constraints 第 2 条），vscode 仓库零改动。
- **Placeholder scan:** 无 TBD/TODO；所有代码块完整；事件名已对照 pi 0.84.x 实际 emit 核实；packages.md 依赖加载语义与 append-only 注释均附原文依据。
- **Type consistency:** Task 2 测试引用的 `PushScheduler` 构造签名 `(getCtx, coalesceMs?)`、方法 `schedule/flushNow/pushNow/reset` 与 Task 3 使用一致；Task 1 导出的 `countRoles`/`MessageCounts`/`buildSnapshot(ctx, counts?)` 与 Task 2 导入一致；事件常量名 `FULL_PUSH_EVENTS`/`SNAPSHOT_ONLY_EVENTS` 三处（定义、测试、pinel.ts）一致。
