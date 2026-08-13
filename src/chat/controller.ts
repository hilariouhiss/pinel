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
import { applyDelta, blocksFromMessage, createAssembly, type StreamBlock } from "./stream-assembly";

export type ProcessState = "stopped" | "starting" | "running" | "error";

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
  | { type: "snapshot"; messages: AgentMessage[]; status: ChatStatus }
  | { type: "stream"; blocks: StreamBlock[] }
  | { type: "message"; message: AgentMessage }
  | { type: "tool"; tool: ToolCard }
  | { type: "status"; status: ChatStatus }
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

  constructor(output: vscode.OutputChannel) {
    this.output = output;
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
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      this.status = { ...this.status, processState: "error", error: "请先打开一个文件夹" };
      this.fire({ type: "status", status: this.status });
      return;
    }
    this.workspaceRoot = root.uri.fsPath;
    this.setProcessState("starting");

    const command = this.resolvePiCommand();
    const client = new RpcClient();
    this.client = client;
    client.on("record", (r) => this.handleRecord(r));
    client.on("spawnError", (err) => this.handleSpawnError(err));
    client.on("exit", (code) => this.handleExit(code));
    client.on("stderr", (line) => this.output.appendLine(line));

    try {
      await client.start(command, this.workspaceRoot, process.env);
    } catch (err) {
      this.handleSpawnError(err as Error);
      return;
    }

    this.setProcessState("running");

    // 初始同步：状态 + 历史消息
    try {
      const state = await client.send<SessionState>({ type: "get_state" });
      this.status = {
        ...this.status,
        model: state.model ?? null,
        thinkingLevel: state.thinkingLevel ?? this.status.thinkingLevel,
        isStreaming: Boolean(state.isStreaming),
        isCompacting: Boolean(state.isCompacting),
      };
      this.fire({ type: "status", status: this.status });
    } catch (err) {
      this.notice("warning", `获取状态失败：${(err as Error).message}`);
    }

    try {
      const data = await client.send<GetMessagesData>({ type: "get_messages" });
      this.messages = data.messages ?? [];
      this.fireSnapshot();
    } catch (err) {
      this.notice("warning", `获取历史消息失败：${(err as Error).message}`);
    }
  }

  /** 重启：杀掉旧进程并重新启动，随后用 get_messages 回放历史。 */
  async restart(): Promise<void> {
    const old = this.client;
    this.client = null;
    this.startPromise = null;
    this.tools.clear();
    this.partialBlocks = [];
    this.status = { ...initialStatus };
    if (old) {
      await old.stop();
    }
    await this.ensureStarted();
    this.fireSnapshot();
  }

  /** 关闭：终止整个进程树。 */
  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      await client.stop();
    }
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
        this.status = { ...this.status, isStreaming: false, isCompacting: false };
        this.partialBlocks = [];
        this.fire({ type: "status", status: this.status });
        this.fire({ type: "stream", blocks: [] });
        // 最终同步（含 compaction/retry 后的最终状态）
        void this.syncMessages();
        break;
      }

      case "message_start":
        this.partialBlocks = [];
        this.fire({ type: "stream", blocks: [] });
        break;

      case "message_update":
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
          // v0.1 决策：不提供交互 UI，自动取消，防止 agent 永久阻塞。
          this.client?.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
          this.notice("warning", `扩展请求交互（${req.method}：${req.title ?? ""}）——v0.1 已自动取消`);
        } else if (req.method === "notify") {
          const level = req.notifyType === "error" ? "error" : req.notifyType === "warning" ? "warning" : "info";
          this.notice(level, String(req.message ?? req.title ?? ""));
        }
        // setStatus/setWidget/setTitle/set_editor_text：fire-and-forget，v0.1 忽略
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

  /** 全量快照（面板 resolve / 重启后重放）。 */
  fireSnapshot(): void {
    this.fire({ type: "snapshot", messages: this.messages, status: this.status });
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

export type { AgentMessage };
