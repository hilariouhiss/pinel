import * as vscode from "vscode";
import type { ChatController, OutMessage } from "./controller";

interface WebviewPromptMessage {
  type: "sendPrompt";
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

interface WebviewAbortMessage {
  type: "abort";
}

interface WebviewRestartMessage {
  type: "restart";
}

interface WebviewUiResponseMessage {
  type: "uiResponse";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

interface WebviewReadyMessage {
  type: "ready";
}

interface WebviewQuestionnaireAnswerMessage {
  type: "questionnaireAnswer";
  questionIndex: number;
  answer: unknown;
}

interface WebviewQuestionnaireConfirmMessage {
  type: "questionnaireConfirm";
}

interface WebviewQuestionnaireCancelMessage {
  type: "questionnaireCancel";
}

interface WebviewCycleModelMessage {
  type: "cycleModel";
}

interface WebviewCycleThinkingMessage {
  type: "cycleThinking";
}

interface WebviewGetModelsMessage {
  type: "getModels";
}

interface WebviewSetModelMessage {
  type: "setModel";
  provider: string;
  modelId: string;
}

interface WebviewGetThinkingLevelsMessage {
  type: "getThinkingLevels";
}

interface WebviewSetThinkingLevelMessage {
  type: "setThinkingLevel";
  level: string;
}

interface WebviewSetSteeringModeMessage {
  type: "setSteeringMode";
  mode: "all" | "one-at-a-time";
}

interface WebviewSetFollowUpModeMessage {
  type: "setFollowUpMode";
  mode: "all" | "one-at-a-time";
}

interface WebviewSetAutoCompactionMessage {
  type: "setAutoCompaction";
  enabled: boolean;
}

interface WebviewEditPromptMessage {
  type: "editPrompt";
  text: string;
}

interface WebviewInputFocusMessage {
  type: "inputFocus";
  focused: boolean;
}

interface WebviewGetSessionListMessage {
  type: "getSessionList";
}

interface WebviewSwitchSessionMessage {
  type: "switchSession";
  path: string;
}

interface WebviewNewSessionMessage {
  type: "newSession";
}

type WebviewInMessage =
  | WebviewPromptMessage
  | WebviewAbortMessage
  | WebviewRestartMessage
  | WebviewUiResponseMessage
  | WebviewQuestionnaireAnswerMessage
  | WebviewQuestionnaireConfirmMessage
  | WebviewQuestionnaireCancelMessage
  | WebviewCycleModelMessage
  | WebviewCycleThinkingMessage
  | WebviewGetModelsMessage
  | WebviewSetModelMessage
  | WebviewGetThinkingLevelsMessage
  | WebviewSetThinkingLevelMessage
  | WebviewSetSteeringModeMessage
  | WebviewSetFollowUpModeMessage
  | WebviewSetAutoCompactionMessage
  | WebviewEditPromptMessage
  | WebviewInputFocusMessage
  | WebviewGetSessionListMessage
  | WebviewSwitchSessionMessage
  | WebviewNewSessionMessage
  | WebviewReadyMessage;

/**
 * 副侧边栏聊天面板（WebviewViewProvider）。
 *
 * 视图隐藏/折叠时 webview 会被销毁；重新显示时 resolveWebviewView 再次触发，
 * 此时通过 controller.snapshot() 全量重放当前状态（含未结束的部分消息——
 * get_messages 拿不到 message_end 前的增量）。
 */
export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pinel.chatView";

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {
    controller.onChange.event((msg) => this.post(msg));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = getPanelHtml(webviewView.webview, this.extensionUri, "chat");

    webviewView.webview.onDidReceiveMessage((msg: WebviewInMessage) => this.handleMessage(msg));

    // 懒启动 + 状态重放（隐藏重显时也能恢复流式状态）
    void this.controller.ensureStarted();
    this.controller.fireSnapshot();
  }

  private post(msg: OutMessage): void {
    const view = this.view;
    if (!view) {
      return;
    }
    try {
      void view.webview.postMessage(msg);
    } catch {
      // webview 已销毁（视图隐藏/关闭）时忽略
    }
  }

  private handleMessage(msg: WebviewInMessage): void {
    switch (msg.type) {
      // webview 挂载完成握手：resolve 时同步 fireSnapshot 早于 webview 异步加载，
      // 可能丢失；收到 ready 后重发快照保证重放（视图隐藏重显/重启场景）
      case "ready":
        this.controller.fireSnapshot();
        break;
      case "sendPrompt":
        void this.controller.sendPrompt({ text: msg.text, images: msg.images });
        break;
      case "abort":
        void this.controller.abort();
        break;
      case "restart":
        void this.controller.restart();
        break;
      case "uiResponse":
        this.controller.uiRespond(msg.id, {
          value: msg.value,
          confirmed: msg.confirmed,
          cancelled: msg.cancelled,
        });
        break;
      case "questionnaireAnswer":
        this.controller.handleQuestionnaireAnswer(msg.questionIndex, msg.answer);
        break;
      case "questionnaireConfirm":
        this.controller.handleQuestionnaireConfirm();
        break;
      case "questionnaireCancel":
        this.controller.handleQuestionnaireCancel();
        break;
      case "cycleModel":
        void this.controller.cycleModel();
        break;
      case "cycleThinking":
        void this.controller.cycleThinkingLevel();
        break;
      case "getModels":
        void this.controller.getModels();
        break;
      case "setModel":
        void this.controller.setModel(msg.provider, msg.modelId);
        break;
      case "getThinkingLevels":
        void this.controller.getThinkingLevels();
        break;
      case "setThinkingLevel":
        void this.controller.setThinkingLevel(msg.level);
        break;
      case "setSteeringMode":
        void this.controller.setSteeringMode(msg.mode);
        break;
      case "setFollowUpMode":
        void this.controller.setFollowUpMode(msg.mode);
        break;
      case "setAutoCompaction":
        void this.controller.setAutoCompaction(msg.enabled);
        break;
      case "editPrompt":
        void this.controller.editPrompt(msg.text);
        break;
      case "inputFocus":
        this.controller.setInputFocused(msg.focused);
        break;
      case "getSessionList":
        void this.postSessionList();
        break;
      case "switchSession":
        // 聊天视图已在次侧边栏，无需 revealChatView（与历史视图入口不同）
        void this.controller.switchSession(msg.path);
        break;
      case "newSession":
        void this.controller.newSession();
        break;
    }
  }

  /** 扫描会话列表并回发（聊天 header 弹层数据源；每次打开实时扫描）。 */
  private async postSessionList(): Promise<void> {
    try {
      const items = await this.controller.getSessionList();
      this.post({ type: "sessionList", items, currentSessionFile: this.controller.getStatus().sessionFile });
    } catch {
      // 扫描异常：不弹 notice（弹层空列表即可），仅忽略
    }
  }
}

/**
 * 共享 webview HTML（聊天/会话历史双视图）。
 * - body data-pinel-view 标记视图类型，webview bundle 挂载时按此分支渲染
 * - 内联 #boot-loader 主题化加载动画（webview 挂载前防空白闪烁，
 *   React 挂载后移除）；颜色用 VS Code 主题 CSS 变量随主题变化
 */
export function getPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: "chat" | "history"): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.css"));

  // CSP：禁止远程内容；脚本仅允许本 bundle（nonce）；样式允许内联 + 本地 bundle
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    "img-src data:",
    "font-src 'none'",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Pinel</title>
  <style>
    #boot-loader {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      background: var(--vscode-editor-background);
    }
    #boot-loader .boot-spinner {
      width: 28px; height: 28px; border-radius: 50%;
      border: 3px solid var(--vscode-editorWidget-background);
      border-top-color: var(--vscode-progressBar-background);
      animation: boot-spin 0.8s linear infinite;
    }
    @keyframes boot-spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body data-pinel-view="${view}">
  <div id="boot-loader"><div class="boot-spinner"></div></div>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
