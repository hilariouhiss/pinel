import * as vscode from "vscode";
import { ChatController, type ChatStatus, type ToolCard } from "./chat/controller";
import { ChatPanelProvider } from "./chat/panel";
import { SessionHistoryProvider, revealChatView, type SessionListItem } from "./chat/session-history-provider";
import type { AgentMessage, ExtensionUiRequest, Model, SlashCommand } from "./rpc/protocol";
import type { TodoTask } from "./chat/todos";
import type { QuestionnaireView } from "./chat/questionnaire";

/** 事件记录（测试断言用）：notice / models / thinkingLevels / sessionSwitching。 */
export interface TestEventLog {
  notices: Array<{ level: "info" | "warning" | "error"; text: string }>;
  lastModels: Model[] | undefined;
  lastThinkingLevels: string[] | undefined;
  /** 最近一次会话切换状态广播（newSession/switchSession 复位断言）。 */
  lastSessionSwitching: boolean | undefined;
}

/** 暴露给集成测试的钩子接口（通过扩展 exports 获取）。 */
export interface PinelTestApi {
  /** 打开聊天面板（执行 focus 命令以触发 resolveWebviewView）。 */
  openPanel(): Promise<void>;
  sendPrompt(text: string): Promise<void>;
  abort(): Promise<void>;
  /** 循环切换模型（cycle_model）。 */
  cycleModel(): Promise<void>;
  /** 循环切换思考强度（cycle_thinking_level）。 */
  cycleThinkingLevel(): Promise<void>;
  /** 拉取可用模型列表（get_available_models；模型下拉列表）。 */
  getModels(): Promise<void>;
  /** 切换到指定模型（set_model；模型下拉列表选择）。 */
  setModel(provider: string, modelId: string): Promise<void>;
  /** 拉取思考强度列表（get_available_thinking_levels；思考下拉列表）。 */
  getThinkingLevels(): Promise<void>;
  /** 设置思考强度（set_thinking_level；思考下拉列表选择）。 */
  setThinkingLevel(level: string): Promise<void>;
  /** 设置队列模式（set_steering_mode）。 */
  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
  /** 设置跟进模式（set_follow_up_mode）。 */
  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
  /** 设置自动压缩（set_auto_compaction）。 */
  setAutoCompaction(enabled: boolean): Promise<void>;
  /** 重启 pi 进程（触发 ChatController.restart）。 */
  restart(): Promise<void>;
  /** 切换到指定会话文件（会话历史列表选择）。 */
  switchSession(sessionPath: string): Promise<void>;
  /** 新建会话（会话历史顶部按钮）。 */
  newSession(): Promise<void>;
  /** 当前会话文件路径（get_state.sessionFile；切换/新建断言用）。 */
  getCurrentSessionFile(): string | undefined;
  /** 会话历史列表（最近一次扫描结果；测试断言，不依赖 DOM）。 */
  getSessionList(): SessionListItem[];
  /** 最近一次广播的当前会话文件（高亮断言）。 */
  getLastCurrentSessionFile(): string | undefined;
  getStatus(): ChatStatus;
  getMessages(): AgentMessage[];
  getTools(): Map<string, ToolCard>;
  /** 当前流式部分消息的展示块（contentIndex 装配产物）。 */
  getPartialBlocks(): Array<{ kind: string; text: string; toolCall?: { id: string; name: string; arguments: string } }>;
  /** 当前已完成的 agent 轮次计数（agent_settled 次数）。 */
  getSettledCount(): number;
  /** pi 事件来源的 message 广播计数（user/assistant/toolResult；乐观渲染不计入）。 */
  getMessageEventCounts(): { user: number; assistant: number; toolResult: number };
  /** 待决的扩展对话框请求。 */
  getPendingUi(): ExtensionUiRequest[];
  /** 当前待办任务快照。 */
  getTodos(): TodoTask[];
  /** 当前可用斜杠命令列表（get_commands 结果；空=未获取/获取失败）。 */
  getCommands(): SlashCommand[];
  /** 当前问卷视图（ask_user_question；null=无问卷）。 */
  getQuestionnaire(): QuestionnaireView | null;
  /** 模拟用户作答问卷第 questionIndex 题。 */
  questionnaireAnswer(questionIndex: number, answer: unknown): void;
  /** 模拟用户确认提交问卷。 */
  questionnaireConfirm(): void;
  /** 模拟用户放弃整卷问卷。 */
  questionnaireCancel(): void;
  /** 模型自愈信息：最近一次初始同步尝试次数与是否自动重启过。 */
  getModelHealInfo(): { attempts: number; autoRestarted: boolean };
  /** 答复扩展对话框（模拟用户在 webview 中的操作）。 */
  uiRespond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void;
  /** 事件记录快照（notice 环形 / 最近 models / 最近 thinkingLevels；测试断言用）。 */
  getTestEventLog(): TestEventLog;
  /** 轮询等待流结束（agent_settled 后 isStreaming=false）。 */
  waitForSettled(timeoutMs: number, baseline?: number): Promise<void>;
}

/** 模块级控制器引用：deactivate 显式等待其优雅退出（见下方）。 */
let controller: ChatController | null = null;

export function activate(context: vscode.ExtensionContext): PinelTestApi {
  const output = vscode.window.createOutputChannel("Pinel");
  context.subscriptions.push(output);

  controller = new ChatController(output);
  const ctrl = controller; // 局部常量供闭包使用（模块级可变引用无法收窄）
  // dispose 回调返回 Promise：VS Code 对 Thenable dispose 的等待行为无强保证，
  // deactivate() 中另有显式 await（dispose 幂等，双调用安全）
  context.subscriptions.push({ dispose: () => controller?.dispose() });

  const panelProvider = new ChatPanelProvider(context.extensionUri, ctrl);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  const historyProvider = new SessionHistoryProvider(context.extensionUri, ctrl);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SessionHistoryProvider.viewType, historyProvider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pinel.openPanel", async () => {
      await ctrl.ensureStarted();
      await vscode.commands.executeCommand("pinel.chatView.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pinel.abort", () => ctrl.abort()),
  );

  // 新会话（会话历史顶部按钮/命令面板）：新建成功后聊天视图已在次侧边栏显示
  context.subscriptions.push(
    vscode.commands.registerCommand("pinel.newSession", async () => {
      await ctrl.newSession();
      await revealChatView();
    }),
  );

  // 测试事件记录：notice / models / thinkingLevels 环形缓冲（最近 100 条），
  // 供集成测试断言（UI 链路不可控，controller 事件即权威）。
  const notices: Array<{ level: "info" | "warning" | "error"; text: string }> = [];
  let lastModels: Model[] | undefined;
  let lastThinkingLevels: string[] | undefined;
  let lastSessionSwitching: boolean | undefined;
  ctrl.onChange.event((msg) => {
    if (msg.type === "notice") {
      notices.push({ level: msg.level, text: msg.text });
      if (notices.length > 100) {
        notices.splice(0, notices.length - 100);
      }
    } else if (msg.type === "models") {
      lastModels = msg.models;
    } else if (msg.type === "thinkingLevels") {
      lastThinkingLevels = msg.levels;
    } else if (msg.type === "sessionSwitching") {
      lastSessionSwitching = msg.switching;
    }
  });

  return {
    openPanel: async () => {
      await vscode.commands.executeCommand("pinel.chatView.focus");
    },
    sendPrompt: (text: string) => ctrl.sendPrompt({ text }),
    abort: () => ctrl.abort(),
    cycleModel: () => ctrl.cycleModel(),
    cycleThinkingLevel: () => ctrl.cycleThinkingLevel(),
    getModels: () => ctrl.getModels(),
    setModel: (provider, modelId) => ctrl.setModel(provider, modelId),
    getThinkingLevels: () => ctrl.getThinkingLevels(),
    setThinkingLevel: (level) => ctrl.setThinkingLevel(level),
    setSteeringMode: (mode) => ctrl.setSteeringMode(mode),
    setFollowUpMode: (mode) => ctrl.setFollowUpMode(mode),
    setAutoCompaction: (enabled) => ctrl.setAutoCompaction(enabled),
    restart: () => ctrl.restart(),
    switchSession: (sessionPath: string) => ctrl.switchSession(sessionPath),
    newSession: () => ctrl.newSession(),
    getCurrentSessionFile: () => ctrl.getStatus().sessionFile,
    getSessionList: () => historyProvider.getLastList(),
    getLastCurrentSessionFile: () => historyProvider.getLastCurrentSessionFile(),
    getStatus: () => ctrl.getStatus(),
    getMessages: () => ctrl.getMessages(),
    getTools: () => ctrl.getTools(),
    getPartialBlocks: () => ctrl.getPartialBlocks(),
    getSettledCount: () => ctrl.getSettledCount(),
    getMessageEventCounts: () => ctrl.getMessageEventCounts(),
    getPendingUi: () => ctrl.getPendingUi(),
    getTodos: () => ctrl.getTodos(),
    getCommands: () => ctrl.getCommands(),
    getQuestionnaire: () => ctrl.getQuestionnaire(),
    questionnaireAnswer: (questionIndex, answer) => ctrl.handleQuestionnaireAnswer(questionIndex, answer),
    questionnaireConfirm: () => ctrl.handleQuestionnaireConfirm(),
    questionnaireCancel: () => ctrl.handleQuestionnaireCancel(),
    getModelHealInfo: () => ctrl.getModelHealInfo(),
    uiRespond: (id, response) => ctrl.uiRespond(id, response),
    getTestEventLog: () => ({
      notices: [...notices],
      lastModels,
      lastThinkingLevels,
      lastSessionSwitching,
    }),
    waitForSettled: async (timeoutMs: number, baseline?: number) => {
      const deadline = Date.now() + timeoutMs;
      // 基线在触发动作之前捕获（调用方传入），避免 settled 在基线记录前就被处理
      const startSettled = baseline ?? ctrl.getSettledCount();
      let sawStreaming = false;
      while (Date.now() < deadline) {
        const status = ctrl.getStatus();
        if (status.processState === "error") {
          return;
        }
        if (status.isStreaming) {
          sawStreaming = true;
        }
        // 权威信号：settled 计数前进（不依赖轮询恰好捕获 isStreaming 窗口）
        const settledAdvanced = ctrl.getSettledCount() > startSettled;
        if (settledAdvanced && !status.isStreaming && !status.isCompacting) {
          return;
        }
        if (sawStreaming && !status.isStreaming && !status.isCompacting) {
          return;
        }
        await sleep(100);
      }
      throw new Error(`waitForSettled 超时（${timeoutMs}ms）`);
    },
  };
}

export async function deactivate(): Promise<void> {
  // 显式等待 pi 优雅退出（stdin EOF → flush 会话/释放锁），避免窗口重载
  // 时旧 pi 被直接丢弃硬杀；dispose 幂等，与 subscription 双调用安全。
  await controller?.dispose();
  controller = null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
