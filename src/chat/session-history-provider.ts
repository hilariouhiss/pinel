import * as vscode from "vscode";
import { scanSessions, toItem, resolveSessionsRoot, type SessionListItem } from "./session-history";
import type { ChatController } from "./controller";
import { getPanelHtml } from "./panel";

/**
 * 会话历史视图（主侧边栏 WebviewViewProvider）。
 *
 * 数据链路：pi RPC 无"列出会话"命令，列表由宿主直接扫描会话存储目录
 * （纯函数见 session-history.ts；布局：默认 <~/.pi/agent/sessions>/--<cwd>--/，
 * 自定义 pinel.sessionDir 时无 cwd 子目录）。当前会话高亮取
 * controller 状态中的 sessionFile（get_state 解析）。
 *
 * 刷新时机：视图 resolve/ready/refresh、controller 广播 sessionListChanged
 * （settle 每回合 + 切换/新建成功后）；settle 高频信号走 5s 节流，
 * sessionFile 变化强制立即刷新（高亮需要及时）。
 */

/** 会话列表项（webview 协议镜像；时间用 epoch ms 便于 JSON 序列化）。 */
export type { SessionListItem } from "./session-history";

interface SessionListMessage {
  type: "sessionList";
  items: SessionListItem[];
  currentSessionFile?: string;
}

/** 转发给历史视图的切换状态（HistoryApp 的 switching 指示）。 */
interface SessionSwitchingMessage {
  type: "sessionSwitching";
  switching: boolean;
}

/** 打开/聚焦次侧边栏聊天视图（切换/新建成功后调用）。
 * 顺序：先保证次侧边栏可见（focusSecondarySideBar 非 toggle，已可见时仅聚焦），
 * 再聚焦聊天视图本身。 */
export async function revealChatView(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.focusSecondarySideBar");
  } catch {
    // 旧版本无此命令：忽略，交由 chatView.focus 兜底
  }
  try {
    await vscode.commands.executeCommand("pinel.chatView.focus");
  } catch {
    // 视图不可用时忽略
  }
}

type HistoryInMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "newSession" }
  | { type: "switchSession"; path: string };

/** 刷新节流：settled 每回合都广播 sessionListChanged，5s 内不重复扫描。 */
const REFRESH_THROTTLE_MS = 5000;

export class SessionHistoryProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pinel.sessionHistory";

  private view: vscode.WebviewView | undefined;
  private lastRefreshAt = 0;
  private lastSessionFile: string | undefined;
  /** 最近一次扫描的列表（测试钩子）。 */
  private lastList: SessionListItem[] = [];
  /** scan 代际：并发扫描乱序保护（旧 scan 完成后丢弃过期结果）。 */
  private scanGeneration = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {
    // 刷新信号：settled（会话数据可能更新）与切换/新建成功后广播
    controller.onChange.event((msg) => {
      if (msg.type === "sessionListChanged") {
        void this.refreshThrottled();
      } else if (msg.type === "snapshot") {
        // 会话文件变化（切换/新建/重启）→ 高亮必须及时，绕过节流
        const sf = this.controller.getStatus().sessionFile;
        if (sf !== this.lastSessionFile) {
          void this.refresh();
        } else {
          void this.refreshThrottled();
        }
      } else if (msg.type === "sessionSwitching") {
        // 转发切换状态给历史视图（按钮 loading 指示）
        this.post({ type: "sessionSwitching", switching: msg.switching } as SessionSwitchingMessage);
      }
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = getPanelHtml(webviewView.webview, this.extensionUri, "history");
    webviewView.webview.onDidReceiveMessage((msg: HistoryInMessage) => this.handleMessage(msg));
    void this.refresh();
  }

  private handleMessage(msg: HistoryInMessage): void {
    switch (msg.type) {
      case "ready":
        // 挂载完成握手后重发（resolve 时广播可能早于 webview 异步加载）
        void this.refresh();
        break;
      case "refresh":
        void this.refresh();
        break;
      case "newSession":
        void (async () => {
          await this.controller.newSession();
          await revealChatView();
        })();
        break;
      case "switchSession":
        void (async () => {
          await this.controller.switchSession(msg.path);
          await revealChatView();
        })();
        break;
    }
  }

  /** 节流刷新（settle 高频信号 5s 内合并）。视图未打开时不扫描（避免无谓 IO）。 */
  private async refreshThrottled(): Promise<void> {
    if (!this.view) {
      return;
    }
    const now = Date.now();
    if (now - this.lastRefreshAt < REFRESH_THROTTLE_MS) {
      return;
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    this.lastRefreshAt = Date.now();
    // 并发保护：扫描期间若有更新的 refresh 发起，本结果过期丢弃
    //（修复实测竞态：旧配置的慢 scan 后完成会覆盖新配置的快 scan 结果）
    const gen = ++this.scanGeneration;
    const items = await this.scan();
    if (gen !== this.scanGeneration) {
      return;
    }
    this.lastList = items;
    const currentSessionFile = this.controller.getStatus().sessionFile;
    this.lastSessionFile = currentSessionFile;
    this.post({
      type: "sessionList",
      items,
      currentSessionFile,
    });
  }

  private async scan(): Promise<SessionListItem[]> {
    const configured = vscode.workspace.getConfiguration("pinel").get<string>("sessionDir")?.trim();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const { root, layout } = resolveSessionsRoot(cwd, configured);
    const metas = await scanSessions(root, cwd, layout);
    return metas.map(toItem);
  }

  private post(msg: SessionListMessage | SessionSwitchingMessage): void {
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

  /** 测试钩子：最近一次扫描的列表（集成测试断言，不依赖 DOM）。 */
  getLastList(): SessionListItem[] {
    return [...this.lastList];
  }

  /** 测试钩子：最近一次广播的当前会话文件（高亮断言）。 */
  getLastCurrentSessionFile(): string | undefined {
    return this.lastSessionFile;
  }
}
