import * as vscode from "vscode";
import { ChatController, type ChatStatus, type ToolCard } from "./chat/controller";
import { ChatPanelProvider } from "./chat/panel";
import type { AgentMessage, ExtensionUiRequest } from "./rpc/protocol";
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
  /** 答复扩展对话框（模拟用户在 webview 中的操作）。 */
  uiRespond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void;
  /** 轮询等待流结束（agent_settled 后 isStreaming=false）。 */
  waitForSettled(timeoutMs: number, baseline?: number): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): PinelTestApi {
  const output = vscode.window.createOutputChannel("Pinel");
  context.subscriptions.push(output);

  const controller = new ChatController(output);
  context.subscriptions.push({ dispose: () => void controller.dispose() });

  const panelProvider = new ChatPanelProvider(context.extensionUri, controller);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pinel.openPanel", async () => {
      await controller.ensureStarted();
      await vscode.commands.executeCommand("pinel.chatView.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pinel.abort", () => controller.abort()),
  );

  return {
    openPanel: async () => {
      await vscode.commands.executeCommand("pinel.chatView.focus");
    },
    sendPrompt: (text: string) => controller.sendPrompt({ text }),
    abort: () => controller.abort(),
    restart: () => controller.restart(),
    getStatus: () => controller.getStatus(),
    getMessages: () => controller.getMessages(),
    getTools: () => controller.getTools(),
    getPartialBlocks: () => controller.getPartialBlocks(),
    getSettledCount: () => controller.getSettledCount(),
    getPendingUi: () => controller.getPendingUi(),
    getTodos: () => controller.getTodos(),
    uiRespond: (id, response) => controller.uiRespond(id, response),
    waitForSettled: async (timeoutMs: number, baseline?: number) => {
      const deadline = Date.now() + timeoutMs;
      // 基线在触发动作之前捕获（调用方传入），避免 settled 在基线记录前就被处理
      const startSettled = baseline ?? controller.getSettledCount();
      let sawStreaming = false;
      while (Date.now() < deadline) {
        const status = controller.getStatus();
        if (status.processState === "error") {
          return;
        }
        if (status.isStreaming) {
          sawStreaming = true;
        }
        // 权威信号：settled 计数前进（不依赖轮询恰好捕获 isStreaming 窗口）
        const settledAdvanced = controller.getSettledCount() > startSettled;
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

export function deactivate(): void {
  // ChatController.dispose 在 subscription 中处理
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
