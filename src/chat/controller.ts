import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient, resolveSpawnSpec, runPiCommand } from "../rpc/client";
import { PromptEditorManager } from "./prompt-editor";
import { parseSessionMeta, scanSessions, toItem, resolveSessionsRoot, appendSessionName } from "./session-history";
import { scanWorkspaceFiles, imageMimeType, isImageFile, type FileItem, type ScanResult } from "./file-scanner";
import {
  DIALOG_UI_METHODS,
  type AgentMessage,
  type AssistantDeltaEvent,
  type ClientCommand,
  type CycleModelData,
  type CycleThinkingLevelData,
  type CloneCommand,
  type ExtensionUiRequest,
  type ForkCommand,
  type ForkMessage,
  type ForkMessagesData,
  type GetAvailableModelsData,
  type GetAvailableThinkingLevelsData,
  type GetCommandsData,
  type GetMessagesData,
  type ImageContent,
  type Model,
  type NewSessionCommand,
  type QueueUpdateEvent,
  type RpcEvent,
  type RpcRecord,
  type SessionState,
  type SessionStatsData,
  type SlashCommand,
  type SwitchSessionCommand,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
} from "../rpc/protocol";
import { applyDelta, createAssembly, type StreamBlock } from "./stream-assembly";
import { DEFAULT_RESERVE_TOKENS, parseSessionStats, percentToReserveTokens, reserveTokensToPercent } from "./session-stats";
import { isDuplicateNotice } from "./notice-dedup";
import { parsePinelState, parsePinelTree, type PinelStatePayload, type PinelTreePayload } from "./pinel-payload";
import {
  PINEL_PACKAGE_SOURCE,
  agentSettingsPath,
  decidePinelPluginState,
  readAgentPackages,
  type PinelPluginState,
} from "./pinel-install";
import { readGitStatus, type GitStatus } from "./git-status";
import { parseTodoTasks, type TodoTask } from "./todos";
import { buildSubagentCard, applySubagentDetails, type SubagentCardInfo } from "./subagents";
import { parseCommands } from "./commands";
import { parseForkMessages } from "./fork-messages";
import { parseModels, parseThinkingLevels } from "./models";
import type { SessionListItem } from "./session-history";
import {
  defaultAgentDir,
  projectConfigDir,
  readSettings,
  removePackageFromSettings,
  scanLocalExtensions,
  scanPackages,
  setLocalExtensionEnabled,
  setPackageEnabled,
  uninstallLocalExtension,
  filterExtensionView,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionScope,
  type ExtensionView,
  writeSettings,
} from "./extensions";
import { catalogInstallState, getCatalog, installedIdentities, type CatalogEntry } from "./catalog";

/** 目录项 + 安装态（webview 协议镜像；字段定义见 webview-ui/src/types.ts）。 */
export type CatalogItemState = CatalogEntry & { state: "installed" | "available" };
import {
  inputResponseFor,
  parseQuestionnaireAnswer,
  parseQuestionnaireArgs,
  selectResponseFor,
  titleMatchesQuestion,
  type QuestionnaireAnswer,
  type QuestionnaireQuestion,
  type QuestionnaireView,
} from "./questionnaire";

export type ProcessState = "stopped" | "starting" | "running" | "error" | "no-workspace";

export interface ChatStatus {
  processState: ProcessState;
  isStreaming: boolean;
  isCompacting: boolean;
  model: Model | null;
  thinkingLevel: string;
  /** 队列模式（set_steering_mode），默认 all（docs/rpc.md get_state 示例）。 */
  steeringMode: string;
  /** 跟进模式（set_follow_up_mode），默认 one-at-a-time。 */
  followUpMode: string;
  /** 自动压缩（set_auto_compaction），默认 true。 */
  autoCompactionEnabled: boolean;
  /** 自动压缩阈值回显（百分比；null = 尚未换算/读取失败，webview 占位）。 */
  autoCompactPercent: number | null;
  /** 会话信息条开关（pinel.showSessionStats 配置镜像；UI 偏好不依赖 pi 运行）。 */
  showSessionStats?: boolean;
  /** 当前会话文件路径（get_state.sessionFile；会话历史列表高亮用）。 */
  sessionFile?: string;
  error?: string;
  steering: string[];
  followUp: string[];
}

export interface ToolCard {
  toolCallId: string;
  toolName: string;
  argsText: string;
  status: "running" | "done" | "error";
  output: string;
  /** subagent 工具专属信息（模型/思考/统计）；其他工具无此字段。 */
  subagent?: SubagentCardInfo;
}

/** 会话信息条环境段（工作区文件夹名 + 富化 git 状态）；随 sessionEnv 消息广播。 */
export interface SessionEnv {
  /** 工作区文件夹名（workspaceRoot basename）；无 workspace 时 null（防御性）。 */
  folderName: string | null;
  /** 富化 git 状态（分支/ahead/behind/改动/未跟踪）；非仓库/不可用 → null。 */
  git: GitStatus | null;
}

export type OutMessage =
  | { type: "snapshot"; messages: AgentMessage[]; status: ChatStatus; pendingUi: ExtensionUiRequest[]; todos: TodoTask[]; commands: SlashCommand[]; questionnaire: QuestionnaireView | null; sessionTitle: string | undefined; sessionStats: SessionStatsData | null; sessionEnv: SessionEnv; pinelState: PinelStatePayload | null; pinelTree: PinelTreePayload | null; pinelPluginState: PinelPluginState | null }
  | { type: "stream"; blocks: StreamBlock[] }
  | { type: "message"; message: AgentMessage }
  | { type: "tool"; tool: ToolCard }
  | { type: "status"; status: ChatStatus }
  | { type: "uiRequest"; request: ExtensionUiRequest }
  | { type: "uiResolved"; id: string }
  | { type: "uiCleared" }
  | { type: "todos"; todos: TodoTask[] }
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "models"; models: Model[] }
  | { type: "thinkingLevels"; levels: string[] }
  | { type: "questionnaire"; questionnaire: QuestionnaireView }
  | { type: "questionnaireCleared" }
  | { type: "sessionSwitching"; switching: boolean }
  | { type: "sessionListChanged" }
  | { type: "sessionListRefresh" }
  | { type: "sessionStats"; stats: SessionStatsData | null }
  | { type: "sessionEnv"; env: SessionEnv }
  | { type: "triggerEditPrompt" }
  | { type: "fillPrompt"; text: string }
  | { type: "sessionTitle"; title: string | undefined }
  | { type: "fileList"; items: FileItem[]; truncated: boolean }
  | { type: "sessionList"; items: SessionListItem[]; currentSessionFile?: string }
  | { type: "forkMessages"; messages: ForkMessage[] }
  | { type: "extensionList"; items: ExtensionItem[]; projectAvailable: boolean }
  | { type: "catalogState"; entries: CatalogItemState[] }
  | { type: "pinelState"; state: PinelStatePayload }
  | { type: "pinelTree"; tree: PinelTreePayload }
  | { type: "pinelPluginState"; state: PinelPluginState }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };

interface PromptInput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  /** @ 文件引用（相对 workspace 根路径；发送时 pinel 自读自拼——RPC 模式 pi 不支持 @file）。 */
  fileRefs?: string[];
  /** 控制消息（/pinel-* 扩展命令）：不乐观渲染用户消息（实测不写会话条目）。 */
  control?: boolean;
}

/**
 * 活动问卷（宿主权威状态；webview 只拿 QuestionnaireView 镜像）。
 * 回填游标：插件逐题串行阻塞，pi 的对话框按题序逐一到达，
 * cursor 指向下一待回填题目；awaitingFollowup 表示已回哨兵行、
 * 等待本题的跟进 input（自定义答案）——游标停留本题直至跟进消费。
 */
interface ActiveQuestionnaire extends QuestionnaireView {
  buffered: ExtensionUiRequest[];
  cursor: number;
  awaitingFollowup: boolean;
}

const initialStatus: ChatStatus = {
  processState: "stopped",
  isStreaming: false,
  isCompacting: false,
  model: null,
  thinkingLevel: "medium",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  autoCompactPercent: null,
  showSessionStats: false,
  steering: [],
  followUp: [],
};

function safeArgsText(args: unknown): string {
  if (typeof args === "string") {
    return args;
  }
  if (args && typeof args === "object") {
    try {
      const text = JSON.stringify(args);
      return text.length > 400 ? text.slice(0, 400) + "…" : text;
    } catch {
      // 循环引用等，忽略
    }
  }
  return "";
}

/** 对话框标题是否匹配任一题目（取消竞态补偿与 requestMatchesQuestionnaire 共用）。 */
function matchesQuestionnaireTitles(title: string | undefined, questions: QuestionnaireQuestion[]): boolean {
  return questions.some((question) => titleMatchesQuestion(title, question));
}

/**
 * 聊天会话控制器：持有 pi RPC 子进程的生命周期、消息缓冲、流式装配状态，
 * 并把一切变化广播为 OutMessage（由面板转发给 webview）。
 */
export class ChatController {
  readonly onChange = new vscode.EventEmitter<OutMessage>();
  private readonly output: vscode.OutputChannel;

  private client: RpcClient | null = null;
  private status: ChatStatus = { ...initialStatus };
  /** 最近一次会话统计（get_session_stats 解析结果；切换/重启时清空）。 */
  private sessionStats: SessionStatsData | null = null;
  /** 会话信息条环境段（文件夹名 + git 状态；重启不重置，随 refreshSessionEnv 刷新）。 */
  private sessionEnv: SessionEnv = { folderName: null, git: null };
  /** git 状态刷新去抖定时器（保存文件后合并短时间多次触发）。 */
  private gitRefreshTimer: NodeJS.Timeout | null = null;
  private messages: AgentMessage[] = [];
  private partialBlocks: StreamBlock[] = [];
  private tools = new Map<string, ToolCard>();
  /** 当前流式消息的角色（message_start 设置，全 role 防旧值残留）；
   *  message_update 仅对 assistant 应用——防御 pi 未来对用户消息发 delta。 */
  private currentStreamRole = "assistant";
  /** pi 事件来源的 message 广播计数（乐观渲染不计入；测试断言 user 恒为 0）。 */
  private messageEventCounts = { user: 0, assistant: 0, toolResult: 0 };
  private startPromise: Promise<void> | null = null;
  private workspaceRoot: string | undefined;
  private streamStartCount = 0;
  private settledCount = 0;
  private restarting = false;
  private disposed = false;
  /** 最近一条已展示通知（同文本同级别 300ms 窗口去重；pi 双重 emit 的扩展通知）。 */
  private lastNotice: { level: "info" | "warning" | "error"; text: string; at: number } | null = null;
  private workspaceWatcher: vscode.Disposable;
  /** 会话信息开关配置监听（dispose 释放）。 */
  private configWatcher: vscode.Disposable;
  /** 保存文件监听（脏标记随保存实时更新；dispose 释放）。 */
  private saveWatcher: vscode.Disposable;
  /** 是否已触发过自动重启自愈（手动 restart 重置；置位后初始同步短路重试）。 */
  private modelHealRestarted = false;
  /** 最近一次初始状态同步中 get_state 的尝试次数（测试钩子）。 */
  private modelHealAttempts = 0;
  /** 待决的扩展对话框（按 id；同一时刻通常只有一个，pi 侧 dialog 阻塞 agent）。 */
  private pendingUi = new Map<string, ExtensionUiRequest>();
  /** todo 工具维护的任务快照（运行期内存态，restart 后随新进程重置）。 */
  private todos: TodoTask[] = [];
  /** 可用斜杠命令（get_commands 结果；空列表=未获取/获取失败，补全弹窗不弹出）。 */
  private commands: SlashCommand[] = [];
  /** 活动问卷（ask_user_question；null=无问卷，对话框走逐卡路径）。 */
  private questionnaire: ActiveQuestionnaire | null = null;
  /** 取消竞态补偿（zombie）：取消时首帧尚未缓冲（在途）→ 存题目快照供标题匹配，
   *  匹配帧到达即回 cancelled；仅用户取消路径置位，存活期毫秒级（首帧在途）。 */
  private questionnaireCancelPending: { questions: QuestionnaireQuestion[] } | null = null;
  /** 会话切换/新建 in-flight（防连点重入）。 */
  private sessionSwitching = false;
  /** 提示词编辑器管理（Ctrl+G：VS Code 原生编辑器编辑提示词并回填）。 */
  private promptEditor: PromptEditorManager;
  /** 当前会话标题（session_info.name 解析缓存；snapshot 携带供重放恢复）。 */
  private sessionTitleCache: string | undefined = undefined;
  /** 标题解析去重键（sessionFile 变化才触发解析；重放不重复）。 */
  private lastTitleSessionFile: string | undefined = undefined;
  /** Pinel 插件推送缓存（webview 重建后经 snapshot 重放）。 */
  private pinelStateCache: PinelStatePayload | null = null;
  private pinelTreeCache: PinelTreePayload | null = null;
  /** Pinel 插件（npm 包）安装态缓存；null = 未检测。 */
  private pinelPluginStateCache: PinelPluginState | null = null;
  /** 曾安装标记存储：vscode globalState 或内存兑底（无 globalState 时，测试）。 */
  private readonly pluginStateStore: { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> };

  constructor(output: vscode.OutputChannel, globalState?: vscode.Memento) {
    this.output = output;
    // 曾安装标记：优先 vscode globalState；缺省（测试直构）时内存兑底
    const memory = new Map<string, unknown>();
    this.pluginStateStore = globalState ?? {
      get: (key) => memory.get(key),
      update: async (key, value) => {
        memory.set(key, value);
      },
    };
    // 保存回填：临时文件保存 → 内容广播回输入框（fillPrompt）
    this.promptEditor = new PromptEditorManager((text) => this.fire({ type: "fillPrompt", text }));
    // 未打开文件夹时提示用户；打开文件夹后自动连接
    this.workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.status.processState === "no-workspace" && vscode.workspace.workspaceFolders?.length) {
        this.startPromise = null;
        void this.ensureStarted();
      }
    });
    // 会话信息开关：配置变更（手改 settings.json / 其他窗口同步）→ 更新状态 + 开启时首拉。
    // toggle 写配置后已直接更新 status，监听器比较新旧值自然跳过同值写入（无自触发双更新）
    this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("pinel.showSessionStats")) {
        return;
      }
      const enabled = this.readShowSessionStats();
      if (enabled === this.status.showSessionStats) {
        return; // 同值写入（toggle 已直接更新）：跳过
      }
      this.applyShowSessionStats(enabled);
    });
    // 保存文件 → 去抖刷新 git 状态（开关关闭时 refreshSessionEnv 内部短路）
    this.saveWatcher = vscode.workspace.onDidSaveTextDocument(() => this.scheduleGitRefresh());
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 懒启动：首次调用时 spawn pi RPC 子进程。 */
  ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.start();
    }
    return this.startPromise;
  }

  private async start(): Promise<void> {
    if (this.disposed) {
      return; // dispose 后禁止任何新 spawn（watcher/restart 并发防御）
    }
    const outcome = await this.startWithHeal();
    if (outcome === "abandoned") {
      return;
    }
    // ok / exhausted：进程已就绪，置 running（模型仍空时由 StatusBar 推导警告态）
    if (!this.client?.isRunning) {
      return; // 进程在同步期间已退出（handleExit 已置 error 态）：不覆盖
    }
    this.setProcessState("running");
    // Pinel 插件安装态检测（settings.json packages + 曾安装标记）：start 完成后首次广播
    void this.refreshPinelPluginState();
    // 会话信息开关：每次启动回读配置（restart 重置 status 后恢复，防静默复位）；
    // 开关开启时启动首拉一次（firstFetch=false 由 start 统一触发，避免双拉）
    const showStats = this.readShowSessionStats();
    this.applyShowSessionStats(showStats, false);
    if (showStats) {
      void this.refreshSessionStats();
      void this.refreshSessionEnv();
    }

    const client = this.client;
    if (!client) {
      return;
    }
    try {
      const data = await client.send<GetMessagesData>({ type: "get_messages" });
      this.messages = data.messages ?? [];
      this.fireSnapshot();
    } catch (err) {
      if (this.client !== client) {
        return; // 已被 restart 取代：静默放弃
      }
      this.notice("warning", `Failed to load history: ${(err as Error).message}`);
    }
    // 斜杠命令列表：fire-and-forget，不得阻塞/reject 启动流程（旧版 pi 会回 success:false）
    void this.fetchCommands();
  }

  /**
   * 启动 + 初始同步 + 自愈重启循环（至多自动重启一次）。
   * 自愈在本函数内顺序执行（不受 restarting 守卫限制——自愈常嵌套在手动
   * 重启链内，若走 restart() 入口会被防重入守卫拦截）；重启前校验本流程
   * 仍是权威启动（this.client === client），防手动 restart 并发接管。
   */
  private async startWithHeal(): Promise<"ok" | "exhausted" | "abandoned"> {
    for (;;) {
      const client = await this.spawnClient();
      if (!client) {
        return "abandoned";
      }
      const outcome = await this.syncInitialState(client);
      if (outcome !== "heal-needed") {
        return outcome;
      }
      if (this.disposed) {
        return "abandoned";
      }
      // 自愈：模型仍为空且未重启过 → 停止当前进程再启一次
      //（置位标记：下次同步短路为单次尝试，防止无限重启循环）
      this.modelHealRestarted = true;
      this.notice("info", "No model info received, auto-restarting pi…");
      if (this.client !== client) {
        return "abandoned"; // 已被手动重启接管：静默放弃，由新流程自行定论
      }
      this.client = null;
      await client.stop();
      if (this.disposed || this.client !== null) {
        return "abandoned"; // dispose 或并发 restart 已接管：不再继续本轮自愈 spawn
      }
    }
  }

  /** spawn 新 RpcClient 并绑定事件处理器。返回 null 表示放弃（no-workspace/spawn 失败/被取代）。 */
  private async spawnClient(): Promise<RpcClient | null> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      // 未打开文件夹：不是进程异常，用友好状态提示并引导用户
      this.status = {
        ...this.status,
        processState: "no-workspace",
        error: "No folder open. Open a folder to use Pinel.",
      };
      this.fire({ type: "status", status: this.status });
      this.notice("info", "No folder open: Pi will auto-connect once you open a folder.");
      return null;
    }
    this.workspaceRoot = root.uri.fsPath;
    this.setProcessState("starting");

    const command = this.resolvePiCommand();
    const client = new RpcClient();
    this.client = client;
    // 事件处理器绑定 client 身份：restart 后旧 client 的迟到事件
    //（exit/spawnError/record）一律忽略，避免污染新进程状态
    client.on("record", (r) => {
      if (this.client !== client) {
        return;
      }
      this.handleRecord(r);
    });
    client.on("spawnError", (err) => {
      if (this.client !== client) {
        return;
      }
      this.handleSpawnError(err);
    });
    client.on("exit", (code) => {
      if (this.client !== client) {
        return;
      }
      this.handleExit(code);
    });
    // stderr 有意不做身份过滤：append-only 诊断日志，旧进程停止期间的最后输出
    // 仍有诊断价值；不参与任何状态更新，不存在污染风险
    client.on("stderr", (line) => this.output.appendLine(line));

    try {
      // 自定义会话目录（pinel.sessionDir）：透传给 pi（--session-dir），
      // 会话历史视图用同一路径扫描（布局为 custom，无 cwd 子目录）
      const configured = vscode.workspace.getConfiguration("pinel").get<string>("sessionDir")?.trim();
      const extraArgs = configured ? ["--session-dir", configured] : undefined;
      await client.start(command, this.workspaceRoot, { ...process.env, PINEL_PLUGIN: "1" }, extraArgs);
    } catch (err) {
      if (this.client === client) {
        this.handleSpawnError(err as Error);
      }
      return null;
    }

    if (this.client !== client) {
      return null; // 已被 restart 取代：放弃本次启动流程
    }
    return client;
  }

  /**
   * 初始状态同步（自愈）：get_state 最多 4 次尝试（间隔 2s/5s/10s），
   * 给 pi 的认证/模型加载留出时间。已自动重启过则短路为单次尝试。
   * 结论：ok=拿到模型；heal-needed=尝试耗尽仍无模型（由 startWithHeal 触发重启）；
   * exhausted=自愈已用尽（进入警告态）；abandoned=放弃（dispose/被取代）。
   */
  private async syncInitialState(
    client: RpcClient,
  ): Promise<"ok" | "heal-needed" | "exhausted" | "abandoned"> {
    this.modelHealAttempts = 0;
    const maxAttempts = this.modelHealRestarted ? 1 : 4;
    const failures: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.disposed || this.client !== client) {
        return "abandoned"; // 已销毁/被取代：静默放弃，不发误导性状态
      }
      try {
        const state = await client.send<SessionState>({ type: "get_state" });
        this.modelHealAttempts++;
        this.applySessionState(state);
        if (this.status.model) {
          return "ok";
        }
        failures.push("model 为空");
      } catch (err) {
        if (this.client !== client) {
          return "abandoned"; // 已被 restart 取代：静默放弃
        }
        this.modelHealAttempts++;
        failures.push((err as Error).message);
      }
      if (attempt < maxAttempts) {
        await sleep([0, 2000, 5000, 10000][attempt]);
      }
    }

    if (this.disposed || this.client !== client) {
      return "abandoned";
    }

    // 尝试耗尽仍无模型：诊断输出（失败详情只进 Output，不在每次失败时 notice）；
    // 自愈重启入口由 startWithHeal 触发
    this.output.appendLine(`[warn] 模型自愈：get_state ${maxAttempts} 次尝试未获得模型（${failures.join("；")}）`);
    if (this.modelHealRestarted) {
      this.notice("warning", "No model info received: check pi auth (run pi in a terminal), or click Restart on the banner.");
      return "exhausted";
    }
    return "heal-needed";
  }

  /** 重启：杀掉旧进程并重新启动，随后用 get_messages 回放历史。 */
  async restart(): Promise<void> {
    if (this.disposed) {
      return; // dispose 后禁止重启（与 start() 的防御一致）
    }
    if (this.restarting) {
      return; // 防重入：忽略重启进行中的重复点击
    }
    // 手动重启：重置自愈标记，允许下轮自愈（自愈循环本身在 startWithHeal 内顺序执行）
    this.modelHealRestarted = false;
    this.restarting = true;
    try {
      const old = this.client;
      this.client = null;
      this.startPromise = null;
      this.tools.clear();
      this.partialAssembly = createAssembly();
      this.partialBlocks = [];
      this.status = { ...initialStatus };
      this.sessionStats = null; // 统计归属新进程会话：清空，start 首拉后填充
      this.pendingUi.clear();
      this.todos = [];
      this.commands = [];
      const staleQuestionnaire = this.questionnaire;
      this.questionnaire = null;
      this.questionnaireCancelPending = null; // 僵尸问卷随重启清空（新进程新回合）
      // 立即广播重置后的状态 + 清除对话框/待办/命令列表，让 UI 有即时反馈
      //（防止旧卡片在重启窗口内被应答，新进程可能复用同 id）
      this.fire({ type: "status", status: this.status });
      this.fire({ type: "uiCleared" });
      this.fire({ type: "todos", todos: this.todos });
      this.fire({ type: "commands", commands: this.commands });
      this.fire({ type: "questionnaireCleared" });
      // 问卷缓冲帧随旧进程死亡前主动补 cancelled（HIGH-2：与 settled 清理同理由，
      // 插件问卷无 timeout，pi 侧不会自动解锁；进程此刻仍存活，回复有意义）
      if (old && staleQuestionnaire) {
        const buffered = staleQuestionnaire.buffered.splice(0);
        for (const req of buffered) {
          old.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
        }
      }
      if (old) {
        await old.stop();
      }
      await this.ensureStarted();
      this.fireSnapshot();
    } finally {
      this.restarting = false;
    }
  }

  /** 关闭：终止整个进程树。 */
  async dispose(): Promise<void> {
    this.disposed = true; // 阻止 dispose 后 watcher/restart 再次 spawn（孤儿进程防御）
    const client = this.client;
    this.client = null;
    if (client) {
      await client.stop();
    }
    this.workspaceWatcher.dispose();
    this.configWatcher.dispose();
    this.saveWatcher.dispose();
    if (this.gitRefreshTimer) {
      clearTimeout(this.gitRefreshTimer);
      this.gitRefreshTimer = null;
    }
    this.promptEditor.dispose();
    this.onChange.dispose();
  }

  // -------------------------------------------------------------------------
  // 用户操作
  // -------------------------------------------------------------------------

  async sendPrompt(input: PromptInput): Promise<void> {
    // 收到发送即清理提示词编辑器（含下方早退分支；回填文本保留在输入框可重试）
    void this.promptEditor.disposeForSend();
    if (!this.workspaceRoot) {
      this.notice("warning", "Open a folder first to use Pinel");
      return;
    }
    await this.ensureStarted();
    if (!this.client) {
      this.notice("error", "pi process unavailable, click Restart on the banner");
      return;
    }

    // /new 本地拦截：pi 的 slash 命令 interactive-only，RPC 模式不展开（rpc-mode.js
    // 零 slash 逻辑、get_commands 不含内置命令）——精确匹配且无附件时改走 newSession。
    // 流式中 runSessionChange 会 abort 并等 settle 后新建；与在途会话变更并发时
    // runSessionChange 防重入静默返回（窗口极小，输入已清空，接受现状）。
    if (input.text.trim() === "/new" && !input.images?.length && !input.fileRefs?.length) {
      await this.newSession();
      return;
    }

    const images: ImageContent[] = (input.images ?? []).map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    }));
    // @ 文件引用：pinel 自读自拼（RPC 模式 pi 不支持 @file，实证 main.js:508）
    // 文本 → <file name="绝对路径"> 注入（对齐 pi CLI file-processor 格式）；
    // 图片 → base64 附件 + 空 <file name> 引用（对齐 pi CLI，模型拿得到路径）
    const text = input.fileRefs?.length ? await this.attachFileRefs(input.text, images, input.fileRefs) : input.text;

    // 乐观渲染用户消息（控制消息跳过：/pinel-* 扩展命令实测不写会话条目、
    // 也不应作为对话内容展示；仅原文，不含 <file> 注入 markup——权威列表显示层剥离）
    if (!input.control) {
      const userMessage: AgentMessage = { role: "user", content: input.text };
      this.fire({ type: "message", message: userMessage });
    }

    try {
      if (this.status.isStreaming) {
        // 流式中自动转 steer（排队消息，当前回合结束后投递）
        await this.client.send({ type: "steer", message: text, images });
        this.notice("info", "Queued (steer)");
      } else {
        await this.client.send({
          type: "prompt",
          message: text,
          images,
          streamingBehavior: "steer",
        });
      }
    } catch (err) {
      // success:false / 进程异常 → 统一错误提示
      this.notice("error", `Send failed: ${(err as Error).message}`);
    }
  }

  async abort(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      return;
    }
    try {
      await client.send({ type: "abort" });
    } catch (err) {
      this.notice("warning", `Abort failed: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // 提示词编辑器（Ctrl+G）
  // -------------------------------------------------------------------------

  /** Ctrl+G：在 VS Code 原生编辑器中编辑提示词（输入框当前内容作初始内容）。 */
  editPrompt(text: string): Promise<void> {
    return this.promptEditor.edit(text);
  }

  /** 输入框聚焦状态同步（keybinding when 上下文 pinel.inputFocused）。 */
  setInputFocused(focused: boolean): void {
    void vscode.commands.executeCommand("setContext", "pinel.inputFocused", focused);
  }

  /** pinel.editPrompt 命令：通知 webview 取当前输入内容并发起编辑（宿主不维护输入状态）。 */
  triggerEditPrompt(): void {
    this.fire({ type: "triggerEditPrompt" });
  }

  /** 测试钩子：当前待决提示词临时文件路径。 */
  getPendingPromptUri(): vscode.Uri | undefined {
    return this.promptEditor.getPendingUri();
  }

  // -------------------------------------------------------------------------
  // 会话历史（切换/新建/列表）
  // -------------------------------------------------------------------------

  /**
   * 扫描会话列表（聊天界面 header 弹层数据源）。
   * 与 SessionHistoryProvider 共用 resolveSessionsRoot/scanSessions/toItem，
   * 布局判断不重复；每次调用实时扫描（弹层打开时拉取）。
   */
  async getSessionList(): Promise<SessionListItem[]> {
    const configured = vscode.workspace.getConfiguration("pinel").get<string>("sessionDir")?.trim();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const { root, layout } = resolveSessionsRoot(cwd, configured);
    const metas = await scanSessions(root, cwd, layout);
    return metas.map(toItem);
  }

  /**
   * 重命名会话（会话列表行内编辑）。
   *
   * 双路径：
   * - 当前会话（path === sessionFile）→ RPC set_session_name（pi 权威通道：
   *   内存状态 + 落盘；需 pi 运行中）
   * - 非当前会话 → 宿主向目标 .jsonl 追加 session_info 条目（纯文件操作，
   *   不依赖 pi 进程状态；格式对齐 pi appendSessionInfo，见 session-history.ts）
   *
   * 空名（trim 后）视为取消：双路径统一入口拦截，不发 RPC 也不追加文件
   * （防非当前路径追加空名触发 pi「显式清除名称」语义）。
   * 成功 → sessionListRefresh（列表立即刷新，绕 provider 5s 节流）；
   * 当前会话另 force 重解析标题（refreshSessionTitle 以 sessionFile 变化为
   * 去重键，重命名不改路径必须 reset 后重跑）。
   */
  async renameSession(sessionPath: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      return; // 空名视为取消
    }
    const isCurrent = sessionPath === this.status.sessionFile;
    if (isCurrent) {
      const client = this.client;
      if (!client?.isRunning) {
        this.notice("warning", "pi process unavailable, cannot rename current session");
        return;
      }
      try {
        await client.send({ type: "set_session_name", name: trimmed });
        if (this.client !== client) {
          return; // restart 竞态：迟到响应丢弃
        }
      } catch (err) {
        // 旧版 pi 无此命令（docs/rpc.md 未收录）→ send 抛错 → 可见反馈
        this.notice("warning", `Rename failed: ${(err as Error).message}`);
        return;
      }
      // 标题 force 重解析（响应先于落盘的极小竞态可接受，下次刷新自愈）
      this.lastTitleSessionFile = undefined;
      this.refreshSessionTitle();
    } else {
      try {
        await appendSessionName(sessionPath, trimmed);
      } catch (err) {
        this.notice("warning", `Rename failed: ${(err as Error).message}`);
        return;
      }
    }
    this.fire({ type: "sessionListRefresh" });
  }

  /**
   * 删除会话（会话列表行操作）。
   * - 当前会话禁止删除（webview 按钮已禁用，此处执行时二次校验防切换窗口期）
   * - 非当前会话：宿主直接删 .jsonl（pi RPC 无删除命令；纯文件操作不依赖
   *   pi 进程状态）；fs.rm force:true 幂等 + maxRetries 重试（Windows 句柄）
   * - 确认弹窗不在本方法内（UI 层 confirmSessionDelete，PinelTestApi 直调不卡框）
   * 成功 → sessionListRefresh 立即刷新。
   */
  async deleteSession(sessionPath: string): Promise<void> {
    if (sessionPath === this.status.sessionFile) {
      this.notice("warning", "Current session cannot be deleted");
      return;
    }
    try {
      await fs.rm(sessionPath, { force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      this.notice("error", `Delete session failed: ${(err as Error).message}`);
      return;
    }
    this.fire({ type: "sessionListRefresh" });
  }

  /**
   * 扫描工作区文件列表（输入框 @ 添加文件数据源）。
   * gitignore 过滤 + 上限截断（截断时 notice 提示）；无 workspace → 空列表。
   */
  async getFileList(): Promise<ScanResult> {
    const root = this.workspaceRoot;
    if (!root) {
      return { items: [], truncated: false };
    }
    const result = await scanWorkspaceFiles(root);
    if (result.truncated) {
      this.notice("warning", "Many workspace files, @ file list truncated (limit 1000)");
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 扩展管理（浏览/启停/卸载；见 extensions.ts 头注释）
  // -------------------------------------------------------------------------

  /**
   * 扫描 pi 智能体扩展列表（本地扩展 + settings.json packages），按视图过滤：
   * all（包去重 project 优先）/ global / project（含继承行 inherited）。
   * 纯文件操作，不依赖 pi 进程状态（pi 未启动时也能浏览/管理）。
   */
  async getExtensionList(view: ExtensionView = "all"): Promise<ExtensionItem[]> {
    const agentDir = defaultAgentDir();
    const root = this.workspaceRoot;
    const projectDir = root ? projectConfigDir(root) : undefined;
    const local = await scanLocalExtensions(
      path.join(agentDir, "extensions"),
      projectDir ? path.join(projectDir, "extensions") : undefined,
    );
    const packages = await scanPackages(
      path.join(agentDir, "settings.json"),
      projectDir ? path.join(projectDir, "settings.json") : undefined,
    );
    return filterExtensionView([...local, ...packages], view, agentDir, projectDir);
  }

  /**
   * 启停扩展：本地 = 文件重命名；包 = settings.json 字符串 ↔ 对象空数组（无同 identity
   * 条目时 upsert 覆盖，支持项目级覆盖全局包）。失败 notice（不抛）；成功后由面板层刷新列表 + reload 提示。
   */
  async setExtensionEnabled(
    id: string,
    kind: ExtensionKind,
    scope: ExtensionScope,
    enabled: boolean,
  ): Promise<void> {
    try {
      if (kind === "local") {
        await setLocalExtensionEnabled(id, enabled);
      } else {
        await setPackageEnabled(this.settingsPathForScope(scope), id, enabled);
      }
    } catch (err) {
      this.notice("error", `Failed to ${enabled ? "enable" : "disable"} extension: ${(err as Error).message}`);
    }
  }

  /**
   * 卸载扩展：本地 = 删除文件/目录；包 = npm/git 走 `pi remove`、本地路径包删 settings 条目。
   * 确认弹窗不在本方法内（UI 层 confirmExtensionUninstall，PinelTestApi 直调不卡框）。
   */
  async uninstallExtension(
    id: string,
    kind: ExtensionKind,
    scope: ExtensionScope,
    source: string,
  ): Promise<void> {
    try {
      if (kind === "local") {
        await uninstallLocalExtension(source);
      } else if (/^(npm:|git:)/.test(source) || /^(https?|ssh|git):\/\//.test(source)) {
        await this.removePackageViaCli(source, scope);
      } else {
        // 本地路径包：pi remove 不支持 local source（抛 Unsupported remove source）
        await removePackageFromSettings(this.settingsPathForScope(scope), source);
      }
    } catch (err) {
      this.notice("error", `Failed to uninstall extension: ${(err as Error).message}`);
    }
  }

  /** scope → settings.json 路径（全局 = <agentDir>/settings.json；项目 = .pi/settings.json）。 */
  private settingsPathForScope(scope: ExtensionScope): string {
    if (scope === "project") {
      const root = this.workspaceRoot;
      if (!root) {
        throw new Error("no workspace folder");
      }
      return path.join(projectConfigDir(root), "settings.json");
    }
    return path.join(defaultAgentDir(), "settings.json");
  }

  /** spawn `pi remove <source> [-l]`（官方卸载路径：npm uninstall + git 清理 + settings 清理）。 */
  private removePackageViaCli(source: string, scope: ExtensionScope): Promise<void> {
    const command = this.resolvePiCommand();
    const args = ["remove", source, ...(scope === "project" ? ["-l"] : [])];
    // 项目 scope 需在 workspace 根执行（.pi/settings.json 解析）；全局用 agentDir 即可
    const cwd = scope === "project" ? (this.workspaceRoot ?? defaultAgentDir()) : defaultAgentDir();
    return runPiCommand(command, args, cwd);
  }

  /** 文本文件引用最大字节数（超限截断 + notice）。 */
  private static readonly MAX_FILE_REF_BYTES = 2 * 1024 * 1024;

  /**
   * @ 文件引用拼装：文本 → `<file name="绝对路径">` 注入（对齐 pi CLI
   * file-processor 格式）；图片 → base64 附件 + 空 `<file name>` 引用。
   * 读取失败 notice + 跳过（不阻塞发送）。
   */
  private async attachFileRefs(text: string, images: ImageContent[], refs: string[]): Promise<string> {
    const root = this.workspaceRoot;
    if (!root) {
      return text;
    }
    let out = text;
    for (const ref of refs) {
      const abs = path.resolve(root, ref);
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile() || stat.size === 0) {
          continue;
        }
        if (isImageFile(abs)) {
          const content = await fs.readFile(abs);
          images.push({ type: "image", data: content.toString("base64"), mimeType: imageMimeType(abs) });
          // 对齐 pi CLI：图片附空引用（模型拿得到图片路径）
          out += `\n<file name="${abs}"></file>\n`;
        } else {
          let content = await fs.readFile(abs, "utf8");
          if (content.length > ChatController.MAX_FILE_REF_BYTES) {
            content = content.slice(0, ChatController.MAX_FILE_REF_BYTES);
            this.notice("warning", `File ${ref} exceeds 2MB, truncated`);
          }
          out += `\n<file name="${abs}">\n${content}\n</file>\n`;
        }
      } catch {
        this.notice("warning", `Cannot read file ${ref} (skipped)`);
      }
    }
    return out;
  }

  /**
   * 切换到指定会话文件（会话历史列表选择）。
   *
   * 竞态防护（评审 B1 结论）：controller 的 agent_end 无条件替换 messages、
   * 无代际过滤，旧流迟到事件会覆盖新会话快照——因此流程为
   * 「abort + 清扫未决 UI → 等待 settle（5s 超时兜底）→ 再发切换命令」，
   * settle 后旧流事件必已消费完。
   */
  async switchSession(sessionPath: string): Promise<void> {
    await this.runSessionChange(
      { type: "switch_session", sessionPath },
      {
        cancelledNotice: "Session switch cancelled",
        failedNotice: (err) => `Session switch failed: ${err.message}`,
      },
    );
  }

  /** 新建会话（会话历史顶部按钮）。流程与 switchSession 一致。 */
  async newSession(): Promise<void> {
    await this.runSessionChange(
      { type: "new_session" },
      {
        cancelledNotice: "New session cancelled",
        failedNotice: (err) => `New session failed: ${err.message}`,
      },
    );
  }

  /**
   * 会话变更（切换/新建/fork/clone）共用骨架。
   *
   * 竞态防护（评审 B1 结论）：controller 的 agent_end 无条件替换 messages、
   * 无代际过滤，旧流迟到事件会覆盖新会话快照——因此流程为
   * 「abort + 清扫未决 UI → 等待 settle（5s 超时兑底）→ 再发变更命令」,
   * settle 后旧流事件必已消费完。
   *
   * 不变量（评审 M4，重构 switchSession/newSession 的回归兑底）：
   *  (a) no-workspace / client 不可用早退必须双发 sessionSwitching:false
   *      （HistoryApp 本地乐观置位依赖它复位，否则面板永久卡「切换中」）；
   *  (b) sessionSwitching=true 在 ensureStarted + client 校验之后；
   *  (c) cancelled 分支不走 afterSessionSwitch（onSuccess 仅在 !cancelled 时执行）；
   *  (d) client 身份校验三处：send 后 + afterSessionSwitch 内 get_messages/get_state 各一次；
   *  (e) finally 复位 + 广播。
   *
   * @param command 变更命令（switch_session/new_session/fork/clone）
   * @param onSuccess 成功（cancelled:false）回调，在 afterSessionSwitch 之前执行
   *        （如 fork 回填被 fork 消息文本到输入框）
   */
  private async runSessionChange(
    command: ForkCommand | CloneCommand | SwitchSessionCommand | NewSessionCommand,
    opts: {
      cancelledNotice: string;
      failedNotice: (err: Error) => string;
      onSuccess?: (data: { cancelled?: boolean; text?: string }) => void;
    },
  ): Promise<void> {
    if (this.sessionSwitching) {
      return; // 防重入：变更进行中忽略（在途操作 finally 自行复位）
    }
    if (!this.workspaceRoot) {
      this.notice("warning", "Open a folder first to use Pinel");
      // HistoryApp 已本地乐观置位 switching：前置 return 必须补发复位，
      // 否则历史面板永久卡「切换中」且后续点击被拦截（实测缺陷）
      this.fire({ type: "sessionSwitching", switching: false });
      return;
    }
    await this.ensureStarted();
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("error", "pi process unavailable, click Restart on the banner");
      this.fire({ type: "sessionSwitching", switching: false });
      return;
    }
    this.sessionSwitching = true;
    this.fire({ type: "sessionSwitching", switching: true });
    try {
      await this.prepareForSessionChange(client);
      const data = await client.send<{ cancelled?: boolean; text?: string }>(command);
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到响应，不污染新进程状态
      }
      if (data?.cancelled) {
        this.notice("info", opts.cancelledNotice);
        return;
      }
      opts.onSuccess?.(data);
      await this.afterSessionSwitch(client);
    } catch (err) {
      if (this.client === client) {
        this.notice("error", opts.failedNotice(err as Error));
      }
    } finally {
      this.sessionSwitching = false;
      this.fire({ type: "sessionSwitching", switching: false });
    }
  }

  /**
   * 获取可 fork 的历史用户消息（fork 选择器数据源；防御解析见 fork-messages.ts）。
   * 失败时 error notice + 广播空列表（webview 弹层显示空态）。
   */
  async getForkMessages(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi process unavailable, cannot load fork messages");
      this.fire({ type: "forkMessages", messages: [] });
      return;
    }
    try {
      const data = await client.send<ForkMessagesData>({ type: "get_fork_messages" });
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到结果，不污染新进程状态
      }
      this.fire({ type: "forkMessages", messages: parseForkMessages(data) });
    } catch (err) {
      if (this.client === client) {
        this.notice("error", `Failed to load fork messages: ${(err as Error).message}`);
        this.fire({ type: "forkMessages", messages: [] });
      }
    }
  }

  /**
   * 从历史用户消息 fork 新会话分支（fork 选择器选中后触发）。
   * pi 创建新会话文件并自动 rebind（无需再发 switch_session）；
   * 成功后把被 fork 消息原文回填输入框（fillPrompt，替换草稿语义对齐 Ctrl+G），
   * 供用户直接发送或编辑后重发（「从这里重新开始」语义）。
   */
  async forkSession(entryId: string): Promise<void> {
    await this.runSessionChange(
      { type: "fork", entryId },
      {
        cancelledNotice: "Fork cancelled",
        failedNotice: (err) => `Fork failed: ${err.message}`,
        onSuccess: (data) => {
          if (typeof data.text === "string" && data.text.length > 0) {
            this.fire({ type: "fillPrompt", text: data.text });
          }
        },
      },
    );
  }

  /** 复制当前活动分支为新会话文件（fork 选择器底部「克隆」项）。 */
  async cloneSession(): Promise<void> {
    await this.runSessionChange(
      { type: "clone" },
      {
        cancelledNotice: "Clone cancelled",
        failedNotice: (err) => `Clone failed: ${err.message}`,
      },
    );
  }

  /**
   * 切换/新建前置：中断进行中的流 + 清扫未决对话框/问卷 + 等待 settle。
   * baseline 必须在 abort 前捕获（abort 本身会触发 agent_settled）。
   * 清扫理由：进程存活，未决 extension_ui_request 必须逐帧回 cancelled，
   * 否则 agent 永久阻塞（AGENTS.md 既有契约；对话框阻塞期间不 settle）。
   * 仅在有活动回合（流式/对话框/问卷）时等待 settle——否则 settled 计数
   * 不前进，等待会白耗超时（无竞态风险：没有进行中的事件流）。
   */
  private async prepareForSessionChange(client: RpcClient): Promise<void> {
    const hadActiveTurn = this.status.isStreaming || this.pendingUi.size > 0 || this.questionnaire !== null;
    const baseline = this.settledCount;
    if (this.status.isStreaming) {
      await this.abort();
    }
    if (this.pendingUi.size > 0) {
      for (const req of this.pendingUi.values()) {
        client.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
      }
      this.pendingUi.clear();
      this.fire({ type: "uiCleared" });
    }
    // 问卷缓冲帧同理由补 cancelled（插件问卷无 timeout，pi 侧不会自动解锁）
    this.clearQuestionnaireWithCancels();
    if (hadActiveTurn) {
      await this.waitForSettledCount(baseline, 5000);
    }
  }

  /**
   * 切换/新建成功后：快照替换（消息 + 装配 + 工具卡片清空）+ 状态刷新 + 广播。
   * get_messages 失败时兜底清空消息列表（避免旧会话消息以新会话身份残留）；
   * get_state 回读刷新 sessionFile/sessionName（App 端按 sessionFile 变化
   * 清空本地消息与工具卡片重渲染）。
   */
  private async afterSessionSwitch(client: RpcClient): Promise<void> {
    this.partialAssembly = createAssembly();
    this.partialBlocks = [];
    this.tools.clear();
    this.todos = []; // 新会话待办从零开始（restart 同语义，fireSnapshot 携带空列表）
    try {
      const data = await client.send<GetMessagesData>({ type: "get_messages" });
      if (this.client !== client) {
        return;
      }
      this.messages = data.messages ?? [];
    } catch (err) {
      if (this.client === client) {
        this.notice("warning", `Failed to load session messages: ${(err as Error).message}`);
        this.messages = [];
      }
    }
    try {
      const state = await client.send<SessionState>({ type: "get_state" });
      if (this.client !== client) {
        return;
      }
      this.applySessionState(state);
    } catch (err) {
      if (this.client === client) {
        this.notice("warning", `Session state read-back failed: ${(err as Error).message}`);
      }
    }
    this.fireSnapshot();
    // 切换/新建后统计归属新会话：先清空占位再异步拉取（防旧会话统计短暂误导）
    if (this.status.showSessionStats) {
      this.sessionStats = null;
      this.fire({ type: "sessionStats", stats: null });
      // 阈值回显依赖 contextWindow：统计清空 → 回显回占位（新会话窗口可能不同）
      this.status = { ...this.status, autoCompactPercent: null };
      this.fire({ type: "status", status: this.status });
      void this.refreshSessionStats();
      void this.refreshSessionEnv();
    }
    this.fire({ type: "sessionListChanged" });
  }

  /** 等待 settled 计数前进且流停止（timeoutMs 超时兜底，超时继续不阻塞调用方）。 */
  private async waitForSettledCount(baseline: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.settledCount > baseline && !this.status.isStreaming) {
        return;
      }
      await sleep(100);
    }
  }

  /**
   * get_state 响应应用到本地状态（缺字段保留旧值，防御旧版 pi 的配置三字段缺失）。
   * 初始同步与切换后回读共用，保证字段合并逻辑一致。
   */
  private applySessionState(state: SessionState): void {
    this.status = {
      ...this.status,
      model: state.model ?? null,
      thinkingLevel: state.thinkingLevel ?? this.status.thinkingLevel,
      // 配置三字段：get_state 缺字段时保留默认值（防御旧版 pi）
      steeringMode: typeof state.steeringMode === "string" ? state.steeringMode : this.status.steeringMode,
      followUpMode: typeof state.followUpMode === "string" ? state.followUpMode : this.status.followUpMode,
      autoCompactionEnabled:
        typeof state.autoCompactionEnabled === "boolean"
          ? state.autoCompactionEnabled
          : this.status.autoCompactionEnabled,
      isStreaming: Boolean(state.isStreaming),
      isCompacting: Boolean(state.isCompacting),
      sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : this.status.sessionFile,
    };
    this.fire({ type: "status", status: this.status });
  }

  // -------------------------------------------------------------------------
  // 配置切换（设置面板）
  // -------------------------------------------------------------------------

  /**
   * 循环切换模型（cycle_model）。
   * UI 不再使用（已由设置面板内嵌模型列表 set_model 替代），保留供 PinelTestApi 测试覆盖。
   * pi 切模型时会重新锎制思考等级，响应携带 {model, thinkingLevel, isScoped}，
   * 两者一并应用；仅一个可用模型时响应为 null。
   */
  async cycleModel(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi process unavailable, cannot switch model");
      return;
    }
    try {
      const data = await client.send<CycleModelData | null>({ type: "cycle_model" });
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到响应，不污染新进程状态
      }
      if (!data) {
        this.notice("info", "Only one model available, cannot switch");
        return;
      }
      // 防御：响应形状异常（旧版 pi / 协议漂移）→ 仅提示不更新
      if (typeof data !== "object" || !data.model || typeof data.model !== "object" || Array.isArray(data.model)) {
        this.notice("warning", "Switch model failed: unexpected response data");
        return;
      }
      this.status = {
        ...this.status,
        model: data.model,
        thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : this.status.thinkingLevel,
      };
      this.fire({ type: "status", status: this.status });
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("error", `Switch model failed: ${(err as Error).message}`);
    }
  }

  /** 循环切换思考强度（cycle_thinking_level）；模型不支持思考时响应为 null。 */
  async cycleThinkingLevel(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi process unavailable, cannot switch thinking effort");
      return;
    }
    try {
      const data = await client.send<CycleThinkingLevelData | null>({ type: "cycle_thinking_level" });
      if (this.client !== client) {
        return;
      }
      if (!data) {
        // 仅 null：模型不支持思考（rpc-mode.js 回 success+data:null）
        this.notice("info", "Current model does not support thinking effort switch");
        return;
      }
      // 防御：非 null 的异常形状（旧版 pi / 协议漂移）→ 仅提示不更新
      if (typeof data !== "object" || typeof data.level !== "string") {
        this.notice("warning", "Switch thinking effort failed: unexpected response data");
        return;
      }
      this.status = { ...this.status, thinkingLevel: data.level };
      this.fire({ type: "status", status: this.status });
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("error", `Switch thinking effort failed: ${(err as Error).message}`);
    }
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.applyConfigCommand(
      { type: "set_steering_mode", mode },
      () => {
        this.status = { ...this.status, steeringMode: mode };
        this.fire({ type: "status", status: this.status });
      },
      "设置队列模式失败",
    );
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.applyConfigCommand(
      { type: "set_follow_up_mode", mode },
      () => {
        this.status = { ...this.status, followUpMode: mode };
        this.fire({ type: "status", status: this.status });
      },
      "设置跟进模式失败",
    );
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.applyConfigCommand(
      { type: "set_auto_compaction", enabled },
      () => {
        this.status = { ...this.status, autoCompactionEnabled: enabled };
        this.fire({ type: "status", status: this.status });
      },
      "设置自动压缩失败",
    );
  }

  /**
   * 设置自动压缩阈值（设置面板百分比输入）：换算为 pi settings.json 的
   * compaction.reserveTokens 写全局设置（触发条件 contextTokens > contextWindow − reserveTokens）。
   * - 换算基准 contextWindow：优先缓存统计；缺省时（信息条开关关闭 stats 未拉取）
   *   绕过 refreshSessionStats 的开关早退直发一次 get_session_stats。
   * - 写失败（损坏 JSON/权限）→ error notice；成功 → 广播回显 + notice。
   */
  async setCompactionThreshold(percent: number): Promise<void> {
    const pct = Math.round(percent);
    if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
      this.notice("error", `Invalid compaction threshold: ${percent}% (use 1–99)`);
      return;
    }
    let contextWindow: number | null = this.sessionStats?.contextUsage?.contextWindow ?? null;
    if (contextWindow === null) {
      const client = this.client;
      if (client?.isRunning) {
        try {
          const parsed = parseSessionStats(await client.send<SessionStatsData>({ type: "get_session_stats" }));
          contextWindow = parsed?.contextUsage?.contextWindow ?? null;
        } catch {
          // 拉取失败：下方统一按窗口缺失报错
        }
      }
    }
    if (contextWindow === null) {
      this.notice("error", "Cannot set threshold: context window unavailable (pi not running or stats missing)");
      return;
    }
    const reserveTokens = percentToReserveTokens(pct, contextWindow);
    try {
      const settings = await readSettings(agentSettingsPath(os.homedir()));
      const raw = settings.compaction;
      const compaction =
        typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
      compaction.reserveTokens = reserveTokens;
      settings.compaction = compaction;
      await writeSettings(agentSettingsPath(os.homedir()), settings);
    } catch (err) {
      this.notice("error", `Failed to save compaction threshold: ${(err as Error).message}`);
      return;
    }
    this.status = { ...this.status, autoCompactPercent: pct };
    this.fire({ type: "status", status: this.status });
    this.notice(
      "info",
      `Auto-compaction threshold set to ${pct}% (reserve ${reserveTokens} tokens). Restart pi to apply.`,
    );
  }

  /**
   * 读全局 settings.json 的 compaction.reserveTokens 换算百分比回显（无显式值用 pi 默认）。
   * 依赖缓存统计的 contextWindow；失败静默保持占位（非用户显式操作，不弹 notice）。
   */
  private async refreshAutoCompactPercent(): Promise<void> {
    const contextWindow = this.sessionStats?.contextUsage?.contextWindow;
    if (typeof contextWindow !== "number") {
      return;
    }
    let reserveTokens = DEFAULT_RESERVE_TOKENS;
    try {
      const settings = await readSettings(agentSettingsPath(os.homedir()));
      const raw = settings.compaction;
      const value =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).reserveTokens
          : undefined;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        reserveTokens = value;
      }
    } catch {
      return; // 读失败：保持占位
    }
    const pct = reserveTokensToPercent(reserveTokens, contextWindow);
    if (this.status.autoCompactPercent !== pct) {
      this.status = { ...this.status, autoCompactPercent: pct };
      this.fire({ type: "status", status: this.status });
    }
  }

  /**
   * 会话信息开关（设置面板「显示会话信息」）。
   * pinel 自身 UI 偏好：写 vscode 配置持久化（Global），不依赖 pi 进程状态。
   * 开启后立即首拉统计；配置写入失败静默 + Output 记录（不弹 notice——开关
   * 状态由 status 广播实时反馈，配置持久化失败不影响本次会话内显示）。
   */
  async setShowSessionStats(enabled: boolean): Promise<void> {
    try {
      await vscode.workspace
        .getConfiguration("pinel")
        .update("showSessionStats", enabled, vscode.ConfigurationTarget.Global);
    } catch (err) {
      this.output.appendLine(`[warning] 写入配置 pinel.showSessionStats 失败：${(err as Error).message}`);
    }
    // 直接更新状态 + 广播（onDidChangeConfiguration 监听会比较新旧值跳过，不双更新）
    this.applyShowSessionStats(enabled, true);
  }

  /** 读 pinel.showSessionStats 配置（默认关）。 */
  private readShowSessionStats(): boolean {
    return vscode.workspace.getConfiguration("pinel").get<boolean>("showSessionStats") ?? false;
  }

  /**
   * 应用开关状态到 status + 广播；firstFetch=true 时开启则立即首拉统计。
   * （start 时用 firstFetch=false：首拉由 start 流程统一触发，避免重复拉取）
   */
  private applyShowSessionStats(enabled: boolean, firstFetch = true): void {
    if (this.status.showSessionStats === enabled) {
      return;
    }
    this.status = { ...this.status, showSessionStats: enabled };
    this.fire({ type: "status", status: this.status });
    if (enabled && firstFetch) {
      void this.refreshSessionStats();
      void this.refreshSessionEnv();
    }
  }

  /**
   * 拉取会话统计（get_session_stats）并广播。
   * - 会话竞态：捕获发起时 sessionFile，fire 前校验未变（连续切换时旧会话
   *   迟到响应丢弃——照抄 refreshSessionTitle 模式）
   * - restart 竞态：this.client === client 校验
   * - 失败语义：无旧值时不 fire（webview 初始 null 天然占位）、有旧值静默
   *   保留 + Output 记录（不弹 notice——非用户显式操作的数据刷新，避免打扰）
   */
  private async refreshSessionStats(): Promise<void> {
    if (!this.status.showSessionStats) {
      return; // 开关关闭：不拉取（settle 钩子无条件调用，内部按开关短路）
    }
    const client = this.client;
    if (!client?.isRunning) {
      return; // 开关开启但 pi 未运行：保持占位，start 首拉/后续 settle 自然恢复
    }
    const captured = this.status.sessionFile;
    let parsed: SessionStatsData | null = null;
    try {
      const data = await client.send<SessionStatsData>({ type: "get_session_stats" });
      parsed = parseSessionStats(data);
    } catch (err) {
      // 命令失败（旧版 pi / 网络异常）
      this.output.appendLine(`[warning] 获取会话统计失败：${(err as Error).message}`);
      if (this.client !== client) {
        return;
      }
      if (this.sessionStats !== null) {
        return; // 有旧值：静默保留（本回合统计未更新，下次 settle 重试）
      }
      // 无旧值：不 fire（webview 保持 null 占位）
      return;
    }
    if (this.client !== client) {
      return; // restart 竞态：丢弃迟到响应
    }
    if (this.status.sessionFile !== captured) {
      return; // 会话已切换：旧统计丢弃（新会话的刷新已由切换钩子触发）
    }
    this.sessionStats = parsed;
    this.fire({ type: "sessionStats", stats: parsed });
    void this.refreshAutoCompactPercent(); // 阈值回显随新统计刷新（读全局 settings 换算）
  }

  /**
   * pinel.* setStatus 帧：防御解析 → 缓存 → 广播。
   * 非 pinel.statusKey 忽略（生态插件 mcp/ponytail/colgrep 等也发 setStatus，
   * 不白名单过滤会涌入 webview）。
   */
  private handlePinelStatus(req: ExtensionUiRequest): void {
    if (req.statusKey !== "pinel.state") {
      return;
    }
    const parsed = parsePinelState(req.statusText);
    if (!parsed) {
      return; // 解析失败：静默丢弃（插件版本漂移容缺）
    }
    this.pinelStateCache = parsed;
    this.fire({ type: "pinelState", state: parsed });
  }

  /** pinel.* setWidget 帧：同 setStatus 处理路径。 */
  private handlePinelWidget(req: ExtensionUiRequest): void {
    if (req.widgetKey !== "pinel.tree") {
      return;
    }
    const parsed = parsePinelTree(req.widgetLines);
    if (!parsed) {
      return;
    }
    this.pinelTreeCache = parsed;
    this.fire({ type: "pinelTree", tree: parsed });
  }

  // -------------------------------------------------------------------------
  // Pinel 插件（pi install npm 包）安装管理
  // -------------------------------------------------------------------------

  /** 曾安装标记键（globalState）。 */
  private static readonly PINEL_INSTALLED_FLAG_KEY = "pinelPluginPreviouslyInstalled";

  /**
   * 手动压缩会话上下文（原生 RPC compact；可选 customInstructions 传给总结 LLM）。
   * 结果 notice 回报；compaction_start/end 事件走既有 handleRecord 链路。
   */
  async compact(customInstructions?: string): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi is not running");
      return;
    }
    try {
      await client.send({ type: "compact", customInstructions });
      this.notice("info", "Compaction completed");
      void this.refreshSessionStats(); // 压缩后统计变化，刷新信息条
    } catch (err) {
      this.notice("error", `Compaction failed: ${(err as Error).message}`);
    }
  }

  /**
   * 计算 Pinel 插件安装态并广播（start 完成后 / 安装后调用）。
   * settings.json 损坏/缺失时 readAgentPackages 回 []，按未安装处理。
   */
  async refreshPinelPluginState(): Promise<void> {
    const packages = await readAgentPackages(agentSettingsPath(os.homedir()));
    const previously = this.pluginStateStore.get(ChatController.PINEL_INSTALLED_FLAG_KEY) === true;
    const state = decidePinelPluginState(packages, previously);
    this.pinelPluginStateCache = state;
    this.fire({ type: "pinelPluginState", state });
  }

  /**
   * 一键安装 Pinel 插件（spawn `pi install npm:@hilariouhiss/pinel`，全局 settings）。
   * 成功后置曾安装标记 + 刷新状态；失败 notice。
   * 注：已运行的 pi 不会热加载新包，需 restart 才生效（UI 层提示）。
   */
  async installPinelPlugin(): Promise<void> {
    try {
      await runPiCommand(this.resolvePiCommand(), ["install", PINEL_PACKAGE_SOURCE], defaultAgentDir(), 120000);
      await this.pluginStateStore.update(ChatController.PINEL_INSTALLED_FLAG_KEY, true);
      await this.refreshPinelPluginState();
      this.notice("info", "Pinel plugin installed. Restart pi to activate it.");
    } catch (err) {
      this.notice("error", `Failed to install Pinel plugin: ${(err as Error).message}`);
    }
  }

  /**
   * 插件目录状态（目录项 + 每项安装态）。安装态 = 全局 + 项目 packages 的 identity
   * 并集（已装优先于 compat 标注）；settings 损坏/缺失按未安装处理（getExtensionList 同策略）。
   */
  async getCatalogState(): Promise<CatalogItemState[]> {
    const agentDir = defaultAgentDir();
    const root = this.workspaceRoot;
    const projectDir = root ? projectConfigDir(root) : undefined;
    const installed = new Set<string>();
    const settingsPaths = [path.join(agentDir, "settings.json")];
    if (projectDir) {
      settingsPaths.push(path.join(projectDir, "settings.json"));
    }
    for (const settingsPath of settingsPaths) {
      try {
        const settings = await readSettings(settingsPath);
        for (const id of installedIdentities(settings.packages)) {
          installed.add(id);
        }
      } catch {
        // settings.json 损坏/缺失：该 scope 按无包处理（不阻断目录）
      }
    }
    return getCatalog().map((e) => ({ ...e, state: catalogInstallState(e, installed) }));
  }

  /**
   * 目录安装（显式按钮触发，非静默）：逐个 spawn `pi install <spec>`（全局 settings，
   * 120s 超时对齐 installPinelPlugin 先例；顺序执行防 settings.json 并发写竞态）。
   * 失败 notice（可重试）；成功后由面板层刷新列表 + Reload 确认流。
   */
  async installCatalogEntries(specs: string[]): Promise<void> {
    try {
      for (const spec of specs) {
        await runPiCommand(this.resolvePiCommand(), ["install", spec], defaultAgentDir(), 120000);
      }
      this.notice("info", `Installed ${specs.length} extension${specs.length === 1 ? "" : "s"}. Restart pi to activate.`);
    } catch (err) {
      this.notice("error", `Failed to install extension: ${(err as Error).message}`);
    }
  }
  /**
   * 拉取工作区环境段（文件夹名 + 富化 git 状态）并广播。
   * - 开关关闭短路（环境段仅随会话信息条展示，不额外 spawn git）
   * - git 不可用/非仓库/超时 → readGitStatus 回 null，git=null（webview 隐藏 git 部分）
   * - 竞态：捕获发起时 workspaceRoot，fire 前校验未变（workspace 切换丢弃旧结果）
   */
  private async refreshSessionEnv(): Promise<void> {
    if (!this.status.showSessionStats) {
      return;
    }
    const root = this.workspaceRoot;
    if (!root) {
      return;
    }
    const git = await readGitStatus(root);
    if (this.disposed || this.workspaceRoot !== root) {
      return; // dispose / workspace 已切换：丢弃旧结果
    }
    this.sessionEnv = { folderName: path.basename(root), git };
    this.fire({ type: "sessionEnv", env: this.sessionEnv });
  }

  /** 保存文件后去抖刷新 git 脏标记（合并短时间内的连续保存）。 */
  private scheduleGitRefresh(): void {
    if (this.gitRefreshTimer) {
      clearTimeout(this.gitRefreshTimer);
    }
    this.gitRefreshTimer = setTimeout(() => {
      this.gitRefreshTimer = null;
      void this.refreshSessionEnv();
    }, 300);
  }

  // -------------------------------------------------------------------------
  // 模型/思考强度列表（设置面板内嵌展开；每次展开时拉取）
  // -------------------------------------------------------------------------

  /**
   * 拉取可用模型列表（get_available_models；设置面板模型列表）。
   * 失败/空结果 notice + fire 空数组（webview 收到空数组即关闭弹窗；
   * 区别于 fetchCommands 的静默——此处为用户主动点击，需可见反馈）。
   */
  async getModels(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi process unavailable, cannot fetch model list");
      this.fire({ type: "models", models: [] });
      return;
    }
    try {
      const data = await client.send<GetAvailableModelsData>({ type: "get_available_models" });
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到响应，不污染新进程状态
      }
      const models = parseModels(data);
      if (models.length === 0) {
        this.notice("warning", "No model list received");
      }
      this.fire({ type: "models", models });
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("warning", `Fetch model list failed: ${(err as Error).message}`);
      this.fire({ type: "models", models: [] });
    }
  }

  /**
   * 切换到指定模型（set_model；设置面板模型列表选择）。
   * pi 切模型时会重新锎制思考等级并持久化 settings，但 set_model 响应只有
   * Model 对象（不含 thinkingLevel）——先防御校验并应用响应 model，再
   * get_state 回读刷新 model + thinkingLevel；回读失败保留 set_model 结果。
   */
  async setModel(provider: string, modelId: string): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi process unavailable, cannot switch model");
      return;
    }
    try {
      const data = await client.send<Model>({ type: "set_model", provider, modelId });
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到响应，不污染新进程状态
      }
      // 防御：响应形状异常（旧版 pi / 协议漂移）→ 仅提示不更新；
      // 空字符串同视为异常（与 parseModels 的 trim 非空校验一致）
      if (
        typeof data !== "object" ||
        data === null ||
        Array.isArray(data) ||
        typeof data.id !== "string" ||
        data.id.trim().length === 0 ||
        typeof data.name !== "string" ||
        data.name.trim().length === 0 ||
        typeof data.provider !== "string" ||
        data.provider.trim().length === 0
      ) {
        this.notice("warning", "Switch model failed: unexpected response data");
        return;
      }
      this.status = { ...this.status, model: data };
      this.fire({ type: "status", status: this.status });
      // set_model 响应不含 thinkingLevel（pi 内部 re-clamp）：回读确认
      await this.refreshStateAfterSwitch(client);
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("error", `Switch model failed: ${(err as Error).message}`);
    }
  }

  /**
   * 拉取当前模型支持的思考强度列表（get_available_thinking_levels；
   * 设置面板思考强度列表）。失败/空结果 notice + fire 空数组（同 getModels）。
   */
  async getThinkingLevels(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi process unavailable, cannot fetch thinking effort list");
      this.fire({ type: "thinkingLevels", levels: [] });
      return;
    }
    try {
      const data = await client.send<GetAvailableThinkingLevelsData>({ type: "get_available_thinking_levels" });
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到响应，不污染新进程状态
      }
      const levels = parseThinkingLevels(data);
      if (levels.length === 0) {
        this.notice("warning", "No thinking effort list received");
      }
      this.fire({ type: "thinkingLevels", levels });
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("warning", `Fetch thinking effort list failed: ${(err as Error).message}`);
      this.fire({ type: "thinkingLevels", levels: [] });
    }
  }

  /**
   * 设置思考强度（set_thinking_level；设置面板思考强度列表选择）。
   * 响应无 data 且 pi 会 clamp 到模型支持范围——成功后 get_state 回读确认
   * 实际生效值。
   */
  async setThinkingLevel(level: string): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi process unavailable, cannot set thinking effort");
      return;
    }
    try {
      await client.send({ type: "set_thinking_level", level });
      if (this.client !== client) {
        return;
      }
      await this.refreshStateAfterSwitch(client);
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("error", `Set thinking effort failed: ${(err as Error).message}`);
    }
  }

  /**
   * 切换命令成功后 get_state 回读确认（set_model 响应不含 thinkingLevel、
   * set_thinking_level 无 data 且 pi 会 clamp）。回读失败仅提示，
   * 不覆盖已应用的切换结果。
   */
  private async refreshStateAfterSwitch(client: RpcClient): Promise<void> {
    try {
      const state = await client.send<SessionState>({ type: "get_state" });
      if (this.client !== client) {
        return;
      }
      this.applySessionState(state);
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("warning", `State read-back failed (switch applied, UI may be out of sync): ${(err as Error).message}`);
    }
  }

  /**
   * 配置类命令公共路径：client 校验 → send → await 后再次校验 client 身份
   *（restart 竞态迟到响应丢弃）→ 成功回调应用本地状态；失败 notice。
   */
  private async applyConfigCommand(
    command: ClientCommand,
    apply: () => void,
    failText: string,
  ): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi process unavailable");
      return;
    }
    try {
      await client.send(command);
      if (this.client !== client) {
        return;
      }
      apply();
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("error", `${failText}：${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // 事件处理
  // -------------------------------------------------------------------------

  private handleRecord(record: RpcRecord): void {
    const event = record as RpcEvent;
    switch (event.type) {
      case "agent_start":
        this.streamStartCount++;
        this.status = { ...this.status, isStreaming: true };
        this.fire({ type: "status", status: this.status });
        break;

      case "agent_end": {
        // 会话代际防护（评审 B1）：settle 后迟到的旧流 agent_end（切换/abort
        // 竞态乱序）必须丢弃——正常时序 agent_end 在 agent_settled 之前到达
        //（isStreaming 仍为 true）；若已 settle（isStreaming=false）则事件
        // 属于已终结回合，其 messages 快照会覆盖新会话消息。
        // 权威消息列表由 settle 后的 get_messages 同步兜底。
        if (!this.status.isStreaming) {
          break;
        }
        // 仅刷新消息列表；空闲判定以 agent_settled 为准
        if (Array.isArray(event.messages) && event.messages.length > 0) {
          this.messages = event.messages as AgentMessage[];
        }
        this.fireSnapshot();
        break;
      }

      case "agent_settled": {
        this.settledCount++;
        // 清扫未决对话框：pi 侧对带 timeout 的 dialog 会超时自动 resolve，
        // abort 后 pending 的 dialog 也被 pi reject——此刻残留的请求不会再被
        // 应答，继续显示卡片只会误导用户。
        // 前提（实测）：dialog 阻塞 agent 期间不会发出 agent_settled，
        // 因此这里清扫到的都是已失效的请求。
        if (this.pendingUi.size > 0) {
          this.pendingUi.clear();
          this.fire({ type: "uiCleared" });
        }
        // 问卷清理：对残留缓冲帧补 cancelled（插件问卷对话框无 timeout，
        // pi 侧不会自动解锁，必须主动回复防 agent 永久阻塞——协议硬约束）；
        // 已提交的答案不可撤回，清卷只影响未答复帧
        this.clearQuestionnaireWithCancels();
        // 重置装配：abort 等场景下 settle 后仍可能有迟到的 message_update
        //（流序列尾部事件），不应污染下一条消息
        this.partialAssembly = createAssembly();
        this.partialBlocks = [];
        this.status = { ...this.status, isStreaming: false, isCompacting: false };
        this.fire({ type: "status", status: this.status });
        this.fire({ type: "stream", blocks: [] });
        // 最终同步（含 compaction/retry 后的最终状态）；命令列表随会话刷新
        //（扩展可能在运行中注册新命令）
        void this.syncMessages();
        void this.fetchCommands();
        // 会话统计随回合结束刷新（token/成本/上下文占用变化）
        void this.refreshSessionStats();
        // git 状态随回合结束刷新（agent 可能经工具改动了文件）
        void this.refreshSessionEnv();
        // 会话数据可能已更新（名称/消息）：通知历史视图刷新（provider 内部节流）
        this.fire({ type: "sessionListChanged" });
        break;
      }

      case "message_start":
        // 每条新消息重置分块装配状态（contentIndex 映射是每消息独立的），
        // 否则会串入上一条消息遗留的 thinking/toolCall 块
        this.currentStreamRole =
          typeof (event as { message?: AgentMessage }).message?.role === "string"
            ? (event as { message: AgentMessage }).message.role
            : "assistant";
        this.partialAssembly = createAssembly();
        this.partialBlocks = [];
        this.fire({ type: "stream", blocks: [] });
        break;

      case "message_update":
        if (!this.status.isStreaming) {
          // 防御：agent_settled 后迟到的增量（abort 场景）直接丢弃
          break;
        }
        if (this.currentStreamRole !== "assistant") {
          // 防御：用户消息的 delta 不渲染成助手流式气泡
          break;
        }
        this.handleDelta(event.assistantMessageEvent as AssistantDeltaEvent);
        break;

      case "message_end": {
        // 同 agent_end 的代际防护：settle 后迟到的 message_end 丢弃
        //（消息权威走 get_messages 快照）
        if (!this.status.isStreaming) {
          break;
        }
        const msg = event.message as AgentMessage;
        if (msg.role === "user") {
          // pi 对用户消息也发 message_end：webview 已有乐观渲染的用户消息，
          // 再广播会重复显示；权威列表由 agent_end/settle get_messages 快照提供
          break;
        }
        this.messageEventCounts[msg.role === "toolResult" ? "toolResult" : "assistant"]++;
        this.partialBlocks = [];
        this.messages.push(msg);
        this.fire({ type: "message", message: msg });
        this.fire({ type: "stream", blocks: [] });
        break;
      }

      case "tool_execution_start": {
        const e = event as ToolExecutionStartEvent;
        // ask_user_question：进入整卷问卷模式（本地渲染 + 确认后回填）
        if (e.toolName === "ask_user_question") {
          const questions = parseQuestionnaireArgs(e.args);
          if (questions) {
            this.enterQuestionnaire(e.toolCallId, questions);
          }
          // 参数解析失败（插件改名/改协议）：静默回退逐卡路径，不打断工具卡片
        }
        const tool: ToolCard = {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          argsText: safeArgsText(e.args),
          status: "running",
          output: "",
        };
        // subagent：从 args 构建专属卡片信息（模型/思考请求值，终态由后续 details 确定）
        if (e.toolName === "subagent") {
          tool.subagent = buildSubagentCard(e.args);
        }
        this.tools.set(e.toolCallId, tool);
        this.fire({ type: "tool", tool });
        break;
      }

      case "tool_execution_update": {
        const e = event as ToolExecutionUpdateEvent;
        const tool = this.tools.get(e.toolCallId);
        if (tool) {
          tool.output = extractText(e.partialResult?.content) ?? tool.output;
          tool.status = "running";
          // subagent：合并运行中实时状态（activity/统计；details 形状不符时静默跳过）
          if (tool.subagent) {
            applySubagentDetails(tool.subagent, e.partialResult?.details);
          }
          this.fire({ type: "tool", tool: { ...tool } });
        }
        break;
      }

      case "tool_execution_end": {
        const e = event as ToolExecutionEndEvent;
        // todo 工具：解析全量任务快照并更新待办面板（未文档化字段，防御解析）
        if (e.toolName === "todo") {
          const tasks = parseTodoTasks(e.result);
          if (tasks) {
            this.todos = tasks;
            this.fire({ type: "todos", todos: tasks });
          }
        }
        const tool = this.tools.get(e.toolCallId) ?? {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          argsText: "",
          status: "running" as const,
          output: "",
        };
        tool.output = extractText(e.result?.content) ?? tool.output;
        tool.status = e.isError ? "error" : "done";
        // subagent：合并终态 details（isError 优先 → 卡片强制 error）；
        // start 未见（restart 边缘）时兜底建卡，避免专属信息丢失
        if (e.toolName === "subagent") {
          if (!tool.subagent) {
            tool.subagent = buildSubagentCard(undefined);
          }
          applySubagentDetails(tool.subagent, e.result?.details, e.isError);
          // end 即执行结束：details 缺失/状态不可解析时兜底 completed（防 spinner 永转）
          if (tool.subagent.status === "running") {
            tool.subagent.status = "completed";
          }
        }
        this.tools.set(e.toolCallId, tool);
        this.fire({ type: "tool", tool: { ...tool } });
        break;
      }

      case "queue_update": {
        const e = event as QueueUpdateEvent;
        this.status = {
          ...this.status,
          steering: Array.isArray(e.steering) ? e.steering : [],
          followUp: Array.isArray(e.followUp) ? e.followUp : [],
        };
        this.fire({ type: "status", status: this.status });
        break;
      }

      case "compaction_start":
        this.status = { ...this.status, isCompacting: true };
        this.fire({ type: "status", status: this.status });
        break;

      case "compaction_end":
        this.status = { ...this.status, isCompacting: false };
        this.fire({ type: "status", status: this.status });
        break;

      case "auto_retry_start":
        this.notice("info", "pi is auto-retrying…");
        break;

      case "extension_ui_request": {
        const req = event as ExtensionUiRequest;
        if (DIALOG_UI_METHODS.has(req.method)) {
          const q = this.questionnaire;
          if (q && this.requestMatchesQuestionnaire(req)) {
            if (q.phase === "submitting" || q.phase === "submitted") {
              // 确认后：按游标立即回填（插件在上一题回复后才会发下一题）
              this.respondQuestionnaireFrame(req);
            } else {
              // 答题/确认阶段：缓冲不展示（整卷已在本地渲染）
              q.buffered.push(req);
            }
          } else if (
            this.questionnaireCancelPending &&
            matchesQuestionnaireTitles(req.title, this.questionnaireCancelPending.questions)
          ) {
            // 取消竞态补偿：取消时首帧尚未缓冲（在途），匹配帧到达即回 cancelled——
            // 否则插件 walker 永久等待响应，agent 永久阻塞（协议硬约束）
            if (this.client?.isRunning) {
              this.client.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
            }
            this.questionnaireCancelPending = null;
          } else {
            // 非问卷对话框：现有逐卡路径
            this.pendingUi.set(req.id, req);
            this.fire({ type: "uiRequest", request: req });
          }
        } else if (req.method === "notify") {
          const level = req.notifyType === "error" ? "error" : req.notifyType === "warning" ? "warning" : "info";
          this.notice(level, String(req.message ?? req.title ?? ""));
        } else if (req.method === "setStatus") {
          this.handlePinelStatus(req);
        } else if (req.method === "setWidget") {
          this.handlePinelWidget(req);
        }
        // setTitle/set_editor_text：fire-and-forget，暂不渲染
        break;
      }

      case "extension_error":
        this.notice("error", `Extension error: ${JSON.stringify(event)}`.slice(0, 300));
        break;
    }
  }

  /** 增量装配：应用 message_update 到 partialAssembly 并广播。 */
  private handleDelta(event: AssistantDeltaEvent): void {
    applyDelta(this.partialAssembly, event);
    this.partialBlocks = this.partialAssembly.blocks;
    this.fire({ type: "stream", blocks: this.partialBlocks });
  }

  private partialAssembly = createAssembly();

  private handleSpawnError(err: Error): void {
    this.status = {
      ...this.status,
      processState: "error",
      error: `Cannot start pi: ${err.message}. Please confirm pi is installed (npm install -g @earendil-works/pi-coding-agent) or configure pinel.piPath in settings`,
    };
    this.fire({ type: "status", status: this.status });
    this.notice("error", this.status.error!);
  }

  private handleExit(code: number | null): void {
    // 非主动停止 → 错误态 + 重启提示
    this.status = {
      ...this.status,
      processState: "error",
      error: `pi process exited (code=${code})`,
      isStreaming: false,
    };
    this.partialBlocks = [];
    // 进程已死：残留对话框无法再被应答，清空并广播（防卡片滞留、作答无效）
    if (this.pendingUi.size > 0) {
      this.pendingUi.clear();
      this.fire({ type: "uiCleared" });
    }
    // 问卷随进程死亡：缓冲帧已无接收方，直接清状态广播（无需补 cancelled）
    if (this.questionnaire) {
      this.questionnaire = null;
      this.fire({ type: "questionnaireCleared" });
    }
    this.questionnaireCancelPending = null; // 僵尸问卷随进程死亡清空
    // 命令列表是"进程能力描述"：崩溃后旧列表会误导补全（接受后发送报进程不可用），
    // 清空并广播，重启后由新启动流程重新拉取
    this.commands = [];
    this.fire({ type: "commands", commands: this.commands });
    this.fire({ type: "status", status: this.status });
    this.fire({ type: "stream", blocks: [] });
  }

  // -------------------------------------------------------------------------
  // 同步与广播
  // -------------------------------------------------------------------------

  private async syncMessages(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      return;
    }
    try {
      const data = await client.send<GetMessagesData>({ type: "get_messages" });
      this.messages = data.messages ?? this.messages;
      this.fireSnapshot();
    } catch {
      // 静默：settled 同步失败不影响后续操作
    }
  }

  /**
   * fire-and-forget 拉取可用斜杠命令。
   * 不得 await 在启动关键路径上（send 默认 30s 超时，旧版 pi 回 success:false
   * 会 reject）：内部 try/catch 吞掉一切失败，静默保持空列表（弹窗不弹出）。
   */
  private async fetchCommands(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      return;
    }
    try {
      const data = await client.send<GetCommandsData>({ type: "get_commands" });
      if (this.client !== client) {
        return; // 已被 restart 取代：丢弃迟到结果，不污染新进程状态
      }
      this.commands = parseCommands(data);
      this.fire({ type: "commands", commands: this.commands });
    } catch (err) {
      // 旧版 pi 不支持 get_commands：静默（仅 Output 记录，不弹 notice 避免启动噪音）
      this.output.appendLine(`[info] get_commands 失败（可能为旧版 pi）：${(err as Error).message}`);
    }
  }

  /** 用户答复对话框：回写 pi 并从 pendingUi 移除。未知 id 静默忽略（防御跨进程同 id 复用/迟到双答）。 */
  uiRespond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    if (!this.pendingUi.has(id)) {
      return;
    }
    this.pendingUi.delete(id);
    this.client?.writeRaw({ type: "extension_ui_response", id, ...response });
    this.fire({ type: "uiResolved", id });
  }

  // -------------------------------------------------------------------------
  // 问卷（ask_user_question：本地整卷渲染 + 确认后回填）
  // -------------------------------------------------------------------------

  /** 进入问卷模式：重入时对旧卷缓冲帧补 cancelled（pi 对多余回复静默忽略）。 */
  private enterQuestionnaire(id: string, questions: QuestionnaireQuestion[]): void {
    if (this.questionnaire) {
      const stale = this.questionnaire.buffered.splice(0);
      for (const req of stale) {
        this.client?.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
      }
    }
    this.questionnaireCancelPending = null; // 新卷替换：旧取消补偿作废
    this.questionnaire = {
      id,
      questions,
      answers: questions.map(() => null),
      phase: "answering",
      buffered: [],
      cursor: 0,
      awaitingFollowup: false,
    };
    // 防御：select 先于 tool_execution_start 到达的异常时序——吸收 pendingUi 中
    // 标题匹配本问卷的未答复帧入缓冲（已作答的由用户卡片路径正常消费）
    const absorbed: ExtensionUiRequest[] = [];
    for (const req of this.pendingUi.values()) {
      if (this.requestMatchesQuestionnaire(req)) {
        absorbed.push(req);
      }
    }
    if (absorbed.length > 0) {
      for (const req of absorbed) {
        this.pendingUi.delete(req.id);
        this.questionnaire.buffered.push(req);
        this.fire({ type: "uiResolved", id: req.id }); // 逐条移除吸收走的卡片（不动其他卡片）
      }
    }
    this.broadcastQuestionnaire();
  }

  /** 入站对话框是否属于当前问卷（标题门控：题面/header 子串）。 */
  private requestMatchesQuestionnaire(req: ExtensionUiRequest): boolean {
    const q = this.questionnaire;
    if (!q) {
      return false;
    }
    return matchesQuestionnaireTitles(req.title, q.questions);
  }

  /** 用户答题：校验后写入 journal；全部答完自动转 reviewing。 */
  handleQuestionnaireAnswer(questionIndex: number, answer: unknown): void {
    const q = this.questionnaire;
    if (!q || (q.phase !== "answering" && q.phase !== "reviewing")) {
      return;
    }
    const question = q.questions[questionIndex];
    if (!question) {
      return;
    }
    const parsed = parseQuestionnaireAnswer(answer, question);
    if (!parsed) {
      return;
    }
    q.answers[questionIndex] = parsed;
    if (q.answers.every((a) => a !== null)) {
      q.phase = "reviewing";
    }
    this.broadcastQuestionnaire();
  }

  /** 确认提交：回填所有已缓冲帧；后续串行对话框由 respondQuestionnaireFrame 即时回填。 */
  handleQuestionnaireConfirm(): void {
    const q = this.questionnaire;
    if (!q || q.phase !== "reviewing") {
      return;
    }
    q.phase = "submitting";
    this.broadcastQuestionnaire();
    const buffered = q.buffered.splice(0);
    for (const req of buffered) {
      this.respondQuestionnaireFrame(req);
    }
  }

  /** 放弃整卷：对缓冲帧补 cancelled 并清卷（插件 walker 收到 cancelled 即中止，不再发新帧）。
   *  竞态补偿：取消时首帧尚未缓冲（在途）→ 存题目快照，匹配帧到达时由
   *  extension_ui_request 分支立即回 cancelled（否则插件 walker 永久阻塞）。 */
  handleQuestionnaireCancel(): void {
    const q = this.questionnaire;
    if (!q) {
      return;
    }
    const buffered = q.buffered.splice(0);
    const client = this.client;
    for (const req of buffered) {
      if (client?.isRunning) {
        client.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
      }
    }
    // 仅用户取消路径置位（settled/重启路径帧不可能再到达，不留死僵尸）
    this.questionnaireCancelPending = buffered.length === 0 ? { questions: q.questions } : null;
    this.questionnaire = null;
    this.fire({ type: "questionnaireCleared" });
  }

  /** 清理问卷（settled 路径）：对残留缓冲帧补 cancelled 后清卷。 */
  private clearQuestionnaireWithCancels(): void {
    const q = this.questionnaire;
    if (!q) {
      return;
    }
    const buffered = q.buffered.splice(0);
    const client = this.client;
    for (const req of buffered) {
      if (client?.isRunning) {
        client.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
      }
    }
    this.questionnaire = null;
    this.questionnaireCancelPending = null; // settled：无在途帧，清僵尸
    this.fire({ type: "questionnaireCleared" });
  }

  /**
   * 回填一帧对话框（游标状态机；插件逐题串行，帧序确定）：
   * - 单选：select 帧 → 回选项原行（游标进下一题）或哨兵行（游标停留本题等跟进 input）
   * - 多选：input 帧 → 回 "1,3" 数字串/空串/自定义文本（游标进下一题）
   * - 跟进 input：回自定义文本（游标进下一题）
   * - 帧类型与预期不符：回 cancelled 防御（插件放弃，不阻塞）
   */
  private respondQuestionnaireFrame(req: ExtensionUiRequest): void {
    const q = this.questionnaire;
    const client = this.client;
    if (!q || !client?.isRunning) {
      return;
    }
    const cancelled = (): void => {
      client.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
    };
    if (q.cursor >= q.questions.length) {
      cancelled(); // 防御：超出游标
      return;
    }
    const question = q.questions[q.cursor];
    const answer = q.answers[q.cursor];
    if (q.awaitingFollowup) {
      // 哨兵跟进 input：回自定义文本
      if (req.method === "input" && answer?.kind === "custom") {
        client.writeRaw({ type: "extension_ui_response", id: req.id, value: answer.text });
      } else {
        cancelled();
      }
      q.awaitingFollowup = false;
      q.cursor++;
      this.advanceQuestionnaireCursor();
      return;
    }
    if (question.multiSelect) {
      if (req.method === "input") {
        const value = inputResponseFor(question, answer);
        if (value !== null) {
          client.writeRaw({ type: "extension_ui_response", id: req.id, value });
        } else {
          cancelled();
        }
        q.cursor++;
        this.advanceQuestionnaireCursor();
        return;
      }
      cancelled(); // 异常：多选题收到 select
      return;
    }
    // 单选：期待 select 帧
    if (req.method === "select") {
      const res = selectResponseFor(question, answer, req.options ?? []);
      if (res) {
        client.writeRaw({ type: "extension_ui_response", id: req.id, value: res.value });
        if (res.needsFollowup) {
          q.awaitingFollowup = true; // 游标停留本题等跟进 input
        } else {
          q.cursor++;
          this.advanceQuestionnaireCursor();
        }
      } else {
        cancelled();
      }
      return;
    }
    cancelled(); // 异常：单选收到非跟进 input
  }

  /** 回填完最后一题：转 submitted。 */
  private advanceQuestionnaireCursor(): void {
    const q = this.questionnaire;
    if (!q || q.phase !== "submitting") {
      return;
    }
    if (q.cursor >= q.questions.length && !q.awaitingFollowup) {
      q.phase = "submitted";
      this.broadcastQuestionnaire();
    }
  }

  private questionnaireView(): QuestionnaireView | null {
    const q = this.questionnaire;
    if (!q) {
      return null;
    }
    return {
      id: q.id,
      questions: q.questions,
      answers: q.answers.map((a) => (a ? { ...a } : null)),
      phase: q.phase,
    };
  }

  private broadcastQuestionnaire(): void {
    const view = this.questionnaireView();
    if (view) {
      this.fire({ type: "questionnaire", questionnaire: view });
    }
  }

  /** 全量快照（面板 resolve / 重启后重放；sessionTitle 缓存随快照恢复）。 */
  fireSnapshot(): void {
    this.fire({
      type: "snapshot",
      messages: this.messages,
      status: this.status,
      pendingUi: [...this.pendingUi.values()],
      todos: this.todos,
      commands: this.commands,
      questionnaire: this.questionnaireView(),
      sessionTitle: this.sessionTitleCache,
      sessionStats: this.sessionStats,
      sessionEnv: this.sessionEnv,
      pinelState: this.pinelStateCache,
      pinelTree: this.pinelTreeCache,
      pinelPluginState: this.pinelPluginStateCache,
    });
    // 会话文件变化（首次/切换/新建/重启后恢复）→ 异步解析标题；重放去重不重复解析
    if (this.status.sessionFile !== this.lastTitleSessionFile) {
      this.lastTitleSessionFile = this.status.sessionFile;
      this.refreshSessionTitle();
    }
  }

  /**
   * 解析当前会话标题（session_info.name）：fire-and-forget，快照先行标题后到。
   * 竞态防护：捕获触发时 sessionFile，解析完成 fire 前校验未变（连续快速
   * 切换/restart 时旧解析结果丢弃，与仓库既有「restart 竞态迟到结果丢弃」纪律一致）。
   */
  private refreshSessionTitle(): void {
    const sessionFile = this.status.sessionFile;
    if (!sessionFile) {
      this.sessionTitleCache = undefined;
      this.fire({ type: "sessionTitle", title: undefined });
      return;
    }
    const captured = sessionFile;
    void (async () => {
      let title: string | undefined;
      try {
        const content = await fs.readFile(captured, "utf8");
        title = parseSessionMeta(content)?.name;
      } catch {
        title = undefined; // 文件不存在/读取失败
      }
      if (this.status.sessionFile !== captured) {
        return; // 会话已切换：旧解析结果丢弃
      }
      this.sessionTitleCache = title;
      this.fire({ type: "sessionTitle", title });
    })();
  }

  private fire(msg: OutMessage): void {
    this.onChange.fire(msg);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    const now = Date.now();
    if (isDuplicateNotice(this.lastNotice, level, text, now)) {
      // 重复帧不打扰 UI，仅记入输出日志供诊断（pi 上游双重 emit）
      this.output.appendLine(`[${level}] ${text} (dup)`);
      return;
    }
    this.lastNotice = { level, text, at: now };
    this.fire({ type: "notice", level, text });
    this.output.appendLine(`[${level}] ${text}`);
  }

  private setProcessState(state: ProcessState): void {
    this.status = { ...this.status, processState: state };
    this.fire({ type: "status", status: this.status });
  }

  /** 解析 pi 可执行命令：优先用户配置，否则裸命令名（PATH/PATHEXT 查找）。 */
  private resolvePiCommand(): string {
    const configured = vscode.workspace.getConfiguration("pinel").get<string>("piPath");
    if (configured && configured.trim().length > 0) {
      return configured.trim();
    }
    return "pi";
  }

  // -------------------------------------------------------------------------
  // 测试钩子（集成测试使用）
  // -------------------------------------------------------------------------

  getStatus(): ChatStatus {
    return { ...this.status };
  }

  /** 最近一次 pinel.state 推送缓存（集成测试断言）。 */
  getPinelStateCache(): PinelStatePayload | null {
    return this.pinelStateCache;
  }

  /** 最近一次 pinel.tree 推送缓存（集成测试断言）。 */
  getPinelTreeCache(): PinelTreePayload | null {
    return this.pinelTreeCache;
  }

  /** Pinel 插件安装态缓存（null=未检测）。 */
  getPinelPluginState(): PinelPluginState | null {
    return this.pinelPluginStateCache;
  }

  getMessages(): AgentMessage[] {
    return this.messages;
  }

  getTools(): Map<string, ToolCard> {
    return this.tools;
  }

  getPartialBlocks(): StreamBlock[] {
    return this.partialBlocks;
  }

  getStreamStartCount(): number {
    return this.streamStartCount;
  }

  getSettledCount(): number {
    return this.settledCount;
  }

  /** pi 事件来源的 message 广播计数（user/assistant/toolResult；乐观渲染不计入）。 */
  getMessageEventCounts(): { user: number; assistant: number; toolResult: number } {
    return { ...this.messageEventCounts };
  }

  getPendingUi(): ExtensionUiRequest[] {
    return [...this.pendingUi.values()];
  }

  getTodos(): TodoTask[] {
    return [...this.todos];
  }

  getCommands(): SlashCommand[] {
    return [...this.commands];
  }

  /** 当前问卷视图（测试断言）。 */
  getQuestionnaire(): QuestionnaireView | null {
    return this.questionnaireView();
  }

  /** 模型自愈信息（集成测试断言）：最近一次初始同步的尝试次数与是否自动重启过。 */
  getModelHealInfo(): { attempts: number; autoRestarted: boolean } {
    return { attempts: this.modelHealAttempts, autoRestarted: this.modelHealRestarted };
  }
}

function extractText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 删除会话确认（UI 层共享 seam，聊天面板与历史视图两个 handler 统一调用）。
 * 包 vscode.window.showWarningMessage：返回 true 仅当用户点击「删除」。
 * 独立导出以便集成测试 stub showWarningMessage 后直调覆盖拒绝/接受两条路径
 * （controller.deleteSession 本体不内置确认——PinelTestApi 直调不卡确认框）。
 */
export async function confirmSessionDelete(sessionPath: string): Promise<boolean> {
  const label = path.basename(sessionPath);
  const pick = await vscode.window.showWarningMessage(
    `Delete session "${label}"? This cannot be undone.`,
    { modal: true },
    "Delete",
  );
  return pick === "Delete";
}

/**
 * 卸载扩展确认（UI 层共享 seam，聊天面板 handler 调用）。
 * 包 vscode.window.showWarningMessage：返回 true 仅当用户点击「Uninstall」。
 * 独立导出以便集成测试 stub showWarningMessage 后直调覆盖拒绝/接受两条路径。
 */
export async function confirmExtensionUninstall(name: string): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(
    `Uninstall extension "${name}"? This cannot be undone.`,
    { modal: true },
    "Uninstall",
  );
  return pick === "Uninstall";
}

/**
 * 扩展修改后的 reload 提示（原生确认框，点「Reload」才重载 pi）。
 * 独立导出以便集成测试 stub showInformationMessage 后直调覆盖两条路径。
 */
export async function confirmExtensionReload(): Promise<boolean> {
  const pick = await vscode.window.showInformationMessage(
    "Extension changed. Reload pi to apply changes?",
    "Reload",
  );
  return pick === "Reload";
}

/**
 * 一次性 spawn pi 子命令（`pi remove`）已迁移至 src/rpc/client.ts（runPiCommand，
 * 供 pinel 插件安装链路复用）。
 */
export type { AgentMessage };
