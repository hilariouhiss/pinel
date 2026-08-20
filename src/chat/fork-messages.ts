import type { ForkMessage } from "../rpc/protocol";

/**
 * 防御解析 get_fork_messages 响应数据（fork 选择器数据源）。
 *
 * 输入是 RPC 响应的 `data` 字段（unknown）。pi 0.84.x 实测返回
 * `[{entryId, text}]`（仅非空 user message，见 agent-session.js
 * getUserMessagesForForking）；防御规则对齐 commands.ts：
 * 结构不符返回 []；逐项跳过缺失/类型错误；entryId/text 须为非空字符串。
 */
export function parseForkMessages(data: unknown): ForkMessage[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const raw = (data as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) {
    return [];
  }
  const messages: ForkMessage[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const entryId = entry.entryId;
    const text = entry.text;
    if (typeof entryId !== "string" || entryId.length === 0) {
      continue; // 缺失/非字符串 entryId：跳过该条，不拖垮整个列表
    }
    if (typeof text !== "string" || text.length === 0) {
      continue;
    }
    messages.push({ entryId, text });
  }
  return messages;
}
