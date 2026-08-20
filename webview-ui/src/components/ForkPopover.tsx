import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { vscode } from "../index";
import type { ForkMessageItem } from "../types";

interface Props {
  /** 触发按钮元素（null 时不渲染）。定位/焦点管理都依赖它。 */
  anchor: HTMLElement | null;
  messages: ForkMessageItem[];
  /** 切换进行中（列表禁用，防连点）。 */
  switching: boolean;
  onClose: () => void;
}

const POPOVER_WIDTH = 240;
const POPOVER_MARGIN = 8;
/** 下方空间不足 160px 或少于上方空间时翻转上方。 */
const MIN_BELOW = 160;
/** 预览截断长度（单行 ellipsis；超出省略）。 */
const PREVIEW_MAX = 120;

/**
 * header「分支」按钮的 fork 选择器弹层：
 * - 数据源：宿主 get_fork_messages（打开时拉取；打开期间为快照语义不实时刷新）
 * - 列表项 = 可 fork 的历史用户消息（序号 + 单行截断预览）；点击即 fork
 *   （close-on-select：选中即关弹层，失败由宿主 error notice，不重开弹层）
 * - 底部固定「Clone current branch」项（不依赖消息列表，空态也可用）
 * - 交互：Esc / 点击外部关闭（Esc 在 window capture 阶段拦截 stopPropagation，
 *   让位于 Composer 的中断/清空分支）；焦点管理对齐 SessionListPopover
 */
export function ForkPopover({ anchor, messages, switching, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number }>({});
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
  //（流式中会 abort）同时触发——弹窗打开时 Esc 只关弹窗。
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

  /** 选中条目：close-on-select（先关弹层再发 fork；宿主负责 notice/回填）。 */
  const selectFork = (entryId: string) => {
    onClose();
    vscode.postMessage({ type: "fork", entryId });
  };

  /** 克隆当前分支（复制为新会话文件）。 */
  const cloneCurrent = () => {
    onClose();
    vscode.postMessage({ type: "cloneSession" });
  };

  if (!anchor) {
    return null;
  }

  return (
    <>
      <div className="fork-popover-overlay" onClick={onClose} />
      <div
        className="fork-popover"
        role="dialog"
        aria-label="Fork from a previous message"
        tabIndex={-1}
        ref={panelRef}
        style={pos}
      >
        <div className="fork-popover-title">Fork from a message</div>
        <div className="fork-popover-list">
          {messages.length === 0 ? (
            <div className="fork-popover-empty">No messages to fork from yet</div>
          ) : (
            messages.map((item, i) => (
              <button
                key={item.entryId}
                className="fork-popover-item"
                title={item.text}
                disabled={switching}
                onClick={() => selectFork(item.entryId)}
              >
                <span className="fork-popover-index">{i + 1}</span>
                <span className="fork-popover-text">
                  {item.text.length > PREVIEW_MAX ? item.text.slice(0, PREVIEW_MAX) + "…" : item.text}
                </span>
              </button>
            ))
          )}
        </div>
        <button className="fork-popover-clone" disabled={switching} onClick={cloneCurrent}>
          Clone current branch
        </button>
      </div>
    </>
  );
}
