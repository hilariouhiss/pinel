/**
 * subagent 工具卡片解析（纯函数，无 vscode 依赖）。
 *
 * 数据源：`tool_execution_start`（toolName === "subagent"）的 `args` 与
 * `tool_execution_update`/`tool_execution_end` 的 `details`。details 是
 * @gotgenes/pi-subagents 扩展的未文档化 AgentDetails 格式（modelName 仅在
 * 与主会话模型不同时存在；thinking 藏在 tags 的 "thinking: <level>" 条目里），
 * 随扩展升级可能漂移——解析必须防御：任何字段类型不符静默跳过，调用方降级
 * 为字段级兜底（description "Subagent"、model/thinking null → webview 显示
 * "main model"/"main level"），输出内容始终经 ToolCard.output 可达。
 *
 * # ponytail: 第三方扩展未文档化格式，字段漂移时卡片显示兜底值；若 pi 未来
 * 内置 subagent 工具或提供官方 schema，迁移到官方通道。
 */

export type SubagentCardStatus = "running" | "completed" | "error" | "background" | "stopped";

export interface SubagentCardInfo {
  /** 任务短描述（args.description），缺省 "Subagent"。 */
  description: string;
  /** 子智能体类型（subagent_type），未知 null。 */
  subagentType: string | null;
  /** 模型短名；null = 继承主会话（details.modelName 仅在与父不同时存在）。 */
  model: string | null;
  /** 思考深度；null = 继承主会话。 */
  thinking: string | null;
  status: SubagentCardStatus;
  /** 运行中实时活动（如 "reading" / "running command"）。 */
  activity: string | null;
  turnCount: number | null;
  toolUses: number | null;
  /** 已格式化的 token 统计串（如 "12.3k"）。 */
  tokens: string | null;
  durationMs: number | null;
}

/** AgentDetails.status → 卡片状态；未知值 null（不覆盖当前状态，防御）。 */
function mapStatus(raw: unknown): SubagentCardStatus | null {
  switch (raw) {
    case "completed":
    case "steered":
      return "completed";
    case "error":
      return "error";
    case "background":
      return "background";
    case "stopped":
    case "aborted":
      return "stopped";
    case "queued":
    case "running":
      return "running";
    default:
      return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** 从 tags 提取 "thinking: <level>"。 */
function thinkingFromTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) {
    return null;
  }
  for (const t of tags) {
    if (typeof t === "string") {
      const m = t.match(/^thinking:\s*(\S+)$/);
      if (m) {
        return m[1];
      }
    }
  }
  return null;
}

/**
 * 从 tool_execution_start args 构建卡片初始信息（status 固定 running；
 * background 与终态只能由后续 details 确定）。args 永不失败——全部字段兜底。
 */
export function buildSubagentCard(args: unknown): SubagentCardInfo {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return {
    description: asString(a.description) ?? "Subagent",
    subagentType: asString(a.subagent_type) ?? asString(a.subagentType),
    model: asString(a.model),
    thinking: asString(a.thinking),
    status: "running",
    activity: null,
    turnCount: null,
    toolUses: null,
    tokens: null,
    durationMs: null,
  };
}

/**
 * 将 tool_execution_update/end 的 details 合并进卡片（就地更新）。
 * details 形状不符时不做任何修改；isError=true 强制 error（优先于
 * details.status——两者可能冲突）。
 */
export function applySubagentDetails(card: SubagentCardInfo, details: unknown, isError = false): void {
  if (!details || typeof details !== "object") {
    return;
  }
  const d = details as Record<string, unknown>;
  const model = asString(d.modelName);
  if (model) {
    card.model = model;
  }
  const thinking = thinkingFromTags(d.tags);
  if (thinking) {
    card.thinking = thinking;
  }
  // args 缺失时从 details 补（detailBase 携带同名字段）
  if (card.description === "Subagent") {
    const desc = asString(d.description);
    if (desc) {
      card.description = desc;
    }
  }
  if (!card.subagentType) {
    card.subagentType = asString(d.subagentType);
  }
  if (typeof d.activity === "string") {
    card.activity = d.activity || null;
  }
  if (typeof d.turnCount === "number" && Number.isFinite(d.turnCount)) {
    card.turnCount = d.turnCount;
  }
  if (typeof d.toolUses === "number" && Number.isFinite(d.toolUses)) {
    card.toolUses = d.toolUses;
  }
  const tokens = asString(d.tokens);
  if (tokens) {
    card.tokens = tokens;
  }
  if (typeof d.durationMs === "number" && Number.isFinite(d.durationMs)) {
    card.durationMs = d.durationMs;
  }
  if (isError) {
    card.status = "error";
    return;
  }
  const status = mapStatus(d.status);
  if (status) {
    card.status = status;
  }
}
