/**
 * Pinel 插件 payload 防御解析（宿主端；无 vscode 依赖，可单测）。
 *
 * 数据源：pi 插件经 extension_ui_request 帧推送（setStatus.statusText /
 * setWidget.widgetLines 内嵌 JSON 字符串）。payload 契约见 pinel-plugin/pinel.ts
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
