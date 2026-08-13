/** 与宿主 ChatController 对齐的消息协议类型（webview 侧镜像）。 */

export interface ModelInfo {
  id?: string;
  name?: string;
  provider?: string;
  [key: string]: unknown;
}

export type ProcessState = "stopped" | "starting" | "running" | "error" | "no-workspace";

export interface ChatStatus {
  processState: ProcessState;
  isStreaming: boolean;
  isCompacting: boolean;
  model: ModelInfo | null;
  thinkingLevel: string;
  error?: string;
  steering: string[];
  followUp: string[];
}

export interface ToolCallRef {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamBlock {
  kind: "text" | "thinking" | "toolCall";
  text: string;
  toolCall?: ToolCallRef;
}

export interface ToolCard {
  toolCallId: string;
  toolName: string;
  argsText: string;
  status: "running" | "done" | "error";
  output: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  toolCallId?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: string;
  content: string | ContentBlock[] | unknown;
  isError?: boolean;
  toolCallId?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export type HostMessage =
  | { type: "snapshot"; messages: ChatMessage[]; status: ChatStatus }
  | { type: "stream"; blocks: StreamBlock[] }
  | { type: "message"; message: ChatMessage }
  | { type: "tool"; tool: ToolCard }
  | { type: "status"; status: ChatStatus }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };

export interface Attachment {
  id: number;
  data: string; // base64，不含 data: 前缀
  mimeType: string;
}
