import * as vscode from "vscode";
import { ChatController, type ChatStatus, type ToolCard } from "./chat/controller";
import { ChatPanelProvider } from "./chat/panel";
import type { AgentMessage, ExtensionUiRequest, SlashCommand } from "./rpc/protocol";
import type { TodoTask } from "./chat/todos";

/** 暴露给集成测试的钩子接口（通过扩展 exports 获取）。 */
export interface PinelTestApi {
  /** 打开聊天面板（执行 focus 命令以触发 resolveWebviewView）。 */
  openPanel(): Promise<void>;
  sendPrompt(text: string): Promise<void>;
  abort(): Promise<void>;
  /** 重启 pi 进程（触发 ChatController.restart）。 */
  restart(): Promise<void>;
  getStatus(): ChatStatus;
  getMessages(): AgentMessage[];
  getTools(): Map<string, ToolCard>;
  /** 当前流式部分消息的展示块（contentIndex 装配产物）。 */
  getPartialBlocks(): Array<{ kind: string; text: string; toolCall?: { id: string; name: string; arguments: string } }>;
  /** 当前已完成的 agent 轮次计数（agent_settled 次数）。 */
  getSettledCount(): number;
  /** 待决的扩展对话框请求。 */
  getPendingUi(): ExtensionUiRequest[];
  /** 当前待办任务快照。 */
  getTodos(): TodoTask[];
  /** 当前可用斜杠命令列表（get_commands 结果；空=未获取/获取失败）。 */
  getCommands(): SlashCommand[];
  /** 模型自愈信息：最近一次初始同步尝试次数与是否自动重启过。 */
  getModelHealInfo(): { attempts: number; autoRestarted: boolean };
  /** 答复扩展对话框（模拟用户在 webview 中的操作）。 */
  uiRespond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void;
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

  context.subscriptions.push(
    vscode.commands.registerCommand("pinel.openPanel", async () => {
      await ctrl.ensureStarted();
      await vscode.commands.executeCommand("pinel.chatView.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pinel.abort", () => ctrl.abort()),
  );

  return {
    openPanel: async () => {
      await vscode.commands.executeCommand("pinel.chatView.focus");
    },
    sendPrompt: (text: string) => ctrl.sendPrompt({ text }),
    abort: () => ctrl.abort(),
    restart: () => ctrl.restart(),
    getStatus: () => ctrl.getStatus(),
    getMessages: () => ctrl.getMessages(),
    getTools: () => ctrl.getTools(),
    getPartialBlocks: () => ctrl.getPartialBlocks(),
    getSettledCount: () => ctrl.getSettledCount(),
    getPendingUi: () => ctrl.getPendingUi(),
    getTodos: () => ctrl.getTodos(),
    getCommands: () => ctrl.getCommands(),
    getModelHealInfo: () => ctrl.getModelHealInfo(),
    uiRespond: (id, response) => ctrl.uiRespond(id, response),
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
