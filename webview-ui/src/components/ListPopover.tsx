import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ListItem {
  id: string;
  label: string;
  detail?: string;
}

interface Props {
  /** 触发按钮元素（null 时不渲染）。定位/焦点管理都依赖它。 */
  anchor: HTMLElement | null;
  items: ListItem[];
  /** 当前选中项 id（高亮打勾；模型项为 provider+modelId 复合键）。 */
  selectedId: string | null;
  loading: boolean;
  emptyText: string;
  onSelect: (item: ListItem) => void;
  onClose: () => void;
}

/** 弹层宽度（模型名较长，260px 起；超出视口时收缩）。 */
const POPOVER_WIDTH = 260;
const POPOVER_MARGIN = 8;
/** 下方空间不足 120px 或少于上方空间时翻转上方。 */
const MIN_BELOW = 120;

/**
 * 状态栏下拉选择列表（模型/思考强度列表共用）：
 * - 定位：锚定触发按钮——下方优先，空间不足翻转上方；水平左对齐，超右缘右对齐
 * - 交互：Esc / 点击外部关闭（Esc 在 window capture 阶段拦截 stopPropagation，
 *   让位于 Composer 的中断/清空分支）；方向键导航 + Enter 选中；选中项 ✓
 * - 焦点：打开时移入弹层（键盘用户无需重新 Tab），关闭时还原到触发按钮
 * - 状态：loading 骨架 / 空列表提示（宿主不 fire 空列表，此处为防御渲染）
 */
export function ListPopover({ anchor, items, selectedId, loading, emptyText, onSelect, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number }>({});
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLElement | null>(null);

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
    setHighlight(0);
    return () => {
      if (triggerRef.current && triggerRef.current.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [anchor]);

  // items 缩短（迟到响应替换等）时钳制高亮，防止越界（Enter 静默无操作）
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(items.length - 1, 0)));
  }, [items.length]);

  if (!anchor) {
    return null;
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[highlight];
      if (item) {
        onSelect(item);
      }
    }
  };

  return (
    <>
      <div className="list-popover-overlay" onClick={onClose} />
      <div
        className="list-popover"
        role="listbox"
        aria-label="选择列表"
        tabIndex={-1}
        ref={panelRef}
        style={pos}
        onKeyDown={onKeyDown}
      >
        {loading ? (
          <div className="list-popover-hint">加载中…</div>
        ) : items.length === 0 ? (
          <div className="list-popover-hint">{emptyText}</div>
        ) : (
          items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === selectedId}
              className={`list-popover-item${i === highlight ? " active" : ""}${item.id === selectedId ? " selected" : ""}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => onSelect(item)}
            >
              <span className="list-popover-item-label">{item.label}</span>
              {item.id === selectedId && <span className="list-popover-check">✓</span>}
              {item.detail && <span className="list-popover-item-detail">{item.detail}</span>}
            </button>
          ))
        )}
      </div>
    </>
  );
}
