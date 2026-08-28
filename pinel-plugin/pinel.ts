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
 * 说明：token/cost 不在此推送（宿主 get_session_stats 权威兑底，防双源漂移）；
 * compact/fork/rename/switch 已有原生 RPC 命令，本插件不重复实现。
 */
const VERSION = "0.1.0";

export default function (pi: any) {
  if (process.env.PINEL_PLUGIN !== "1") {
    return; // 非 Pinel 面板会话：完全惰性
  }

  // 多候选事件名（注册未知名不报错，实测 pi 0.84.3 行为）：状态变化时推快照。
  const PUSH_EVENTS = [
    "session_start",
    "agent_settled",
    "turn_end",
    "message_end",
    "session_info_changed",
    "session_compact",
    "session_compact_failed",
    "model_select",
    "thinking_level_select",
    "thinking_level_changed",
  ];

  function pushState(ctx: any) {
    ctx.ui.setStatus("pinel.state", JSON.stringify(buildSnapshot(ctx)));
    ctx.ui.setWidget("pinel.tree", [JSON.stringify(buildTree(ctx))]);
  }

  for (const name of PUSH_EVENTS) {
    pi.on(name, (_ev: any, ctx: any) => {
      if (ctx?.mode !== "rpc") return;
      pushState(ctx);
    });
  }

  pi.registerCommand("pinel-state", {
    description: "推送当前会话状态快照到 Pinel 面板",
    handler: async (_args: any, ctx: any) => {
      pushState(ctx);
      ctx.ui.notify(`Pinel: 状态已刷新（插件 ${VERSION}）`, "info");
      return "pushed";
    },
  });

  pi.registerCommand("pinel-tree", {
    description: "会话树导航：无参推送树；带 entryId 导航到该节点",
    handler: async (args: any, ctx: any) => {
      const target = typeof args === "string" ? args.trim() : "";
      if (!target) {
        pushState(ctx);
        ctx.ui.notify("Pinel: 已推送会话树", "info");
        return "pushed";
      }
      const result = await ctx.navigateTree?.(target);
      if (result?.cancelled) {
        ctx.ui.notify("Pinel: 导航已取消", "warning");
        return "cancelled";
      }
      pushState(ctx);
      ctx.ui.notify("Pinel: 已导航到目标节点", "info");
      return "navigated";
    },
  });
}

/** 会话统计快照（防御聚合；结构未知字段一律容缺）。 */
function buildSnapshot(ctx: any): object {
  const sm = ctx?.sessionManager;
  const entries = sm?.getEntries?.() ?? [];
  let user = 0;
  let assistant = 0;
  let toolResult = 0;
  for (const e of entries) {
    const role = e?.role;
    if (role === "user") user++;
    else if (role === "assistant") assistant++;
    else if (role === "toolResult") toolResult++;
  }
  const snap: Record<string, unknown> = {
    v: 1,
    messages: { user, assistant, toolResult, total: entries.length },
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
function buildTree(ctx: any): object {
  const sm = ctx?.sessionManager;
  const entries = sm?.getEntries?.() ?? [];
  const nodes: Record<string, unknown>[] = [];
  for (const e of entries) {
    const role = e?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof e?.id !== "string" || e.id.length === 0) continue;
    const text = extractText(e?.content).slice(0, 80);
    if (text.length === 0) continue;
    nodes.push({
      entryId: e.id,
      role,
      text,
      timestamp: typeof e?.timestamp === "number" ? e.timestamp : undefined,
    });
  }
  const tree: Record<string, unknown> = { v: 1, nodes };
  if (typeof sm?.getLeafId?.() === "string") {
    tree.leafId = sm.getLeafId();
  }
  return tree;
}

/** 消息 content（string | 块数组）→ 纯文本（非消息条目返回 ""）。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" && typeof b?.text === "string" ? b.text : ""))
      .join(" ")
      .trim();
  }
  return "";
}
