import * as vscode from "vscode";
import { RpcClient } from "../rpc/client";
import {
  DIALOG_UI_METHODS,
  type AgentMessage,
  type AssistantDeltaEvent,
  type ClientCommand,
  type CycleModelData,
  type CycleThinkingLevelData,
  type ExtensionUiRequest,
  type GetAvailableModelsData,
  type GetAvailableThinkingLevelsData,
  type GetCommandsData,
  type GetMessagesData,
  type ImageContent,
  type Model,
  type QueueUpdateEvent,
  type RpcEvent,
  type RpcRecord,
  type SessionState,
  type SessionSwitchData,
  type SlashCommand,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
} from "../rpc/protocol";
import { applyDelta, createAssembly, type StreamBlock } from "./stream-assembly";
import { parseTodoTasks, type TodoTask } from "./todos";
import { parseCommands } from "./commands";
import { parseModels, parseThinkingLevels } from "./models";
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
}

export type OutMessage =
  | { type: "snapshot"; messages: AgentMessage[]; status: ChatStatus; pendingUi: ExtensionUiRequest[]; todos: TodoTask[]; commands: SlashCommand[]; questionnaire: QuestionnaireView | null }
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
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };

interface PromptInput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
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

/**
 * 聊天会话控制器：持有 pi RPC 子进程的生命周期、消息缓冲、流式装配状态，
 * 并把一切变化广播为 OutMessage（由面板转发给 webview）。
 */
export class ChatController {
  readonly onChange = new vscode.EventEmitter<OutMessage>();
  private readonly output: vscode.OutputChannel;

  private client: RpcClient | null = null;
  private status: ChatStatus = { ...initialStatus };
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
  private workspaceWatcher: vscode.Disposable;
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
  /** 会话切换/新建 in-flight（防连点重入）。 */
  private sessionSwitching = false;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
    // 未打开文件夹时提示用户；打开文件夹后自动连接
    this.workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.status.processState === "no-workspace" && vscode.workspace.workspaceFolders?.length) {
        this.startPromise = null;
        void this.ensureStarted();
      }
    });
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
      this.notice("warning", `获取历史消息失败：${(err as Error).message}`);
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
      this.notice("info", "未获取到模型信息，正在自动重启 pi 以恢复…");
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
        error: "当前窗口未打开文件夹。请打开一个文件夹后再使用 Pinel。",
      };
      this.fire({ type: "status", status: this.status });
      this.notice("info", "未打开文件夹：打开文件夹后 Pi 将自动连接。");
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
      await client.start(command, this.workspaceRoot, process.env, extraArgs);
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
      this.notice("warning", "未获取到模型信息：请检查 pi 认证（在终端运行 pi 验证），或点击状态栏“重启”重试。");
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
      this.pendingUi.clear();
      this.todos = [];
      this.commands = [];
      const staleQuestionnaire = this.questionnaire;
      this.questionnaire = null;
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
    this.onChange.dispose();
  }

  // -------------------------------------------------------------------------
  // 用户操作
  // -------------------------------------------------------------------------

  async sendPrompt(input: PromptInput): Promise<void> {
    if (!this.workspaceRoot) {
      this.notice("warning", "请先打开一个文件夹，再使用 Pinel");
      return;
    }
    await this.ensureStarted();
    if (!this.client) {
      this.notice("error", "pi 进程不可用，请点击状态栏的“重启”");
      return;
    }

    const images: ImageContent[] = (input.images ?? []).map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    }));

    // 乐观渲染用户消息
    const userMessage: AgentMessage = { role: "user", content: input.text };
    this.fire({ type: "message", message: userMessage });

    try {
      if (this.status.isStreaming) {
        // 流式中自动转 steer（排队消息，当前回合结束后投递）
        await this.client.send({ type: "steer", message: input.text, images });
        this.notice("info", "已加入待处理队列（steer）");
      } else {
        await this.client.send({
          type: "prompt",
          message: input.text,
          images,
          streamingBehavior: "steer",
        });
      }
    } catch (err) {
      // success:false / 进程异常 → 统一错误提示
      this.notice("error", `发送失败：${(err as Error).message}`);
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
      this.notice("warning", `中断失败：${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // 会话历史（切换/新建）
  // -------------------------------------------------------------------------

  /**
   * 切换到指定会话文件（会话历史列表选择）。
   *
   * 竞态防护（评审 B1 结论）：controller 的 agent_end 无条件替换 messages、
   * 无代际过滤，旧流迟到事件会覆盖新会话快照——因此流程为
   * 「abort + 清扫未决 UI → 等待 settle（5s 超时兜底）→ 再发切换命令」，
   * settle 后旧流事件必已消费完。
   */
  async switchSession(sessionPath: string): Promise<void> {
    if (this.sessionSwitching) {
      return; // 防重入：切换/新建进行中忽略（在途操作 finally 自行复位）
    }
    if (!this.workspaceRoot) {
      this.notice("warning", "请先打开一个文件夹，再使用 Pinel");
      // HistoryApp 已本地乐观置位 switching：前置 return 必须补发复位，
      // 否则历史面板永久卡「切换中」且后续点击被拦截（实测缺陷）
      this.fire({ type: "sessionSwitching", switching: false });
      return;
    }
    await this.ensureStarted();
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("error", "pi 进程不可用，请点击状态栏的“重启”");
      this.fire({ type: "sessionSwitching", switching: false });
      return;
    }
    this.sessionSwitching = true;
    this.fire({ type: "sessionSwitching", switching: true });
    try {
      await this.prepareForSessionChange(client);
      const data = await client.send<SessionSwitchData>({ type: "switch_session", sessionPath });
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到响应，不污染新进程状态
      }
      if (data?.cancelled) {
        this.notice("info", "切换会话已取消");
        return;
      }
      await this.afterSessionSwitch(client);
    } catch (err) {
      if (this.client === client) {
        this.notice("error", `切换会话失败：${(err as Error).message}`);
      }
    } finally {
      this.sessionSwitching = false;
      this.fire({ type: "sessionSwitching", switching: false });
    }
  }

  /** 新建会话（会话历史顶部按钮）。流程与 switchSession 一致。 */
  async newSession(): Promise<void> {
    if (this.sessionSwitching) {
      return; // 防重入（在途操作 finally 自行复位）
    }
    if (!this.workspaceRoot) {
      this.notice("warning", "请先打开一个文件夹，再使用 Pinel");
      // 同 switchSession：前置 return 补发复位（HistoryApp 本地乐观置位兜底）
      this.fire({ type: "sessionSwitching", switching: false });
      return;
    }
    await this.ensureStarted();
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("error", "pi 进程不可用，请点击状态栏的“重启”");
      this.fire({ type: "sessionSwitching", switching: false });
      return;
    }
    this.sessionSwitching = true;
    this.fire({ type: "sessionSwitching", switching: true });
    try {
      await this.prepareForSessionChange(client);
      const data = await client.send<SessionSwitchData>({ type: "new_session" });
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到响应
      }
      if (data?.cancelled) {
        this.notice("info", "新建会话已取消");
        return;
      }
      await this.afterSessionSwitch(client);
    } catch (err) {
      if (this.client === client) {
        this.notice("error", `新建会话失败：${(err as Error).message}`);
      }
    } finally {
      this.sessionSwitching = false;
      this.fire({ type: "sessionSwitching", switching: false });
    }
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
    try {
      const data = await client.send<GetMessagesData>({ type: "get_messages" });
      if (this.client !== client) {
        return;
      }
      this.messages = data.messages ?? [];
    } catch (err) {
      if (this.client === client) {
        this.notice("warning", `获取会话消息失败：${(err as Error).message}`);
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
        this.notice("warning", `会话状态回读失败：${(err as Error).message}`);
      }
    }
    this.fireSnapshot();
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
  // 配置切换（状态栏弹出面板）
  // -------------------------------------------------------------------------

  /**
   * 循环切换模型（cycle_model）。
   * UI 不再使用（已由状态栏模型列表 set_model 替代），保留供 PinelTestApi 测试覆盖。
   * pi 切模型时会重新锎制思考等级，响应携带 {model, thinkingLevel, isScoped}，
   * 两者一并应用；仅一个可用模型时响应为 null。
   */
  async cycleModel(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi 进程不可用，无法切换模型");
      return;
    }
    try {
      const data = await client.send<CycleModelData | null>({ type: "cycle_model" });
      if (this.client !== client) {
        return; // restart 竞态：丢弃迟到响应，不污染新进程状态
      }
      if (!data) {
        this.notice("info", "仅有一个可用模型，无法切换");
        return;
      }
      // 防御：响应形状异常（旧版 pi / 协议漂移）→ 仅提示不更新
      if (typeof data !== "object" || !data.model || typeof data.model !== "object" || Array.isArray(data.model)) {
        this.notice("warning", "切换模型失败：响应数据异常");
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
      this.notice("error", `切换模型失败：${(err as Error).message}`);
    }
  }

  /** 循环切换思考强度（cycle_thinking_level）；模型不支持思考时响应为 null。 */
  async cycleThinkingLevel(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi 进程不可用，无法切换思考强度");
      return;
    }
    try {
      const data = await client.send<CycleThinkingLevelData | null>({ type: "cycle_thinking_level" });
      if (this.client !== client) {
        return;
      }
      if (!data) {
        // 仅 null：模型不支持思考（rpc-mode.js 回 success+data:null）
        this.notice("info", "当前模型不支持思考强度切换");
        return;
      }
      // 防御：非 null 的异常形状（旧版 pi / 协议漂移）→ 仅提示不更新
      if (typeof data !== "object" || typeof data.level !== "string") {
        this.notice("warning", "切换思考强度失败：响应数据异常");
        return;
      }
      this.status = { ...this.status, thinkingLevel: data.level };
      this.fire({ type: "status", status: this.status });
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("error", `切换思考强度失败：${(err as Error).message}`);
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

  // -------------------------------------------------------------------------
  // 模型/思考强度列表（状态栏下拉选择；每次点击时拉取）
  // -------------------------------------------------------------------------

  /**
   * 拉取可用模型列表（get_available_models；状态栏模型列表）。
   * 失败/空结果 notice + fire 空数组（webview 收到空数组即关闭弹窗；
   * 区别于 fetchCommands 的静默——此处为用户主动点击，需可见反馈）。
   */
  async getModels(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi 进程不可用，无法获取模型列表");
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
        this.notice("warning", "未获取到模型列表");
      }
      this.fire({ type: "models", models });
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("warning", `获取模型列表失败：${(err as Error).message}`);
      this.fire({ type: "models", models: [] });
    }
  }

  /**
   * 切换到指定模型（set_model；状态栏模型列表选择）。
   * pi 切模型时会重新锎制思考等级并持久化 settings，但 set_model 响应只有
   * Model 对象（不含 thinkingLevel）——先防御校验并应用响应 model，再
   * get_state 回读刷新 model + thinkingLevel；回读失败保留 set_model 结果。
   */
  async setModel(provider: string, modelId: string): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi 进程不可用，无法切换模型");
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
        this.notice("warning", "切换模型失败：响应数据异常");
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
      this.notice("error", `切换模型失败：${(err as Error).message}`);
    }
  }

  /**
   * 拉取当前模型支持的思考强度列表（get_available_thinking_levels；
   * 状态栏思考强度列表）。失败/空结果 notice + fire 空数组（同 getModels）。
   */
  async getThinkingLevels(): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi 进程不可用，无法获取思考强度列表");
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
        this.notice("warning", "未获取到思考强度列表");
      }
      this.fire({ type: "thinkingLevels", levels });
    } catch (err) {
      if (this.client !== client) {
        return;
      }
      this.notice("warning", `获取思考强度列表失败：${(err as Error).message}`);
      this.fire({ type: "thinkingLevels", levels: [] });
    }
  }

  /**
   * 设置思考强度（set_thinking_level；状态栏思考强度列表选择）。
   * 响应无 data 且 pi 会 clamp 到模型支持范围——成功后 get_state 回读确认
   * 实际生效值。
   */
  async setThinkingLevel(level: string): Promise<void> {
    const client = this.client;
    if (!client?.isRunning) {
      this.notice("warning", "pi 进程不可用，无法设置思考强度");
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
      this.notice("error", `设置思考强度失败：${(err as Error).message}`);
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
      this.notice("warning", `状态回读失败（切换已生效，界面可能未同步）：${(err as Error).message}`);
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
      this.notice("warning", "pi 进程不可用");
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
            this.enterQuestionnaire(questions);
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
        this.notice("info", "pi 正在自动重试…");
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
          } else {
            // 非问卷对话框：现有逐卡路径
            this.pendingUi.set(req.id, req);
            this.fire({ type: "uiRequest", request: req });
          }
        } else if (req.method === "notify") {
          const level = req.notifyType === "error" ? "error" : req.notifyType === "warning" ? "warning" : "info";
          this.notice(level, String(req.message ?? req.title ?? ""));
        }
        // setStatus/setWidget/setTitle/set_editor_text：fire-and-forget，当前 pi
        // 只发无内容帧（待列表内容走 todo 工具结果解析），暂不渲染
        break;
      }

      case "extension_error":
        this.notice("error", `扩展错误：${JSON.stringify(event)}`.slice(0, 300));
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
      error: `无法启动 pi：${err.message}。请确认已安装 pi（npm install -g @earendil-works/pi-coding-agent）或在设置中配置 pinel.piPath`,
    };
    this.fire({ type: "status", status: this.status });
    this.notice("error", this.status.error!);
  }

  private handleExit(code: number | null): void {
    // 非主动停止 → 错误态 + 重启提示
    this.status = {
      ...this.status,
      processState: "error",
      error: `pi 进程已退出（code=${code}）`,
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
  private enterQuestionnaire(questions: QuestionnaireQuestion[]): void {
    if (this.questionnaire) {
      const stale = this.questionnaire.buffered.splice(0);
      for (const req of stale) {
        this.client?.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
      }
    }
    this.questionnaire = {
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
    return q.questions.some((question) => titleMatchesQuestion(req.title, question));
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

  /** 放弃整卷：对缓冲帧补 cancelled 并清卷（插件 walker 收到 cancelled 即中止，不再发新帧）。 */
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

  /** 全量快照（面板 resolve / 重启后重放）。 */
  fireSnapshot(): void {
    this.fire({
      type: "snapshot",
      messages: this.messages,
      status: this.status,
      pendingUi: [...this.pendingUi.values()],
      todos: this.todos,
      commands: this.commands,
      questionnaire: this.questionnaireView(),
    });
  }

  private fire(msg: OutMessage): void {
    this.onChange.fire(msg);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
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

export type { AgentMessage };
