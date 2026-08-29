import { useEffect, useRef } from "react";
import { vscode } from "../index";
import type { PinelTree } from "../types";
// lucide 图标原始文本（esbuild text loader 内联；CSS 覆盖尺寸/stroke 主题自适应）
import userIcon from "lucide-static/icons/user.svg";
import botIcon from "lucide-static/icons/bot.svg";

interface Props {
  /** 是否打开（双击 Esc 入口切换；false 不渲染）。 */
  open: boolean;
  /** 会话树（插件 pinel.tree 推送；null/空 = 插件未装或树为空）。 */
  tree: PinelTree | null;
  onClose: () => void;
}

/** 预览截断长度（单行 ellipsis；超出省略）。 */
const PREVIEW_MAX = 120;

/**
 * 会话树弹层（双击 Esc 打开，面板居中显示）：
 * - 数据源：插件 pinel.tree 推送（当前分支链 user/assistant 消息节点；实时更新）
 * - 点击节点 → 发 pinelTreeNavigate（宿主发 /pinel-tree <entryId>，插件 navigateTree）；
 *   close-on-select（选中即关弹层，结果由宿主 notice 回报）
 * - 当前叶节点高亮（entryId === leafId）
 * - 交互：Esc / 点击外部关闭；居中定位由 .pinel-tree-popover CSS 负责
 */
export function PinelTreePopover({ open, tree, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Esc 关闭：capture 阶段拦截 + stopPropagation（对齐 ForkPopover）
  useEffect(() => {
    if (!open) {
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
  }, [open, onClose]);

  // 打开时焦点移入弹层；关闭时焦点还原
  useEffect(() => {
    if (!open) {
      return;
    }
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (triggerRef.current && triggerRef.current.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [open]);

  /** 选中节点：close-on-select（宿主发 /pinel-tree；结果 notice 回报）。 */
  const selectNode = (entryId: string) => {
    onClose();
    vscode.postMessage({ type: "pinelTreeNavigate", entryId });
  };

  if (!open) {
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
                <span
                  className="pinel-tree-role"
                  dangerouslySetInnerHTML={{ __html: node.role === "user" ? userIcon : botIcon }}
                />
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
