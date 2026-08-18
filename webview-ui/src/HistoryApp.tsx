import { useCallback, useEffect, useState } from "react";
import { vscode } from "./index";
import type { HostMessage, SessionListItem } from "./types";

/**
 * 会话历史视图（主侧边栏）。
 * 顶部新会话按钮 + 会话列表（名称/首条消息摘要/相对时间/当前高亮）。
 * 点击会话 → switchSession；点击新会话 → newSession（宿主切换成功后
 * 自动打开次侧边栏聊天视图）。
 */

/** 相对时间（分钟/小时/天/日期）。 */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) {
    return "刚刚";
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} 天前`;
  }
  return new Date(ts).toLocaleDateString();
}

export default function HistoryApp() {
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [currentSessionFile, setCurrentSessionFile] = useState<string | undefined>(undefined);
  /** 切换/新建进行中（乐观置位；宿主 sessionSwitching 消息覆盖）。 */
  const [switching, setSwitching] = useState(false);

  const handleMessage = useCallback((event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case "sessionList":
        setItems(msg.items);
        setCurrentSessionFile(msg.currentSessionFile);
        break;
      case "sessionSwitching":
        setSwitching(msg.switching);
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    // 挂载握手：宿主重发列表（resolve 时广播可能早于 webview 异步加载）
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const newSession = () => {
    if (switching) {
      return; // 防连点
    }
    vscode.postMessage({ type: "newSession" });
    setSwitching(true);
  };

  const switchSession = (sessionPath: string) => {
    if (switching) {
      return;
    }
    vscode.postMessage({ type: "switchSession", path: sessionPath });
    setSwitching(true);
  };

  return (
    <div className="history-root">
      <button className="history-new-button" onClick={newSession} disabled={switching}>
        <span className="history-new-icon" aria-hidden="true">
          ＋
        </span>
        新会话
      </button>
      {switching && (
        <div className="history-switching">
          <span className="history-switching-spinner" aria-hidden="true" />
          正在切换…
        </div>
      )}
      <div className="history-list">
        {items.length === 0 ? (
          <div className="history-empty">
            <div className="history-empty-title">暂无会话</div>
            <div className="history-empty-hint">点击上方「新会话」开始与 Pi 对话</div>
          </div>
        ) : (
          items.map((item) => {
            const active = item.path === currentSessionFile;
            return (
              <button
                key={item.path}
                className={`history-item${active ? " active" : ""}`}
                onClick={() => switchSession(item.path)}
                disabled={switching}
              >
                <div className="history-item-top">
                  <span className="history-item-name">{item.name || "未命名会话"}</span>
                  {active && <span className="history-item-badge">当前</span>}
                  <span className="history-item-time">{formatRelativeTime(item.modified)}</span>
                </div>
                {item.preview && <div className="history-item-preview">{item.preview}</div>}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
