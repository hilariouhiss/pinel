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
