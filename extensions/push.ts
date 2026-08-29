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
