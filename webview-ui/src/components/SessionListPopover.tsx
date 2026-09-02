import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { vscode } from "../index";
import { buildSessionTree } from "../session-tree";
import type { SessionListItem } from "../types";
import { formatRelativeTime } from "../utils";
import { SearchBox } from "./SearchBox";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import editIcon from "lucide-static/icons/pencil.svg";
import deleteIcon from "lucide-static/icons/trash-2.svg";

interface Props {
  /** 触发按钮元素（null 时不渲染）。定位/焦点管理都依赖它。 */
  anchor: HTMLElement | null;
  items: SessionListItem[];
  /** 当前会话文件（高亮「当前」徽标）。 */
  currentSessionFile?: string;
  /** 切换进行中（列表禁用，防连点）。 */
  switching: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/** 弹层宽度（会话名/预览较长；240px 与 styles.css .session-popover 同步）。 */
const POPOVER_WIDTH = 240;
const POPOVER_MARGIN = 8;
/** 下方空间不足 160px 或少于上方空间时翻转上方。 */
const MIN_BELOW = 160;

/**
 * 聊天界面 header 的会话历史弹层（右上角下拉）：
 * - 定位：锚定 header 按钮——下方优先，空间不足翻转上方；水平左对齐，超右缘右对齐
 *   （与 ListPopover 同款机制）
 * - 交互：Esc / 点击外部关闭（Esc 在 window capture 阶段拦截 stopPropagation，
 *   让位于 Composer 的中断/清空分支）；列表项点击即切换
 * - 焦点：打开时移入弹层，关闭时还原到触发按钮
 * - 搜索：顶部 SearchBox 本地过滤（name/预览）；弹层为常驻挂载（anchor null 仅
 *   return null），打开时显式重置搜索词；列表按 fork 血缘树形展示（缩进挂父，
 *   见 session-tree.ts）
 * - 列表项复用主侧边栏 history-item 结构与样式（全局类，未作用域化）
 */
export function SessionListPopover({
  anchor,
  items,
  currentSessionFile,
  switching,
  onSelect,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number }>({});
  const triggerRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  /** 行内编辑中的会话路径（同一时刻至多一行；null 无编辑）。 */
  const [editingPath, setEditingPath] = useState<string | null>(null);

  // 打开时重置搜索词与编辑态（组件常驻挂载，useState 跨开关保留）
  useEffect(() => {
    if (anchor) {
      setQuery("");
      setEditingPath(null);
    }
  }, [anchor]);

  // 会话树：与侧边栏 HistoryApp 同构（缩进挂父、根按子树最新活动排序）
  const rows = useMemo(() => buildSessionTree(items), [items]);
  // 本地过滤：名称/预览包含关键词（大小写不敏感）；命中行保留 depth 缩进
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? rows.filter(
        (r) =>
          r.item.name?.toLowerCase().includes(keyword) ||
          r.item.preview?.toLowerCase().includes(keyword),
      )
    : rows;

  // 锚定定位：渲染后按按钮实际位置计算；窗口尺寸变化时重算
  useLayoutEffect(() => {
    if (!anchor) {
      return;
    }
    const compute = () => {
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const spaceBelow = vh - rect.bottom;
      const below = spaceBelow >= MIN_BELOW || spaceBelow >= rect.top;
      const leftAligned = rect.left + POPOVER_WIDTH <= vw - POPOVER_MARGIN;
      setPos(
        below
          ? {
              top: rect.bottom + 4,
              left: leftAligned ? rect.left : undefined,
              right: leftAligned ? undefined : vw - rect.right,
            }
          : {
              bottom: vh - rect.top + 4,
              left: leftAligned ? rect.left : undefined,
              right: leftAligned ? undefined : vw - rect.right,
            },
      );
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [anchor]);

  // Esc 关闭：capture 阶段拦截 + stopPropagation，防止 Composer 的 Esc 分支
  //（流式中会 abort）同时触发——弹窗打开时 Esc 只关弹窗。
  // 行内编辑态豁免：window capture 先于 React 冒泡委托执行，input 侧无法拦截——
  // 编辑 input 上的 Esc 交由 input 自身取消编辑（两段式：先取消编辑、再关弹层）；
  // 只豁免 .history-item-edit-input，SearchBox 的 Esc 关弹层行为保留。
  useEffect(() => {
    if (!anchor) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if ((e.target as HTMLElement | null)?.closest?.(".history-item-edit-input")) {
          return;
        }
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [anchor, onClose]);

  // 打开时焦点移入弹层；关闭（anchor 变 null 触发 cleanup）时焦点还原到触发按钮
  useEffect(() => {
    if (!anchor) {
      return;
    }
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (triggerRef.current && triggerRef.current.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [anchor]);

  /** 提交重命名：乐观退出编辑态；宿主成功后刷新列表、失败 notice。 */
  const submitRename = (path: string, rawName: string) => {
    setEditingPath(null);
    vscode.postMessage({ type: "renameSession", path, name: rawName });
  };

  if (!anchor) {
    return null;
  }

  return (
    <>
      <div className="session-popover-overlay" onClick={onClose} />
      <div
        className="session-popover"
        role="dialog"
        aria-label="Session history"
        tabIndex={-1}
        ref={panelRef}
        style={pos}
      >
        <SearchBox value={query} onChange={setQuery} />
        <div className="history-list session-popover-list">
          {items.length === 0 ? (
            <div className="history-empty session-popover-empty">
              <div className="history-empty-title">No sessions</div>
              <div className="history-empty-hint">Click the "New session" button in the header to start chatting with Pi</div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="history-empty session-popover-empty">
              <div className="history-empty-title">No matching sessions</div>
              <div className="history-empty-hint">Try a different keyword</div>
            </div>
          ) : (
            filtered.map(({ item, depth }) => {
              const active = item.path === currentSessionFile;
              const editing = editingPath === item.path;
              return (
                <div
                  key={item.path}
                  className={`history-item${active ? " active" : ""}${depth > 0 ? " history-item-forked" : ""}`}
                  style={depth > 0 ? { marginLeft: Math.min(depth, 4) * 14 } : undefined}
                >
                  {editing ? (
                    // 编辑态渲染 div 而非 button：input 嵌套于 button 内时，浏览器隐式
                    // 激活会让输入框里的 Enter（含中文输入法选词确认）click 父按钮 →
                    // 误触发会话切换（实测 bug）；div 无 onClick 彻底隔离
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
                      onClick={() => onSelect(item.path)}
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
    </>
  );
}
