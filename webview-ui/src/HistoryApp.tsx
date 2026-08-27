import { useCallback, useEffect, useState } from "react";
import { vscode } from "./index";
import type { HostMessage, SessionListItem } from "./types";
import { formatRelativeTime } from "./utils";
import { SearchBox } from "./components/SearchBox";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import addIcon from "lucide-static/icons/plus.svg";
import editIcon from "lucide-static/icons/pencil.svg";
import deleteIcon from "lucide-static/icons/trash-2.svg";

/**
 * 会话历史视图（主侧边栏）。
 * 顶部新会话按钮（lucide plus 图标）+ 搜索框 + 会话列表
 * （名称/首条消息摘要/相对时间/当前高亮）。
 * 点击会话 → switchSession；点击新会话 → newSession（宿主切换成功后
 * 自动打开次侧边栏聊天视图）。
 * 行右侧操作：lucide pencil 行内编辑重命名（Enter 提交/Esc/blur 取消，提交后
 * 乐观退出编辑态——失败经宿主 notice 反馈）；lucide trash-2 删除（当前会话行
 * 禁用，title 提示）。
 */
export default function HistoryApp() {
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [currentSessionFile, setCurrentSessionFile] = useState<string | undefined>(undefined);
  /** 切换/新建进行中（乐观置位；宿主 sessionSwitching 消息覆盖）。 */
  const [switching, setSwitching] = useState(false);
  /** 搜索关键词（本地过滤 name/预览）。 */
  const [query, setQuery] = useState("");
  /** 行内编辑中的会话路径（同一时刻至多一行；null 无编辑）。 */
  const [editingPath, setEditingPath] = useState<string | null>(null);

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

  /** 提交重命名：乐观退出编辑态；宿主成功后刷新列表、失败 notice。 */
  const submitRename = (path: string, rawName: string) => {
    setEditingPath(null);
    vscode.postMessage({ type: "renameSession", path, name: rawName });
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
          New session
        </span>
      </div>
      {switching && (
        <div className="history-switching">
          <span className="history-switching-spinner" aria-hidden="true" />
          Switching…
        </div>
      )}
      <SearchBox value={query} onChange={setQuery} />
      <div className="history-list">
        {items.length === 0 ? (
          <div className="history-empty">
            <div className="history-empty-title">No sessions</div>
            <div className="history-empty-hint">Click "New session" above to start chatting with Pi</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="history-empty">
            <div className="history-empty-title">No matching sessions</div>
            <div className="history-empty-hint">Try a different keyword</div>
          </div>
        ) : (
          filtered.map((item) => {
            const active = item.path === currentSessionFile;
            const editing = editingPath === item.path;
            return (
              <div key={item.path} className={`history-item${active ? " active" : ""}`}>
                {editing ? (
                  // 编辑态渲染 div 而非 button：input 嵌套于 button 内时，浏览器隐式
                  // 激活会让输入框里的 Enter（含中文输入法选词确认）click 父按钮 →
                  // 误触发会话切换；div 无 onClick 彻底隔离（点击行内/输入框均不切换）
                  <div className="history-item-main history-item-main-editing">
                    <div className="history-item-top">
                      <input
                        className="history-item-edit-input"
                        defaultValue={item.name || ""}
                        autoFocus
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => {
                          // isComposing：IME 合成中按 Enter 只是选词确认，不得提交
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            submitRename(item.path, (e.target as HTMLInputElement).value);
                          } else if (e.key === "Escape") {
                            setEditingPath(null);
                          }
                        }}
                        onBlur={() => setEditingPath(null)}
                      />
                      {active && <span className="history-item-badge">Current</span>}
                      <span className="history-item-time">{formatRelativeTime(item.modified)}</span>
                    </div>
                    {item.preview && <div className="history-item-preview">{item.preview}</div>}
                  </div>
                ) : (
                  <button
                    className="history-item-main"
                    onClick={() => switchSession(item.path)}
                    disabled={switching}
                  >
                    <div className="history-item-top">
                      <span className="history-item-name">{item.name || "Untitled session"}</span>
                      {active && <span className="history-item-badge">Current</span>}
                      <span className="history-item-time">{formatRelativeTime(item.modified)}</span>
                    </div>
                    {item.preview && <div className="history-item-preview">{item.preview}</div>}
                  </button>
                )}
                <div className="history-item-actions">
                  <button
                    className="history-item-edit"
                    title="Rename"
                    onClick={() => {
                      if (!switching) {
                        setEditingPath(item.path);
                      }
                    }}
                    disabled={switching}
                    dangerouslySetInnerHTML={{ __html: editIcon }}
                  />
                  <button
                    className="history-item-delete"
                    title={active ? "Current session cannot be deleted" : "Delete session"}
                    onClick={() => vscode.postMessage({ type: "deleteSession", path: item.path })}
                    disabled={switching || active}
                    dangerouslySetInnerHTML={{ __html: deleteIcon }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
