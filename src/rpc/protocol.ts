/**
 * RPC 协议类型定义 — 对齐 `pi --mode rpc` 的 JSONL 协议（docs/rpc.md）。
 *
 * 协议要点（与官方文档逐项对齐）：
 * - 记录以 `\n`（LF）为唯一分隔符；容忍尾部 `\r`；禁止 Node `readline`
 *   （它会将 U+2028/U+2029 当作换行，违反协议）。
 * - 每个命令可带自增 `id`，响应带同 `id`；不带 id 的响应按 `command` 字段兜底关联。
 * - 图片格式为 `{"type":"image","data":<base64>,"mimeType":...}`——
 *   注意与 SDK 的 `source:{type:"base64",...}` 不同。
 * - `message_update` 不携带累计消息：客户端必须用 `message_start` +
 *   按 `contentIndex` 的增量自行组装部分消息，以 `message_end.message` 为权威。
 * - `agent_end` 只是单次低层 agent run 完成（后续仍可能有 retry/compaction/
 *   排队 continuation）；`agent_settled` 才是最终空闲信号。
 */

// ---------------------------------------------------------------------------
// 基础帧
// ---------------------------------------------------------------------------

/** 任意 RPC 记录（命令 / 响应 / 事件）。 */
export interface RpcRecord {
  type: string;
  id?: string;
  [key: string]: unknown;
}

/** 命令响应帧。 */
export interface RpcResponse extends RpcRecord {
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// 内容块与消息
// ---------------------------------------------------------------------------

export interface ImageContent {
  type: "image";
  /** base64 编码的图片数据（不含 data: 前缀）。 */
  data: string;
  mimeType: string;
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ThinkingContentBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContentBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export type AssistantContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ToolCallContentBlock;

export interface Model {
  id: string;
  name: string;
  provider: string;
  [key: string]: unknown;
}

export interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | string;
  content: string | Array<TextContentBlock | ImageContent | AssistantContentBlock | Record<string, unknown>>;
  timestamp?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 命令（客户端 → pi）
// ---------------------------------------------------------------------------

export interface PromptCommand {
  type: "prompt";
  message: string;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
}

export interface SteerCommand {
  type: "steer";
  message: string;
  images?: ImageContent[];
}

export interface AbortCommand {
  type: "abort";
}

export interface GetStateCommand {
  type: "get_state";
}

export interface GetMessagesCommand {
  type: "get_messages";
}

export interface GetAvailableModelsCommand {
  type: "get_available_models";
}

/** 切换到指定模型（列表选择；响应为完整 Model 对象，不含 thinkingLevel——
 * pi 内部会 re-clamp 思考等级并持久化到 settings，客户端需 get_state 回读刷新）。 */
export interface SetModelCommand {
  type: "set_model";
  provider: string;
  modelId: string;
}

export interface CycleModelCommand {
  type: "cycle_model";
}

export interface GetAvailableThinkingLevelsCommand {
  type: "get_available_thinking_levels";
}

export interface SetThinkingLevelCommand {
  type: "set_thinking_level";
  level: string;
}

export interface CycleThinkingLevelCommand {
  type: "cycle_thinking_level";
}

export interface SetSteeringModeCommand {
  type: "set_steering_mode";
  mode: "all" | "one-at-a-time";
}

export interface SetFollowUpModeCommand {
  type: "set_follow_up_mode";
  mode: "all" | "one-at-a-time";
}

export interface SetAutoCompactionCommand {
  type: "set_auto_compaction";
  enabled: boolean;
}

export interface GetCommandsCommand {
  type: "get_commands";
}

/** 切换到指定会话文件（会话历史列表选择；可被 session_before_switch 扩展钩子取消）。 */
export interface SwitchSessionCommand {
  type: "switch_session";
  sessionPath: string;
}

/** 新建会话（可被 session_before_switch 扩展钩子取消）。 */
export interface NewSessionCommand {
  type: "new_session";
}

/** switch_session/new_session 响应（data.cancelled：扩展钩子取消时 true）。 */
export interface SessionSwitchData {
  cancelled: boolean;
}

/**
 * 设置当前会话显示名（会话重命名链路）。
 * 注意：docs/rpc.md 未收录此命令（文档漂移），实测 pi 0.84.x 实现：
 * trim 后空名报错 "Session name cannot be empty"，成功响应无 data；
 * 仅作用于当前会话（setSessionName → appendSessionInfo 落盘 session_info 条目）。
 */
export interface SetSessionNameCommand {
  type: "set_session_name";
  name: string;
}

/** 获取会话统计（get_session_stats；docs/rpc.md 已收录）。纯拉取式，无推送事件。 */
export interface GetSessionStatsCommand {
  type: "get_session_stats";
}

/** get_session_stats 响应 tokens（total = input+output+cacheRead+cacheWrite）。 */
export interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * 上下文占用。无模型/模型无 contextWindow 时整个 contextUsage 字段缺省；
 * 压缩后无新的有效 assistant 响应时 tokens/percent 为 null（估算不可信，
 * 待下次 LLM 响应恢复——对齐 pi agent-session.js getContextUsage）。
 */
export interface SessionContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/**
 * get_session_stats 响应 data（docs/rpc.md 已收录）。
 * 聚合全会话条目（含被压缩掉的历史），token/成本反映实际计费。
 * 除 tokens 外均容缺（防御解析见 src/chat/session-stats.ts）。
 */
export interface SessionStatsData {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens: SessionTokens;
  cost?: number;
  contextUsage?: SessionContextUsage;
}

export type ClientCommand =
  | PromptCommand
  | SteerCommand
  | AbortCommand
  | GetStateCommand
  | GetMessagesCommand
  | GetAvailableModelsCommand
  | SetModelCommand
  | CycleModelCommand
  | GetAvailableThinkingLevelsCommand
  | SetThinkingLevelCommand
  | CycleThinkingLevelCommand
  | SetSteeringModeCommand
  | SetFollowUpModeCommand
  | SetAutoCompactionCommand
  | GetCommandsCommand
  | SwitchSessionCommand
  | NewSessionCommand
  | SetSessionNameCommand
  | GetSessionStatsCommand;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export interface SessionState {
  /** 当前模型（Model 对象），未认证/无可用模型时为 null。 */
  model: Model | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
}

export interface GetMessagesData {
  messages: AgentMessage[];
}

export interface GetAvailableModelsData {
  models: Model[];
}

/** get_available_thinking_levels 响应；不支持思考的模型返回 ["off"]。 */
export interface GetAvailableThinkingLevelsData {
  levels: string[];
}

/**
 * cycle_model 响应（pi 切换模型时会重新锎制思考等级，需同步更新 thinkingLevel）。
 * 仅一个可用模型时为 null（rpc-mode.js：cycleModel 返回 undefined → success+data:null）。
 * isScoped：是否为项目 scoped 模型（类型预留，当前 UI 不渲染）。
 */
export interface CycleModelData {
  model: Model;
  thinkingLevel: string;
  isScoped: boolean;
}

/** cycle_thinking_level 响应；模型不支持思考时为 null。 */
export interface CycleThinkingLevelData {
  level: string;
}

/**
 * get_commands 返回的斜杠命令（防御解析见 src/chat/commands.ts）。
 *
 * 文档漂移注：pi 0.84.x 实际返回字段为 name/description/source/sourceInfo
 * （dist/modes/rpc/rpc-mode.js），而 docs/rpc.md 示例写的是 path/location——
 * 协议类型以实测实现为准，sourceInfo 本版本不使用，预留 unknown。
 */
export interface SlashCommand {
  name: string;
  description?: string;
  /** extension | prompt | skill；pi 未来可能新增来源，不写死联合类型（UI 有兜底徽标）。 */
  source?: string;
  sourceInfo?: unknown;
}

export interface GetCommandsData {
  commands: SlashCommand[];
}

// ---------------------------------------------------------------------------
// 事件（pi → 客户端）
// ---------------------------------------------------------------------------

export interface AgentStartEvent {
  type: "agent_start";
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
  willRetry: boolean;
}

export interface AgentSettledEvent {
  type: "agent_settled";
}

export interface MessageStartEvent {
  type: "message_start";
  message: AgentMessage;
}

export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

/**
 * `message_update` 携带的增量事件。
 * 客户端按 contentIndex 组装部分消息（thinking 与 text 多块交替时
 * 不能简单追加 delta）。
 */
export type AssistantDeltaEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; thinking?: string }
  | { type: "toolcall_start"; contentIndex: number; toolCall?: Partial<ToolCallContentBlock> }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContentBlock };

export interface MessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent: AssistantDeltaEvent;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** 累计输出（不是增量），客户端直接替换显示即可。 */
  partialResult: { content: TextContentBlock[]; details?: Record<string, unknown> };
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: { content: TextContentBlock[]; details?: Record<string, unknown> };
  isError: boolean;
}

export interface QueueUpdateEvent {
  type: "queue_update";
  steering: string[];
  followUp: string[];
}

export interface CompactionEvent {
  type: "compaction_start" | "compaction_end";
}

export interface AutoRetryEvent {
  type: "auto_retry_start" | "auto_retry_end";
}

export interface ExtensionErrorEvent {
  type: "extension_error";
  [key: string]: unknown;
}

/**
 * 扩展 UI 子协议请求（stdout）。
 *
 * 对话框方法（select/confirm/input/editor）会阻塞等待客户端返回
 * `extension_ui_response`；若无应答，agent 会永久阻塞（无 timeout 时）。
 * fire-and-forget 方法（notify/setStatus/setWidget/setTitle/set_editor_text）
 * 不期待响应。
 */
export interface ExtensionUiRequest extends RpcRecord {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  [key: string]: unknown;
}

/** 对话框方法集合（需要回复，否则 agent 阻塞）。 */
export const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface ExtensionUiResponse {
  type: "extension_ui_response";
  id: string;
  cancelled?: true;
  value?: string;
  confirmed?: boolean;
}

export type RpcEvent =
  | AgentStartEvent
  | AgentEndEvent
  | AgentSettledEvent
  | MessageStartEvent
  | MessageEndEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | QueueUpdateEvent
  | CompactionEvent
  | AutoRetryEvent
  | ExtensionErrorEvent
  | ExtensionUiRequest
  | RpcRecord;
