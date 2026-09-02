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
  /** 自动压缩阈值回显（百分比；null = 尚未换算/读取失败，输入框占位）。 */
  autoCompactPercent: number | null;
  /** 自动提交（pi settings.json pinel.autoCommit 镜像；开启时插件注入提示词）。 */
  autoCommitEnabled: boolean;
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
  /** subagent 工具专属信息（与宿主 SubagentCardInfo 手工同步）。 */
  subagent?: SubagentCardInfo;
}

export type SubagentCardStatus = "running" | "completed" | "error" | "background" | "stopped";

export interface SubagentCardInfo {
  description: string;
  subagentType: string | null;
  /** null = 继承主会话（显示 main model）。 */
  model: string | null;
  /** null = 继承主会话（显示 main level）。 */
  thinking: string | null;
  status: SubagentCardStatus;
  activity: string | null;
  turnCount: number | null;
  toolUses: number | null;
  tokens: string | null;
  durationMs: number | null;
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
  /** bashExecution 消息（! / !! 终端命令卡片）字段；exitCode null = 运行中。 */
  command?: string;
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  excludeFromContext?: boolean;
  /** 乐观卡本地键（pi 权威消息无此字段；快照替换后自然消失）。 */
  pinelBashId?: string;
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

/** 问卷视图（宿主权威状态的镜像）。id：问卷实例稳定标识，webview 重入判定按 id 比较
 * （postMessage 结构化克隆使 questions 引用比较恒为真）。 */
export interface QuestionnaireView {
  id: string;
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

/** 扩展作用域/类型（与宿主 extensions.ts 对齐）。 */
export type ExtensionScope = "global" | "project";
export type ExtensionKind = "local" | "package";

/** pi 智能体扩展列表项（宿主扫描结果镜像）。 */
export interface ExtensionItem {
  /** 唯一键：本地 = 入口文件绝对路径（不含 .disabled）；包 = source spec。 */
  id: string;
  kind: ExtensionKind;
  name: string;
  scope: ExtensionScope;
  enabled: boolean;
  /** 包对象形式仅部分过滤。 */
  filtered?: boolean;
  /** 卸载目标：本地 = 文件/目录绝对路径；包 = source spec。 */
  source: string;
  /** 来源类型徽标（包 = npm/git/path；本地散文件扩展无）。 */
  sourceKind?: "npm" | "git" | "path";
  /** 已装版本（安装目录 package.json 的 version；本地散文件扩展无）。 */
  version?: string;
  /** 更新态（extensionUpdates 消息合并产物；缺省 = 未检查）。 */
  update?: "available" | "current" | "unknown";
  /** npm 远端最新版（update=available 时有值）。 */
  latestVersion?: string;
}

/** 扩展更新检查条目（宿主 extensionUpdates 消息载荷；webview 按行键合并进 items）。 */
export interface ExtensionUpdateEntry {
  id: string;
  kind: ExtensionKind;
  scope: ExtensionScope;
  status: "available" | "current" | "unknown";
  latestVersion?: string;
}

/** 插件目录兼容性判定（宿主 catalog 镜像）。 */
export type CatalogCompat = "ok" | "limited" | "tui-only";

/** 插件目录项（含安装态；宿主 CatalogItemState 镜像）。 */
export interface CatalogItem {
  id: string;
  name: string;
  group: "pi-packages" | "rpiv-mono";
  description: string;
  installSpec: string;
  compat: CatalogCompat;
  compatNote?: string;
  defaultSet?: boolean;
  /** 推荐安装集成员（目录视图 Recommended 分组）。 */
  recommended?: boolean;
  state: "installed" | "available";
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

/** Pinel 插件（npm 包）安装态。 */
export type PinelPluginState = "installed" | "offer" | "removed";

/** ponytail 状态（宿主 parsePonytailStatus 产物镜像；statusKey "ponytail" 帧）。 */
export interface PonytailStatus {
  /** 实心点=激活（agent 运行中）；空心点=已启用空闲。 */
  active: boolean;
  /** 当前档位（lite/full/ultra/off）。 */
  mode: string;
}

/** pinel.mcp 服务器行（插件快照 + 配置 scope；statusKey "pinel.mcp" 帧）。 */
export interface PinelMcpServer {
  name: string;
  status:
    | "connected"
    | "disabled"
    | "needs-auth"
    | "failed"
    | "cached"
    | "not-connected"
    | "unknown";
  /** global = 全局配置；project = 项目配置（.mcp.json / .pi/mcp.json）。 */
  scope: "global" | "project";
  toolCount?: number;
  disabled?: boolean;
}

/** pinel.mcp 载荷（MCP 服务器明细；chip 计数 + 弹层明细数据源）。 */
export interface PinelMcp {
  v: 1;
  servers: PinelMcpServer[];
}

/** pinel.workflow 载荷（rpiv-workflow 生命周期推送；宿主防御解析后广播）。 */
export interface PinelWorkflow {
  v: 1;
  runId: string;
  workflow: string;
  totalStages: number;
  status: "running" | "awaiting-approval" | "done" | "failed";
  stage?: string;
  stageNumber?: number;
  message?: string;
}

/** 提示词组成段（chars 全量字符；preview 预览文本）。 */
export interface PinelPromptSection {
  chars: number;
  preview: string;
}

/** 组成文件（level：user=用户级 agentDir 下；project=项目级）。 */
export interface PinelPromptFile {
  level: "user" | "project";
  name: string;
  path: string;
  chars: number;
  preview: string;
}

/** pinel.prompt 载荷（提示词组成；插件推送 → 宿主解析广播）。
 *  startup=true 为启动帧：仅 files（session_start 预估扫描），
 *  system/counts/finalChars 缺省，首轮权威全帧到达后覆盖。 */
export interface PinelPrompt {
  v: 1;
  startup?: true;
  system?: PinelPromptSection & { kind: "default" | "custom" };
  files: PinelPromptFile[];
  append?: PinelPromptSection;
  counts?: { guidelines: number; skills: number; tools: number };
  injected?: PinelPromptSection;
  injectedUnknown?: true;
  finalChars?: number;
}

export type HostMessage =
  | { type: "snapshot"; messages: ChatMessage[]; status: ChatStatus; pendingUi: UiRequest[]; todos: TodoTask[]; commands: SlashCommand[]; questionnaire: QuestionnaireView | null; sessionTitle: string | undefined; sessionStats: SessionStats | null; sessionEnv: SessionEnv; pinelWorkflow: PinelWorkflow | null; pinelPrompt: PinelPrompt | null; pinelPluginState: PinelPluginState | null; ponytailStatus: PonytailStatus | null; pinelMcp: PinelMcp | null }
  | { type: "stream"; blocks: StreamBlock[] }
  | { type: "message"; message: ChatMessage }
  | { type: "bash"; message: ChatMessage }
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
  | { type: "extensionList"; items: ExtensionItem[] }
  | { type: "extensionUpdates"; entries: ExtensionUpdateEntry[] }
  | { type: "catalogState"; entries: CatalogItem[] }
  | { type: "pinelWorkflow"; workflow: PinelWorkflow | null }
  | { type: "pinelPrompt"; prompt: PinelPrompt | null }
  | { type: "pinelPluginState"; state: PinelPluginState }
  | { type: "ponytailStatus"; status: PonytailStatus }
  | { type: "pinelMcp"; mcp: PinelMcp | null }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };

export interface Attachment {
  id: number;
  data: string; // base64，不含 data: 前缀
  mimeType: string;
}
