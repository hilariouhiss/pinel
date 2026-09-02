import * as vscode from "vscode";
import { ChatController, type CatalogItemState, type ChatStatus, type SessionEnv, type ToolCard } from "./chat/controller";
import type { SessionStatsData } from "./rpc/protocol";
import { ChatPanelProvider } from "./chat/panel";
import { SessionHistoryProvider, revealChatView } from "./chat/session-history-provider";
import type { SessionListItem } from "./chat/session-history";
import type { FileItem } from "./chat/file-scanner";
import type { ExtensionItem, ExtensionKind, ExtensionScope } from "./chat/extensions";
import type { AgentMessage, ExtensionUiRequest, ForkMessage, Model, SlashCommand } from "./rpc/protocol";
import type { TodoTask } from "./chat/todos";
import type { QuestionnaireView } from "./chat/questionnaire";
import type { McpStatus, PinelMcpPayload, PinelPromptPayload, PinelWorkflowPayload, PonytailStatus } from "./chat/pinel-payload";
import type { PinelPluginState } from "./chat/pinel-install";

/** 事件记录（测试断言用）：notice / models / thinkingLevels / sessionSwitching / fillPrompt / sessionTitle。 */
export interface TestEventLog {
  notices: Array<{ level: "info" | "warning" | "error"; text: string }>;
  lastModels: Model[] | undefined;
  lastThinkingLevels: string[] | undefined;
  /** 最近一次会话切换状态广播（newSession/switchSession 复位断言）。 */
  lastSessionSwitching: boolean | undefined;
  /** 最近一次提示词编辑器保存回填（fillPrompt 广播）。 */
  lastFillPrompt: string | undefined;
  /** 最近一次会话标题广播（对象包裹区分「未广播」与「广播 undefined」）。 */
  lastSessionTitle: { title: string | undefined } | undefined;
  /** 重命名/删除后的立即刷新信号计数（sessionListRefresh 广播断言）。 */
  sessionListRefreshCount: number;
  /** 最近一次会话统计广播（对象包裹区分「未广播」与「广播 null」；
   *  streaming = 广播到达时是否流式中，供「流中实时变动」断言）。 */
  lastSessionStats: { stats: SessionStatsData | null; streaming: boolean } | undefined;
  /** 最近一次环境段广播（folderName + git；对象包裹区分「未广播」与「广播」）。 */
  lastSessionEnv: { env: SessionEnv } | undefined;
  /** 最近一次可 fork 消息广播（forkMessages；fork 选择器数据源）。 */
  lastForkMessages: ForkMessage[] | undefined;
}

/** 暴露给集成测试的钩子接口（通过扩展 exports 获取）。 */
export interface PinelTestApi {
  /** 打开聊天面板（执行 focus 命令以触发 resolveWebviewView）。 */
  openPanel(): Promise<void>;
  sendPrompt(text: string, fileRefs?: string[]): Promise<void>;
  /** @ 添加文件：扫描工作区文件列表（gitignore 过滤；测试钩子）。 */
  getFileList(): Promise<{ items: FileItem[]; truncated: boolean }>;
  abort(): Promise<void>;
  /** 循环切换模型（cycle_model）。 */
  cycleModel(): Promise<void>;
  /** 循环切换思考强度（cycle_thinking_level）。 */
  cycleThinkingLevel(): Promise<void>;
  /** 循环切换 ponytail 档位（/ponytail <next>；lite→full→ultra→lite）。 */
  cyclePonytail(): Promise<void>;
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
  /** 设置自动提交（写 settings.json pinel.autoCommit；插件按轮注入提示词）。 */
  setAutoCommit(enabled: boolean): Promise<void>;
  /** 设置自动压缩阈值（百分比；写全局 settings.json compaction.reserveTokens）。 */
  setCompactionThreshold(percent: number): Promise<void>;
  /** 重启 pi 进程（触发 ChatController.restart）。 */
  restart(): Promise<void>;
  /** Ctrl+G 提示词编辑：以 text 为初始内容打开 VS Code 编辑器（await 编辑器就绪）。 */
  editPrompt(text: string): Promise<void>;
  /** 当前待决提示词临时文件路径（未编辑/已清理为 undefined）。 */
  getPendingPromptUriPath(): string | undefined;
  /** 切换到指定会话文件（会话历史列表选择）。 */
  switchSession(sessionPath: string): Promise<void>;
  /** 新建会话（会话历史顶部按钮）。 */
  newSession(): Promise<void>;
  /** 拉取可 fork 的历史用户消息（get_fork_messages；fork 选择器数据源）。 */
  getForkMessages(): Promise<void>;
  /** 扫描 pi 智能体扩展列表（本地扩展 + settings.json packages；包按 identity 去重）。 */
  getExtensionList(): Promise<ExtensionItem[]>;
  /** 启停扩展（本地重命名 / 包 settings 编辑；无确认弹窗）。 */
  setExtensionEnabled(id: string, kind: ExtensionKind, scope: ExtensionScope, enabled: boolean): Promise<void>;
  /** 卸载扩展（本地删除 / 包 pi remove 或 settings 编辑；无确认弹窗——UI 层 seam 负责）。 */
  uninstallExtension(id: string, kind: ExtensionKind, scope: ExtensionScope, source: string): Promise<void>;
  /** 从历史用户消息 fork 新会话分支（fork RPC；成功后回填输入框）。 */
  forkSession(entryId: string): Promise<void>;
  /** 复制当前活动分支为新会话文件（clone RPC）。 */
  cloneSession(): Promise<void>;
  /** 重命名会话（双路径：当前→RPC set_session_name，非当前→文件追加）。 */
  renameSession(sessionPath: string, name: string): Promise<void>;
  /** 删除会话（当前会话拒绝；无确认弹窗——UI 层 confirmSessionDelete 负责）。 */
  deleteSession(sessionPath: string): Promise<void>;
  /** 会话信息开关（pinel.showSessionStats 配置 + status 广播）。 */
  setShowSessionStats(enabled: boolean): Promise<void>;
  /** 手动压缩会话（原生 RPC compact；customInstructions 可选）。 */
  compact(customInstructions?: string): Promise<void>;
  /** 一键安装 Pinel 插件（spawn pi install npm:@hilariouhiss/pinel）。 */
  installPinelPlugin(): Promise<void>;
  /** 插件目录状态（20 项 + 每项安装态；纯文件扫描不依赖 pi 进程）。 */
  getCatalogState(): Promise<CatalogItemState[]>;
  /** 目录安装（spawn pi install <spec> 逐个执行；测试勿直调——会写真实全局 settings）。 */
  installCatalogEntries(specs: string[]): Promise<void>;
  /** 刷新 Pinel 插件安装态（settings.json 检测；测试断言用）。 */
  refreshPinelPluginState(): Promise<void>;
  /** 最近一次 pinel.workflow 推送缓存（null=未收到/会话切换已清空）。 */
  getPinelWorkflowCache(): PinelWorkflowPayload | null;
  /** 最近一次 pinel.prompt 推送缓存（null=未收到/重启已清空）。 */
  getPinelPromptCache(): PinelPromptPayload | null;
  /** 最近一次 ponytail 状态（statusKey "ponytail" 帧解析缓存；null=未收到/未装）。 */
  getPonytailStatusCache(): PonytailStatus | null;
  /** 最近一次 MCP 状态（statusKey "mcp" 帧解析缓存；null=未收到/进程退出已清空）。 */
  getMcpStatus(): McpStatus | null;
  /** 最近一次 MCP 服务器明细（statusKey "pinel.mcp" 帧解析缓存；null=未收到/重启已清空）。 */
  getPinelMcp(): PinelMcpPayload | null;
  /** Pinel 插件安装态缓存（null=未检测）。 */
  getPinelPluginState(): PinelPluginState | null;  /** 当前会话文件路径（get_state.sessionFile；切换/新建断言用）。 */
  getCurrentSessionFile(): string | undefined;
  /** 会话历史列表（最近一次扫描结果；测试断言，不依赖 DOM）。 */
  getSessionList(): SessionListItem[];
  /** 聊天 header 会话列表（controller.getSessionList 实时扫描；测试断言用）。 */
  getChatSessionList(): Promise<SessionListItem[]>;
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

  controller = new ChatController(output, context.globalState, context.workspaceState);
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

  // Ctrl+G 提示词编辑命令（keybinding when: pinel.inputFocused 限定输入框聚焦）：
  // 通知 webview 取当前输入内容并回发 editPrompt（宿主不维护输入状态）
  context.subscriptions.push(
    vscode.commands.registerCommand("pinel.editPrompt", () => ctrl.triggerEditPrompt()),
  );

  // 测试事件记录：notice / models / thinkingLevels 环形缓冲（最近 100 条），
  // 供集成测试断言（UI 链路不可控，controller 事件即权威）。
  const notices: Array<{ level: "info" | "warning" | "error"; text: string }> = [];
  let lastModels: Model[] | undefined;
  let lastThinkingLevels: string[] | undefined;
  let lastSessionSwitching: boolean | undefined;
  let lastFillPrompt: string | undefined;
  let lastSessionTitle: { title: string | undefined } | undefined;
  let sessionListRefreshCount = 0;
  let lastSessionStats: { stats: SessionStatsData | null; streaming: boolean } | undefined;
  let lastSessionEnv: { env: SessionEnv } | undefined;
  let lastForkMessages: ForkMessage[] | undefined;
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
    } else if (msg.type === "fillPrompt") {
      lastFillPrompt = msg.text;
    } else if (msg.type === "sessionTitle") {
      lastSessionTitle = { title: msg.title };
    } else if (msg.type === "sessionListRefresh") {
      sessionListRefreshCount++;
    } else if (msg.type === "sessionStats") {
      lastSessionStats = { stats: msg.stats, streaming: ctrl.getStatus().isStreaming };
    } else if (msg.type === "sessionEnv") {
      lastSessionEnv = { env: msg.env };
    } else if (msg.type === "forkMessages") {
      lastForkMessages = msg.messages;
    }
  });

  return {
    openPanel: async () => {
      await vscode.commands.executeCommand("pinel.chatView.focus");
    },
    sendPrompt: (text: string, fileRefs?: string[]) => ctrl.sendPrompt({ text, fileRefs }),
    getFileList: () => ctrl.getFileList(),
    abort: () => ctrl.abort(),
    cycleModel: () => ctrl.cycleModel(),
    cycleThinkingLevel: () => ctrl.cycleThinkingLevel(),
    cyclePonytail: () => ctrl.cyclePonytail(),
    getModels: () => ctrl.getModels(),
    setModel: (provider, modelId) => ctrl.setModel(provider, modelId),
    getThinkingLevels: () => ctrl.getThinkingLevels(),
    setThinkingLevel: (level) => ctrl.setThinkingLevel(level),
    setSteeringMode: (mode) => ctrl.setSteeringMode(mode),
    setFollowUpMode: (mode) => ctrl.setFollowUpMode(mode),
    setAutoCompaction: (enabled) => ctrl.setAutoCompaction(enabled),
    setAutoCommit: (enabled) => ctrl.setAutoCommit(enabled),
    setCompactionThreshold: (percent: number) => ctrl.setCompactionThreshold(percent),
    restart: () => ctrl.restart(),
    editPrompt: (text: string) => ctrl.editPrompt(text),
    getPendingPromptUriPath: () => ctrl.getPendingPromptUri()?.fsPath,
    switchSession: (sessionPath: string) => ctrl.switchSession(sessionPath),
    newSession: () => ctrl.newSession(),
    getForkMessages: () => ctrl.getForkMessages(),
    getExtensionList: () => ctrl.getExtensionList(),
    setExtensionEnabled: (id, kind, scope, enabled) => ctrl.setExtensionEnabled(id, kind, scope, enabled),
    uninstallExtension: (id, kind, scope, source) => ctrl.uninstallExtension(id, kind, scope, source),
    forkSession: (entryId: string) => ctrl.forkSession(entryId),
    cloneSession: () => ctrl.cloneSession(),
    renameSession: (sessionPath: string, name: string) => ctrl.renameSession(sessionPath, name),
    deleteSession: (sessionPath: string) => ctrl.deleteSession(sessionPath),
    setShowSessionStats: (enabled: boolean) => ctrl.setShowSessionStats(enabled),
    compact: (customInstructions?: string) => ctrl.compact(customInstructions),
    installPinelPlugin: () => ctrl.installPinelPlugin(),
    getCatalogState: () => ctrl.getCatalogState(),
    installCatalogEntries: (specs) => ctrl.installCatalogEntries(specs),
    refreshPinelPluginState: () => ctrl.refreshPinelPluginState(),
    getPinelWorkflowCache: () => ctrl.getPinelWorkflowCache(),
    getPinelPromptCache: () => ctrl.getPinelPromptCache(),
    getPonytailStatusCache: () => ctrl.getPonytailStatusCache(),
    getMcpStatus: () => ctrl.getMcpStatus(),
    getPinelMcp: () => ctrl.getPinelMcp(),
    getPinelPluginState: () => ctrl.getPinelPluginState(),
    getCurrentSessionFile: () => ctrl.getStatus().sessionFile,
    getSessionList: () => historyProvider.getLastList(),
    getChatSessionList: () => ctrl.getSessionList(),
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
      lastFillPrompt,
      lastSessionTitle,
      sessionListRefreshCount,
      lastSessionStats,
      lastSessionEnv,
      lastForkMessages,
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
