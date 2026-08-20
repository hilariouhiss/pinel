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
  /** 队列模式（set_steering_mode），默认 all。 */
  steeringMode: string;
  /** 跟进模式（set_follow_up_mode），默认 one-at-a-time。 */
  followUpMode: string;
  /** 自动压缩（set_auto_compaction），默认 true。 */
  autoCompactionEnabled: boolean;
  /** 当前会话文件路径（get_state.sessionFile；会话历史高亮用）。 */
  sessionFile?: string;
  /** 会话信息条开关（pinel.showSessionStats 配置镜像；UI 偏好不依赖 pi 运行）。 */
  showSessionStats?: boolean;
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

/** 会话列表项（宿主 SessionHistoryProvider 镜像）。 */
export interface SessionListItem {
  path: string;
  id: string;
  created?: number;
  modified: number;
  name?: string;
  preview?: string;
  truncated: boolean;
}

/** 工作区文件项（@ 添加文件列表镜像）。 */
export interface FileItem {
  path: string;
  isImage: boolean;
}

/** 可 fork 的历史用户消息项（宿主 get_fork_messages 防御解析结果镜像）。 */
export interface ForkMessageItem {
  entryId: string;
  text: string;
}

/** 会话统计（宿主 parseSessionStats 镜像；contextUsage.tokens/percent 可为 null）。 */
export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** 工作区 git 状态（宿主 readGitStatus 结果镜像；null = git 不可用/非仓库）。 */
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  trackedChanges: boolean;
  untracked: boolean;
}

/** 会话信息条环境段（文件夹名 + git 状态）；随 sessionEnv 消息广播。 */
export interface SessionEnv {
  folderName: string | null;
  git: GitStatus | null;
}

export type HostMessage =
  | { type: "snapshot"; messages: ChatMessage[]; status: ChatStatus; pendingUi: UiRequest[]; todos: TodoTask[]; commands: SlashCommand[]; questionnaire: QuestionnaireView | null; sessionTitle: string | undefined; sessionStats: SessionStats | null; sessionEnv: SessionEnv }
  | { type: "stream"; blocks: StreamBlock[] }
  | { type: "message"; message: ChatMessage }
  | { type: "tool"; tool: ToolCard }
  | { type: "status"; status: ChatStatus }
  | { type: "uiRequest"; request: UiRequest }
  | { type: "uiResolved"; id: string }
  | { type: "uiCleared" }
  | { type: "todos"; todos: TodoTask[] }
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "models"; models: ModelInfo[] }
  | { type: "thinkingLevels"; levels: string[] }
  | { type: "questionnaire"; questionnaire: QuestionnaireView }
  | { type: "questionnaireCleared" }
  | { type: "sessionSwitching"; switching: boolean }
  | { type: "sessionListChanged" }
  | { type: "sessionListRefresh" }
  | { type: "sessionStats"; stats: SessionStats | null }
  | { type: "sessionEnv"; env: SessionEnv }
  | { type: "sessionList"; items: SessionListItem[]; currentSessionFile?: string }
  | { type: "triggerEditPrompt" }
  | { type: "fillPrompt"; text: string }
  | { type: "sessionTitle"; title: string | undefined }
  | { type: "fileList"; items: FileItem[]; truncated: boolean }
  | { type: "forkMessages"; messages: ForkMessageItem[] }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };

export interface Attachment {
  id: number;
  data: string; // base64，不含 data: 前缀
  mimeType: string;
}
