import { useCallback, useEffect, useState } from "react";
import { vscode } from "./index";
import type { HostMessage, SessionListItem } from "./types";
import { formatRelativeTime } from "./utils";
import { SearchBox } from "./components/SearchBox";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import addIcon from "../../media/add.svg";

/**
 * 会话历史视图（主侧边栏）。
 * 顶部新会话按钮（add.svg 图标，透明描边样式）+ 搜索框 + 会话列表
 * （名称/首条消息摘要/相对时间/当前高亮）。
 * 点击会话 → switchSession；点击新会话 → newSession（宿主切换成功后
 * 自动打开次侧边栏聊天视图）。
 */
export default function HistoryApp() {
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [currentSessionFile, setCurrentSessionFile] = useState<string | undefined>(undefined);
  /** 切换/新建进行中（乐观置位；宿主 sessionSwitching 消息覆盖）。 */
  const [switching, setSwitching] = useState(false);
  /** 搜索关键词（本地过滤 name/预览）。 */
  const [query, setQuery] = useState("");

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

  // 本地过滤：名称/预览包含关键词（大小写不敏感）
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? items.filter(
        (i) =>
          i.name?.toLowerCase().includes(keyword) || i.preview?.toLowerCase().includes(keyword),
      )
    : items;

  return (
    <div className="history-root">
      <div className="history-new-row">
        <button
          className="history-new-button"
          onClick={newSession}
          disabled={switching}
          dangerouslySetInnerHTML={{ __html: addIcon }}
        />
        <span className="history-new-label" onClick={newSession}>
          新会话
        </span>
      </div>
      {switching && (
        <div className="history-switching">
          <span className="history-switching-spinner" aria-hidden="true" />
          正在切换…
        </div>
      )}
      <SearchBox value={query} onChange={setQuery} />
      <div className="history-list">
        {items.length === 0 ? (
          <div className="history-empty">
            <div className="history-empty-title">暂无会话</div>
            <div className="history-empty-hint">点击上方「新会话」开始与 Pi 对话</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="history-empty">
            <div className="history-empty-title">无匹配会话</div>
            <div className="history-empty-hint">换个关键词试试</div>
          </div>
        ) : (
          filtered.map((item) => {
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
