/** 角色计数（user/assistant/toolResult；pi 会话条目 role 嵌套在 entry.message 下，顶层无 role；meta 条目不计入，total 与三桶之和一致）。 */
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

/** 当前分支链上的用户/assistant 消息节点（树导航目标）。 */
export function buildTree(ctx: any): object {
  const sm = ctx?.sessionManager;
  const entries = sm?.getEntries?.() ?? [];
  const nodes: Record<string, unknown>[] = [];
  for (const e of entries) {
    const msg = e?.message;
    if (!msg) continue; // meta 条目（thinking_level_change 等）无 message，跳过
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof e?.id !== "string" || e.id.length === 0) continue;
    const text = extractText(msg.content).slice(0, 80);
    if (text.length === 0) continue;
    nodes.push({
      entryId: e.id,
      role,
      text,
      timestamp: typeof e?.timestamp === "number" || typeof e?.timestamp === "string" ? e.timestamp : undefined,
    });
  }
  const tree: Record<string, unknown> = { v: 1, nodes };
  if (typeof sm?.getLeafId?.() === "string") {
    tree.leafId = sm.getLeafId();
  }
  return tree;
}

/** 消息 content（string | 块数组）→ 纯文本（非消息条目返回 ""）。 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" && typeof b?.text === "string" ? b.text : ""))
      .join(" ")
      .trim();
  }
  return "";
}
