import type { SessionContextUsage, SessionStatsData, SessionTokens } from "../rpc/protocol";

/**
 * 防御解析 get_session_stats 响应数据（参照 models.ts 的防御思路）。
 *
 * 规则：
 * - data 非对象 / tokens 缺失或非对象 / tokens 五项中 input/output/cacheRead/cacheWrite
 *   任一非有限数字 → 返回 null（统计是整体展示，核心四项缺一即不完整，不产出部分数据）
 * - tokens.total 缺省或无效时按四值之和补齐（对齐 pi 的 total 定义）
 * - cost / 消息计数：非有限数字 → 忽略该字段（cost 为 0 是合法值，保留）
 * - contextUsage 可整体缺省（无模型/旧版 pi）；其 tokens/percent 允许 null
 *   （压缩后无新响应，估算不可信）；contextWindow 无效则整个 contextUsage 丢弃
 */
export function parseSessionStats(data: unknown): SessionStatsData | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const raw = data as Record<string, unknown>;
  const tokensRaw = raw.tokens;
  if (typeof tokensRaw !== "object" || tokensRaw === null) {
    return null;
  }
  const t = tokensRaw as Record<string, unknown>;
  const input = toFinite(t.input);
  const output = toFinite(t.output);
  const cacheRead = toFinite(t.cacheRead);
  const cacheWrite = toFinite(t.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return null;
  }
  const tokens: SessionTokens = {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: toFinite(t.total) ?? input + output + cacheRead + cacheWrite,
  };
  const stats: SessionStatsData = { tokens };
  const cost = toFinite(raw.cost);
  if (cost !== undefined) {
    stats.cost = cost;
  }
  if (typeof raw.sessionFile === "string") {
    stats.sessionFile = raw.sessionFile;
  }
  if (typeof raw.sessionId === "string") {
    stats.sessionId = raw.sessionId;
  }
  for (const key of ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages"] as const) {
    const v = toFinite(raw[key]);
    if (v !== undefined) {
      stats[key] = v;
    }
  }
  const contextUsage = parseContextUsage(raw.contextUsage);
  if (contextUsage) {
    stats.contextUsage = contextUsage;
  }
  return stats;
}

function parseContextUsage(value: unknown): SessionContextUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const c = value as Record<string, unknown>;
  const contextWindow = toFinite(c.contextWindow);
  if (contextWindow === undefined) {
    return undefined; // 无有效 contextWindow → 整个 contextUsage 丢弃
  }
  return {
    tokens: toFinite(c.tokens) ?? null,
    contextWindow,
    percent: toFinite(c.percent) ?? null,
  };
}

/** 有限数字 → 值；非数字/NaN/Infinity → undefined。 */
function toFinite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
