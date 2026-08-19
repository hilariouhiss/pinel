import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionListItem } from "../types";
import { formatRelativeTime } from "../utils";
import { SearchBox } from "./SearchBox";

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
 *   return null），打开时显式重置搜索词
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

  // 打开时重置搜索词（组件常驻挂载，useState 跨开关保留）
  useEffect(() => {
    if (anchor) {
      setQuery("");
    }
  }, [anchor]);

  // 本地过滤：名称/预览包含关键词（大小写不敏感）
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? items.filter(
        (i) =>
          i.name?.toLowerCase().includes(keyword) || i.preview?.toLowerCase().includes(keyword),
      )
    : items;

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
  //（流式中会 abort）同时触发——弹窗打开时 Esc 只关弹窗
  useEffect(() => {
    if (!anchor) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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

  if (!anchor) {
    return null;
  }

  return (
    <>
      <div className="session-popover-overlay" onClick={onClose} />
      <div
        className="session-popover"
        role="dialog"
        aria-label="会话历史"
        tabIndex={-1}
        ref={panelRef}
        style={pos}
      >
        <SearchBox value={query} onChange={setQuery} />
        <div className="history-list session-popover-list">
          {items.length === 0 ? (
            <div className="history-empty session-popover-empty">
              <div className="history-empty-title">暂无会话</div>
              <div className="history-empty-hint">点击 header 的「新会话」按钮开始与 Pi 对话</div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="history-empty session-popover-empty">
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
                  onClick={() => onSelect(item.path)}
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
    </>
  );
}
