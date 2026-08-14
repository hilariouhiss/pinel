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

export interface UiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
}

export interface TodoTask {
  id: number;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  description?: string;
  activeForm?: string;
}

/** 与宿主协议 SlashCommand 镜像（get_commands 结果）。 */
export interface SlashCommand {
  name: string;
  description?: string;
  source?: string;
}

/** 问卷题目（ask_user_question 工具参数防御解析后）。 */
export interface QuestionnaireQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect: boolean;
}

export type QuestionnaireAnswer =
  | { kind: "option"; optionIndex: number }
  | { kind: "multi"; optionIndices: number[] }
  | { kind: "custom"; text: string };

export type QuestionnairePhase = "answering" | "reviewing" | "submitting" | "submitted";

/** 问卷视图（宿主权威状态的镜像）。 */
export interface QuestionnaireView {
  questions: QuestionnaireQuestion[];
  answers: Array<QuestionnaireAnswer | null>;
  phase: QuestionnairePhase;
}

export type HostMessage =
  | { type: "snapshot"; messages: ChatMessage[]; status: ChatStatus; pendingUi: UiRequest[]; todos: TodoTask[]; commands: SlashCommand[]; questionnaire: QuestionnaireView | null }
  | { type: "stream"; blocks: StreamBlock[] }
  | { type: "message"; message: ChatMessage }
  | { type: "tool"; tool: ToolCard }
  | { type: "status"; status: ChatStatus }
  | { type: "uiRequest"; request: UiRequest }
  | { type: "uiResolved"; id: string }
  | { type: "uiCleared" }
  | { type: "todos"; todos: TodoTask[] }
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "questionnaire"; questionnaire: QuestionnaireView }
  | { type: "questionnaireCleared" }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };

export interface Attachment {
  id: number;
  data: string; // base64，不含 data: 前缀
  mimeType: string;
}
