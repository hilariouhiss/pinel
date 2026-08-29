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
