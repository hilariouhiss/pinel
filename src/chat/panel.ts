import * as vscode from "vscode";
import { confirmExtensionReload, confirmExtensionUninstall, confirmSessionDelete, type ChatController, type OutMessage } from "./controller";
import { installSpecsForGroup } from "./catalog";

interface WebviewPromptMessage {
  type: "sendPrompt";
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  /** @ 文件引用（webview 发送时从文本解析；宿主 attachFileRefs 消费）。 */
  fileRefs?: string[];
}

interface WebviewAbortMessage {
  type: "abort";
}

interface WebviewCopyTextMessage {
  type: "copyText";
  text: string;
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

interface WebviewRenameSessionMessage {
  type: "renameSession";
  path: string;
  name: string;
}

interface WebviewDeleteSessionMessage {
  type: "deleteSession";
  path: string;
}

interface WebviewToggleSessionStatsMessage {
  type: "toggleSessionStats";
}

interface WebviewSwitchSessionMessage {
  type: "switchSession";
  path: string;
}

interface WebviewNewSessionMessage {
  type: "newSession";
}

interface WebviewGetForkMessagesMessage {
  type: "getForkMessages";
}

interface WebviewForkMessage {
  type: "fork";
  entryId: string;
}

interface WebviewCloneSessionMessage {
  type: "cloneSession";
}

interface WebviewGetFileListMessage {
  type: "getFileList";
}

interface WebviewGetExtensionListMessage {
  type: "getExtensionList";
  /** 弹层视图（默认 all 兼容旧客户端）。 */
  view?: "all" | "global" | "project";
}

interface WebviewSetExtensionEnabledMessage {
  type: "setExtensionEnabled";
  id: string;
  kind: "local" | "package";
  scope: "global" | "project";
  enabled: boolean;
}

interface WebviewUninstallExtensionMessage {
  type: "uninstallExtension";
  id: string;
  kind: "local" | "package";
  scope: "global" | "project";
  source: string;
  name: string;
}

/** 一键安装 Pinel 插件（宿主 spawn pi install npm:@hilariouhiss/pinel）。 */
interface WebviewInstallPinelPluginMessage {
  type: "installPinelPlugin";
}

/** 拉取插件目录（打开目录视图时）。 */
interface WebviewGetCatalogStateMessage {
  type: "getCatalogState";
}

/** 目录单包安装（spec = 目录项 installSpec，宿主仅透传；显式按钮触发非静默）。 */
interface WebviewInstallCatalogEntryMessage {
  type: "installCatalogEntry";
  spec: string;
}

/** 目录按组默认集安装（pi-packages = git 整仓；rpiv-mono = 默认集三包）。 */
interface WebviewInstallCatalogGroupMessage {
  type: "installCatalogGroup";
  group: "pi-packages" | "rpiv-mono";
}

/** 会话树导航（发送 /pinel-tree <entryId> 控制消息；不乐观渲染）。 */
interface WebviewPinelTreeNavigateMessage {
  type: "pinelTreeNavigate";
  entryId: string;
}

/** 手动压缩会话（原生 RPC compact；customInstructions 可选）。 */
interface WebviewCompactMessage {
  type: "compact";
  customInstructions?: string;
}

/** 设置自动压缩阈值（百分比 1–99；宿主换算写全局 settings.json compaction.reserveTokens）。 */
interface WebviewSetCompactionThresholdMessage {
  type: "setCompactionThreshold";
  percent: number;
}

type WebviewInMessage =
  | WebviewPromptMessage
  | WebviewAbortMessage
  | WebviewCopyTextMessage
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
  | WebviewRenameSessionMessage
  | WebviewDeleteSessionMessage
  | WebviewToggleSessionStatsMessage
  | WebviewSwitchSessionMessage
  | WebviewNewSessionMessage
  | WebviewGetForkMessagesMessage
  | WebviewForkMessage
  | WebviewCloneSessionMessage
  | WebviewGetFileListMessage
  | WebviewGetExtensionListMessage
  | WebviewInstallPinelPluginMessage
  | WebviewGetCatalogStateMessage
  | WebviewInstallCatalogEntryMessage
  | WebviewInstallCatalogGroupMessage
  | WebviewPinelTreeNavigateMessage
  | WebviewCompactMessage
  | WebviewSetCompactionThresholdMessage
  | WebviewSetExtensionEnabledMessage
  | WebviewUninstallExtensionMessage
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

  /** 扩展弹层最近请求的视图（启停/卸载后刷新沿用，M1）。 */
  private lastExtensionView: "all" | "global" | "project" = "all";

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
        // 注：fileRefs 透传路径无自动化覆盖（集成测试走 PinelTestApi 直调 controller
        // 绕过 panel——2026-08-28 修复前此处曾静默丢弃 fileRefs，UI 链路未端到端生效）
        void this.controller.sendPrompt({ text: msg.text, images: msg.images, fileRefs: msg.fileRefs });
        break;
      case "abort":
        void this.controller.abort();
        break;
      case "copyText":
        // 剪切板桥：webview 内 navigator.clipboard 在 VS Code 环境不可靠（权限/手势限制），
        // 经宿主 vscode.env.clipboard 写入（权威路径）
        void vscode.env.clipboard.writeText(msg.text);
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
      case "renameSession":
        void (async () => {
          await this.controller.renameSession(msg.path, msg.name);
          // 弹层数据源是 getSessionList 按需拉取：成功后重拉覆盖当前弹层数据
          await this.postSessionList();
        })();
        break;
      case "deleteSession":
        void (async () => {
          // 破坏性操作：确认后再删（共享 seam，与历史视图行为一致）
          if (!(await confirmSessionDelete(msg.path))) {
            return;
          }
          await this.controller.deleteSession(msg.path);
          await this.postSessionList();
        })();
        break;
      case "switchSession":
        // 聊天视图已在次侧边栏，无需 revealChatView（与历史视图入口不同）
        void this.controller.switchSession(msg.path);
        break;
      case "newSession":
        void this.controller.newSession();
        break;
      case "getForkMessages":
        void this.controller.getForkMessages();
        break;
      case "fork":
        void this.controller.forkSession(msg.entryId);
        break;
      case "cloneSession":
        void this.controller.cloneSession();
        break;
      case "getFileList":
        void this.postFileList();
        break;
      case "getExtensionList":
        this.lastExtensionView = msg.view ?? "all";
        void this.postExtensionList();
        break;
      case "getCatalogState":
        void this.postCatalogState();
        break;
      case "installCatalogEntry":
      case "installCatalogGroup":
        void (async () => {
          const specs =
            msg.type === "installCatalogEntry" ? [msg.spec] : installSpecsForGroup(msg.group);
          await this.controller.installCatalogEntries(specs);
          await this.postExtensionList();
          await this.postCatalogState();
          if (await confirmExtensionReload()) {
            await this.controller.restart();
          }
        })();
        break;
      case "installPinelPlugin":
        void this.controller.installPinelPlugin();
        break;
      case "pinelTreeNavigate":
        // 控制消息：宿主直接发 RPC prompt（/pinel-tree 扩展命令，pi 立即执行）
        void this.controller.sendPrompt({ text: `/pinel-tree ${msg.entryId}`, control: true });
        break;
      case "compact":
        void this.controller.compact(msg.customInstructions);
        break;
      case "setCompactionThreshold":
        void this.controller.setCompactionThreshold(msg.percent);
        break;
      case "setExtensionEnabled":
        void (async () => {
          await this.controller.setExtensionEnabled(msg.id, msg.kind, msg.scope, msg.enabled);
          await this.postExtensionList();
          if (await confirmExtensionReload()) {
            await this.controller.restart();
          }
        })();
        break;
      case "uninstallExtension":
        void (async () => {
          // 破坏性操作：确认后再卸载（共享 seam，PinelTestApi 直调不卡框）
          if (!(await confirmExtensionUninstall(msg.name))) {
            return;
          }
          await this.controller.uninstallExtension(msg.id, msg.kind, msg.scope, msg.source);
          await this.postExtensionList();
          if (await confirmExtensionReload()) {
            await this.controller.restart();
          }
        })();
        break;
      case "toggleSessionStats":
        // 开关是 pinel UI 偏好（不依赖 pi 运行）：取当前 status 值翻转
        void this.controller.setShowSessionStats(!this.controller.getStatus().showSessionStats);
        break;
    }
  }

  /** 扫描工作区文件并回发（@ 添加文件数据源；每次打开时实时扫描）。 */
  private async postFileList(): Promise<void> {
    try {
      const { items, truncated } = await this.controller.getFileList();
      this.post({ type: "fileList", items, truncated });
    } catch {
      // 扫描异常：不弹 notice（弹窗空列表即可），仅忽略
    }
  }

  /** 扫描扩展列表并回发（扩展管理弹层数据源；每次打开/操作后实时扫描，沿用最近请求视图）。 */
  private async postExtensionList(): Promise<void> {
    try {
      const items = await this.controller.getExtensionList(this.lastExtensionView);
      this.post({
        type: "extensionList",
        items,
        projectAvailable: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
      });
    } catch {
      // 扫描异常：不弹 notice（弹层空列表即可），仅忽略
    }
  }

  /** 扫描插件目录并回发（目录视图数据源；每次打开/安装后实时扫描）。 */
  private async postCatalogState(): Promise<void> {
    try {
      const entries = await this.controller.getCatalogState();
      this.post({ type: "catalogState", entries });
    } catch {
      // 扫描异常：不弹 notice（弹层空列表即可），仅忽略
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
  const fontRegularUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "fonts", "MapleMono-NF-Regular.ttf"));
  const fontBoldUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "fonts", "MapleMono-NF-Bold.ttf"));
  const fontItalicUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "fonts", "MapleMono-NF-Italic.ttf"));

  // CSP：禁止远程内容；脚本仅允许本 bundle（nonce）；样式允许内联 + 本地 bundle
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'unsafe-inline' ${webview.cspSource}`,
    "img-src data:",
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Pinel</title>
  <style>
    @font-face {
      font-family: "Maple Mono NF";
      src: url("${fontRegularUri}") format("truetype");
      font-weight: 400;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: "Maple Mono NF";
      src: url("${fontBoldUri}") format("truetype");
      font-weight: 700;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: "Maple Mono NF";
      src: url("${fontItalicUri}") format("truetype");
      font-weight: 400;
      font-style: italic;
      font-display: block;
    }
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
