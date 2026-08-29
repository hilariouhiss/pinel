/**
 * 按 contentIndex 分块装配部分消息（纯函数，便于单元测试）。
 *
 * 协议要求：`message_update` 不携带累计消息，客户端必须用 `message_start` +
 * 按 `contentIndex` 的增量自行组装（thinking 与 text 多块交替时不能简单追加），
 * 以 `message_end.message` 为权威替换。
 */
import type { AssistantDeltaEvent, ToolCallContentBlock } from "../rpc/protocol";

export interface StreamBlock {
  kind: "text" | "thinking" | "toolCall";
  text: string;
  toolCall?: { id: string; name: string; arguments: string };
}

export interface StreamAssembly {
  /** 有序的内容块（按出现顺序）。 */
  blocks: StreamBlock[];
  /** contentIndex → blocks 下标 的映射。 */
  byIndex: Map<number, number>;
}

export function createAssembly(): StreamAssembly {
  return { blocks: [], byIndex: new Map() };
}

function ensureBlock(a: StreamAssembly, contentIndex: number, kind: StreamBlock["kind"]): StreamBlock {
  const existing = a.byIndex.get(contentIndex);
  if (existing !== undefined) {
    return a.blocks[existing];
  }
  const block: StreamBlock = { kind, text: "" };
  a.byIndex.set(contentIndex, a.blocks.length);
  a.blocks.push(block);
  return block;
}

/** 应用一个增量事件，返回当前部分消息的内容块快照。 */
export function applyDelta(a: StreamAssembly, event: AssistantDeltaEvent): StreamBlock[] {
  switch (event.type) {
    case "text_start":
      ensureBlock(a, event.contentIndex, "text");
      break;
    case "text_delta":
      ensureBlock(a, event.contentIndex, "text").text += event.delta;
      break;
    case "text_end": {
      const b = ensureBlock(a, event.contentIndex, "text");
      b.text = event.content; // 以权威 content 替换
      break;
    }
    case "thinking_start":
      ensureBlock(a, event.contentIndex, "thinking");
      break;
    case "thinking_delta":
      ensureBlock(a, event.contentIndex, "thinking").text += event.delta;
      break;
    case "thinking_end": {
      const b = ensureBlock(a, event.contentIndex, "thinking");
      if (event.thinking !== undefined) {
        b.text = event.thinking;
      }
      break;
    }
    case "toolcall_start": {
      const b = ensureBlock(a, event.contentIndex, "toolCall");
      if (event.toolCall) {
        // 包裹形态（旧版/假 pi）：toolCall 对象
        b.toolCall = normalizeToolCall(event.toolCall as Partial<ToolCallContentBlock>);
      } else if (typeof event.id === "string" || typeof event.toolName === "string") {
        // 真实 pi 扁平形态：顶层 id/toolName（docs/rpc.md），args 随 delta 增量
        b.toolCall = { id: event.id ?? "", name: event.toolName ?? "", arguments: "" };
      }
      break;
    }
    case "toolcall_delta": {
      const b = ensureBlock(a, event.contentIndex, "toolCall");
      if (!b.toolCall) {
        b.toolCall = { id: "", name: "", arguments: "" };
      }
      b.toolCall.arguments += event.delta;
      break;
    }
    case "toolcall_end": {
      const b = ensureBlock(a, event.contentIndex, "toolCall");
      b.toolCall = normalizeToolCall(event.toolCall);
      break;
    }
  }
  return a.blocks;
}

function normalizeToolCall(toolCall: Partial<ToolCallContentBlock>): { id: string; name: string; arguments: string } {
  const args = toolCall.arguments;
  const argsText =
    typeof args === "string"
      ? args
      : args
        ? JSON.stringify(args)
        : "";
  return {
    id: toolCall.id ?? "",
    name: toolCall.name ?? "",
    arguments: argsText,
  };
}

/** 从权威的 AssistantMessage content 块构造展示块（message_end 时使用）。 */
export function blocksFromMessage(content: unknown[]): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (typeof block !== "object" || block === null) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ kind: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({ kind: "thinking", text: block.thinking });
    } else if (block.type === "toolCall") {
      blocks.push({
        kind: "toolCall",
        text: "",
        toolCall: normalizeToolCall(block as unknown as Partial<ToolCallContentBlock>),
      });
    }
  }
  return blocks;
}
