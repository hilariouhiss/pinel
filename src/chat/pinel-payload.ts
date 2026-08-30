/**
 * Pinel 插件 payload 防御解析（宿主端；无 vscode 依赖，可单测）。
 *
 * 数据源：pi 插件经 extension_ui_request 帧推送（setStatus.statusText /
 * setWidget.widgetLines 内嵌 JSON 字符串）。payload 契约见 ../pi/pinel.ts
 * 头注释（v:1）。解析规则对齐 session-stats.ts：结构不符返回 null，
 * 逐字段容缺——不产出半可信数据（渲染层拿 null 即忽略）。
 */

/** pinel.state 快照（setStatus statusText 解析产物）。 */
export interface PinelStatePayload {
  v: 1;
  messages: { user: number; assistant: number; toolResult: number; total: number };
  model?: string;
  thinkingLevel?: string;
  leafId?: string;
  sessionFile?: string;
}

/** pinel.tree 节点（当前分支链消息；树导航目标）。 */
export interface PinelTreeNode {
  entryId: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

/** pinel.tree 载荷（setWidget widgetLines[0] 解析产物）。 */
export interface PinelTreePayload {
  v: 1;
  nodes: PinelTreeNode[];
  leafId?: string;
}

/** 防御解析 pinel.state JSON 字符串。 */
export function parsePinelState(text: unknown): PinelStatePayload | null {
  const raw = parseJsonObject(text);
  if (!raw || raw.v !== 1) {
    return null;
  }
  const messagesRaw = raw.messages;
  if (typeof messagesRaw !== "object" || messagesRaw === null) {
    return null;
  }
  const m = messagesRaw as Record<string, unknown>;
  const messages = {
    user: toCount(m.user),
    assistant: toCount(m.assistant),
    toolResult: toCount(m.toolResult),
    total: toCount(m.total),
  };
  const payload: PinelStatePayload = { v: 1, messages };
  const model = raw.model;
  if (typeof model === "string" && model.length > 0) {
    payload.model = model;
  }
  const thinkingLevel = raw.thinkingLevel;
  if (typeof thinkingLevel === "string") {
    payload.thinkingLevel = thinkingLevel;
  }
  const leafId = raw.leafId;
  if (typeof leafId === "string") {
    payload.leafId = leafId;
  }
  const sessionFile = raw.sessionFile;
  if (typeof sessionFile === "string") {
    payload.sessionFile = sessionFile;
  }
  return payload;
}

/** 防御解析 pinel.tree JSON 字符串（widgetLines 首元素）。 */
export function parsePinelTree(lines: unknown): PinelTreePayload | null {
  const raw = parseJsonObject(Array.isArray(lines) ? lines[0] : lines);
  if (!raw || raw.v !== 1) {
    return null;
  }
  const nodes: PinelTreeNode[] = [];
  if (Array.isArray(raw.nodes)) {
    for (const item of raw.nodes) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const n = item as Record<string, unknown>;
      const entryId = n.entryId;
      const role = n.role;
      const text = n.text;
      if (typeof entryId !== "string" || entryId.length === 0) {
        continue;
      }
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      if (typeof text !== "string" || text.length === 0) {
        continue;
      }
      const node: PinelTreeNode = { entryId, role, text };
      if (typeof n.timestamp === "number" && Number.isFinite(n.timestamp)) {
        node.timestamp = n.timestamp;
      }
      nodes.push(node);
    }
  }
  const payload: PinelTreePayload = { v: 1, nodes };
  if (typeof raw.leafId === "string") {
    payload.leafId = raw.leafId;
  }
  return payload;
}

/** JSON 字符串 → 对象（非对象/解析失败 → null）。 */
function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** 消息计数：非负整数才有效（1.5 等非法值按 0，不拖垮整体）。 */
function toCount(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

// ---------------------------------------------------------------------------
// ponytail 状态（@dietrichgebert/ponytail 插件自推 setStatus 帧）
// ---------------------------------------------------------------------------

/** ponytail 状态（statusKey "ponytail" 的 setStatus 帧解析产物）。 */
export interface PonytailStatus {
  /** 实心点=激活（agent 运行中）；空心点=已启用但空闲（对齐 ponytail 自身状态行语义）。 */
  active: boolean;
  /** 当前档位（lite/full/ultra；off 时 ponytail 推送空文本清除指示器）。 */
  mode: string;
}

/** ANSI 颜色序列剥离（RPC 模式 ctx.ui.theme.fg 输出带色码）。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 防御解析 ponytail 状态文本（形态 "● 🐴 ponytail: ⚡ FULL" / "○ … LITE"）：
 * - 空文本（mode off 清除指示器）→ {active:false, mode:"off"}
 * - 首字符 ● → active；末位大写单词 → mode；形状不符 → null（忽略帧）
 */
export function parsePonytailStatus(text: unknown): PonytailStatus | null {
  if (typeof text !== "string") {
    return null;
  }
  const plain = stripAnsi(text).trim();
  if (plain.length === 0) {
    return { active: false, mode: "off" };
  }
  const active = plain.startsWith("●");
  const tokens = plain.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!/^[A-Z]{2,}$/.test(last)) {
    return null;
  }
  return { active, mode: last.toLowerCase() };
}

// ---------------------------------------------------------------------------
// MCP 状态（pi-mcp-adapter setStatus statusKey "mcp" 帧解析）
// ---------------------------------------------------------------------------

/** MCP 服务器摘要（statusKey "mcp" 的 setStatus 帧解析产物）。 */
export interface McpStatus {
  /** connecting = 适配器启动连接中；ready = 稳态（含 0 服务器清除信号）。 */
  state: "connecting" | "ready";
  /** 启用服务器数（分母）。 */
  enabled: number;
  /** 已连接服务器数（分子）。 */
  connected: number;
  /** 禁用服务器数（仅 full 模式帧携带）。 */
  disabled?: number;
}

/** MCP 清除信号（setStatus("mcp", undefined) / 空文本：无服务器或 footer 关闭）。 */
const MCP_CLEARED: McpStatus = { state: "ready", enabled: 0, connected: 0 };

/**
 * 防御解析 MCP 状态行（pi-mcp-adapter updateStatusBar 三种形态 + 清除）：
 * - full:  "🔌 MCP: N servers enabled (C connected) (D disabled)"（图标/括号段可选）
 * - compact: "MCP C/N"（mcpFooterStatus=compact，无图标无冒号）
 * - 启动:  "🔌 MCP: connecting to N servers..."
 * - 空文本/undefined → 清除信号（enabled 0）；其余形状 → null（整帧忽略）
 */
export function parseMcpStatus(text: unknown): McpStatus | null {
  if (text === undefined) {
    return MCP_CLEARED;
  }
  if (typeof text !== "string") {
    return null;
  }
  const plain = stripAnsi(text).trim();
  if (plain.length === 0) {
    return MCP_CLEARED;
  }
  // compact: "MCP C/N"（无前缀无图标；先于 full 匹配，避免 "MCP:" 干扰）
  const compact = /^MCP (\d+)\/(\d+)$/.exec(plain);
  if (compact) {
    return { state: "ready", connected: Number(compact[1]), enabled: Number(compact[2]) };
  }
  // 统一剥前缀："🔌 MCP: " / "MCP: "（图标与冒号均可选）
  const body = plain.replace(/^(?:[^\w]*?)?MCP:\s*/, "");
  if (body === plain) {
    return null; // 无 MCP: 前缀且非 compact 形状 → 非本插件帧
  }
  const connecting = /^connecting to (\d+) servers?\.\.\.$/.exec(body);
  if (connecting) {
    return { state: "connecting", enabled: Number(connecting[1]), connected: 0 };
  }
  const full = /^(\d+) servers? enabled(?: \((\d+) connected\))?(?: \((\d+) disabled\))?$/.exec(body);
  if (!full) {
    return null;
  }
  const status: McpStatus = {
    state: "ready",
    enabled: Number(full[1]),
    connected: full[2] !== undefined ? Number(full[2]) : 0,
  };
  if (full[3] !== undefined) {
    status.disabled = Number(full[3]);
  }
  return status;
}

// ---------------------------------------------------------------------------
// pinel.workflow / pinel.workflows（rpiv-workflow 生命周期推送）
// ---------------------------------------------------------------------------

/** 工作流运行状态（pi 端 pinel-workflows.ts 生命周期推送的四种值）。 */
export type PinelWorkflowStatus = "running" | "awaiting-approval" | "done" | "failed";

/** pinel.workflow 载荷（setStatus statusText / setWidget widgetLines[0] 同构）。 */
export interface PinelWorkflowPayload {
  v: 1;
  runId: string;
  workflow: string;
  totalStages: number;
  status: PinelWorkflowStatus;
  stage?: string;
  stageNumber?: number;
  /** onStageError 的 error 文案；仅 failed 携带。 */
  message?: string;
}

/** 防御解析 pinel.workflow JSON 字符串（status 非法整帧丢弃）。 */
export function parsePinelWorkflow(text: unknown): PinelWorkflowPayload | null {
  const raw = parseJsonObject(text);
  if (!raw || raw.v !== 1) {
    return null;
  }
  const runId = raw.runId;
  const workflow = raw.workflow;
  if (typeof runId !== "string" || runId.length === 0) {
    return null;
  }
  if (typeof workflow !== "string" || workflow.length === 0) {
    return null;
  }
  const status = raw.status;
  if (
    status !== "running" &&
    status !== "awaiting-approval" &&
    status !== "done" &&
    status !== "failed"
  ) {
    return null;
  }
  const payload: PinelWorkflowPayload = {
    v: 1,
    runId,
    workflow,
    totalStages: toCount(raw.totalStages),
    status,
  };
  if (typeof raw.stage === "string" && raw.stage.length > 0) {
    payload.stage = raw.stage;
  }
  const stageNumber = raw.stageNumber;
  if (typeof stageNumber === "number" && Number.isInteger(stageNumber) && stageNumber >= 0) {
    payload.stageNumber = stageNumber;
  }
  if (typeof raw.message === "string" && raw.message.length > 0) {
    payload.message = raw.message;
  }
  return payload;
}
