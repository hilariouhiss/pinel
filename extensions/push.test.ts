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
    leafId: overrides.leafId ?? "e2",
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
    expect(calls.widgets.length).toBe(2); // 树去重：s 两次 flushNow 仅首推（签名未变，force 不重发树）；s2 首推因实例记忆为空而重发，第二次被去重
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
