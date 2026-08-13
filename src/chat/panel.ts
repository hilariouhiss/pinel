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

type WebviewInMessage = WebviewPromptMessage | WebviewAbortMessage | WebviewRestartMessage;

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
    webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage((msg: WebviewInMessage) => this.handleMessage(msg));

    // 懒启动 + 状态重放（隐藏重显时也能恢复流式状态）
    void this.controller.ensureStarted();
    this.controller.fireSnapshot();
  }

  private post(msg: OutMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  private handleMessage(msg: WebviewInMessage): void {
    switch (msg.type) {
      case "sendPrompt":
        void this.controller.sendPrompt({ text: msg.text, images: msg.images });
        break;
      case "abort":
        void this.controller.abort();
        break;
      case "restart":
        void this.controller.restart();
        break;
    }
  }
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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
</head>
<body>
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
