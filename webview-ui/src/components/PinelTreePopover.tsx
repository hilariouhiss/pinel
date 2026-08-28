import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { vscode } from "../index";
import type { PinelTree } from "../types";

interface Props {
  /** 触发按钮元素（null 时不渲染）。定位/焦点管理都依赖它。 */
  anchor: HTMLElement | null;
  /** 会话树（插件 pinel.tree 推送；null/空 = 插件未装或树为空）。 */
  tree: PinelTree | null;
  onClose: () => void;
}

const POPOVER_WIDTH = 260;
const POPOVER_MARGIN = 8;
/** 下方空间不足 160px 或少于上方空间时翻转上方。 */
const MIN_BELOW = 160;
/** 预览截断长度（单行 ellipsis；超出省略）。 */
const PREVIEW_MAX = 120;

/**
 * 会话树选择器弹层（SessionStatsBar「Tree」按钮锚定）：
 * - 数据源：插件 pinel.tree 推送（当前分支链 user/assistant 消息节点；实时更新）
 * - 点击节点 → 发 pinelTreeNavigate（宿主发 /pinel-tree <entryId>，插件 navigateTree）；
 *   close-on-select（选中即关弹层，结果由宿主 notice 回报）
 * - 当前叶节点高亮（entryId === leafId）
 * - 交互：Esc / 点击外部关闭；焦点管理对齐 ForkPopover
 */
export function PinelTreePopover({ anchor, tree, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number }>({});
  const triggerRef = useRef<HTMLElement | null>(null);

  // 锚定定位：渲染后按按钮实际位置计算；窗口尺寸变化时重算（对齐 ForkPopover）
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

  // Esc 关闭：capture 阶段拦截 + stopPropagation（对齐 ForkPopover）
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

  // 打开时焦点移入弹层；关闭时焦点还原到触发按钮
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

  /** 选中节点：close-on-select（宿主发 /pinel-tree；结果 notice 回报）。 */
  const selectNode = (entryId: string) => {
    onClose();
    vscode.postMessage({ type: "pinelTreeNavigate", entryId });
  };

  if (!anchor) {
    return null;
  }

  const nodes = tree?.nodes ?? [];

  return (
    <>
      <div className="pinel-tree-overlay" onClick={onClose} />
      <div
        className="pinel-tree-popover"
        role="dialog"
        aria-label="Session tree"
        tabIndex={-1}
        ref={panelRef}
        style={pos}
      >
        <div className="pinel-tree-title">Session tree</div>
        <div className="pinel-tree-list">
          {nodes.length === 0 ? (
            <div className="pinel-tree-empty">
              No tree yet — install the Pinel plugin to enable session tree navigation
            </div>
          ) : (
            nodes.map((node, i) => (
              <button
                key={node.entryId}
                className={`pinel-tree-item${node.entryId === tree?.leafId ? " current" : ""}`}
                title={node.text}
                onClick={() => selectNode(node.entryId)}
              >
                <span className="pinel-tree-index">{i + 1}</span>
                <span className="pinel-tree-role">{node.role === "user" ? "🧑" : "🤖"}</span>
                <span className="pinel-tree-text">
                  {node.text.length > PREVIEW_MAX ? node.text.slice(0, PREVIEW_MAX) + "…" : node.text}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}
