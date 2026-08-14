import * as vscode from "vscode";
import { RpcClient } from "../rpc/client";
import {
  DIALOG_UI_METHODS,
  type AgentMessage,
  type AssistantDeltaEvent,
  type ExtensionUiRequest,
  type GetAvailableModelsData,
  type GetMessagesData,
  type ImageContent,
  type Model,
  type QueueUpdateEvent,
  type RpcEvent,
  type RpcRecord,
  type SessionState,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
} from "../rpc/protocol";
import { applyDelta, createAssembly, type StreamBlock } from "./stream-assembly";
import { parseTodoTasks, type TodoTask } from "./todos";

export type ProcessState = "stopped" | "starting" | "running" | "error" | "no-workspace";

export interface ChatStatus {
  processState: ProcessState;
  isStreaming: boolean;
  isCompacting: boolean;
  model: Model | null;
  thinkingLevel: string;
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
  | { type: "snapshot"; messages: AgentMessage[]; status: ChatStatus; pendingUi: ExtensionUiRequest[]; todos: TodoTask[] }
  | { type: "stream"; blocks: StreamBlock[] }
  | { type: "message"; message: AgentMessage }
  | { type: "tool"; tool: ToolCard }
  | { type: "status"; status: ChatStatus }
  | { type: "uiRequest"; request: ExtensionUiRequest }
  | { type: "uiResolved"; id: string }
  | { type: "uiCleared" }
  | { type: "todos"; todos: TodoTask[] }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string };

interface PromptInput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

const initialStatus: ChatStatus = {
  processState: "stopped",
  isStreaming: false,
  isCompacting: false,
  model: null,
  thinkingLevel: "medium",
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
      await client.start(command, this.workspaceRoot, process.env);
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
        this.status = {
          ...this.status,
          model: state.model ?? null,
          thinkingLevel: state.thinkingLevel ?? this.status.thinkingLevel,
          isStreaming: Boolean(state.isStreaming),
          isCompacting: Boolean(state.isCompacting),
        };
        this.fire({ type: "status", status: this.status });
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
      // 立即广播重置后的状态 + 清除对话框/待办，让 UI 有即时反馈
      //（防止旧卡片在重启窗口内被应答，新进程可能复用同 id）
      this.fire({ type: "status", status: this.status });
      this.fire({ type: "uiCleared" });
      this.fire({ type: "todos", todos: this.todos });
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
        // 重置装配：abort 等场景下 settle 后仍可能有迟到的 message_update
        //（流序列尾部事件），不应污染下一条消息
        this.partialAssembly = createAssembly();
        this.partialBlocks = [];
        this.status = { ...this.status, isStreaming: false, isCompacting: false };
        this.fire({ type: "status", status: this.status });
        this.fire({ type: "stream", blocks: [] });
        // 最终同步（含 compaction/retry 后的最终状态）
        void this.syncMessages();
        break;
      }

      case "message_start":
        // 每条新消息重置分块装配状态（contentIndex 映射是每消息独立的），
        // 否则会串入上一条消息遗留的 thinking/toolCall 块
        this.partialAssembly = createAssembly();
        this.partialBlocks = [];
        this.fire({ type: "stream", blocks: [] });
        break;

      case "message_update":
        if (!this.status.isStreaming) {
          // 防御：agent_settled 后迟到的增量（abort 场景）直接丢弃
          break;
        }
        this.handleDelta(event.assistantMessageEvent as AssistantDeltaEvent);
        break;

      case "message_end": {
        this.partialBlocks = [];
        this.messages.push(event.message as AgentMessage);
        this.fire({ type: "message", message: event.message as AgentMessage });
        this.fire({ type: "stream", blocks: [] });
        break;
      }

      case "tool_execution_start": {
        const e = event as ToolExecutionStartEvent;
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
          // 对话框请求：广播给 webview 渲染内联卡片，等待用户作答（uiRespond）。
          this.pendingUi.set(req.id, req);
          this.fire({ type: "uiRequest", request: req });
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

  /** 用户答复对话框：回写 pi 并从 pendingUi 移除。未知 id 静默忽略（防御跨进程同 id 复用/迟到双答）。 */
  uiRespond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    if (!this.pendingUi.has(id)) {
      return;
    }
    this.pendingUi.delete(id);
    this.client?.writeRaw({ type: "extension_ui_response", id, ...response });
    this.fire({ type: "uiResolved", id });
  }

  /** 全量快照（面板 resolve / 重启后重放）。 */
  fireSnapshot(): void {
    this.fire({
      type: "snapshot",
      messages: this.messages,
      status: this.status,
      pendingUi: [...this.pendingUi.values()],
      todos: this.todos,
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

  getPendingUi(): ExtensionUiRequest[] {
    return [...this.pendingUi.values()];
  }

  getTodos(): TodoTask[] {
    return [...this.todos];
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
