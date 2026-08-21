import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { vscode } from "../index";
import type { ExtensionItem } from "../types";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import deleteIcon from "../../../media/delete.svg";

interface Props {
  /** 触发按钮元素（null 时不渲染）。定位/焦点管理都依赖它。 */
  anchor: HTMLElement | null;
  items: ExtensionItem[];
  onToggle: (item: ExtensionItem, enabled: boolean) => void;
  onUninstall: (item: ExtensionItem) => void;
  onClose: () => void;
}

/** 弹层宽度（扩展名较长；260px）。 */
const POPOVER_WIDTH = 260;
const POPOVER_MARGIN = 8;
/** 下方空间不足 180px 或少于上方空间时翻转上方。 */
const MIN_BELOW = 180;

/**
 * footer「扩展」按钮的扩展管理弹层（锚定扩展按钮）：
 * - 数据源：宿主 getExtensionList（打开时拉取；每次启停/卸载后宿主重发刷新）
 * - 分组展示：本地扩展（Extensions）+ 包（Packages），每行 name + scope 徽标 +
 *   filtered 标记 + On/Off 启停开关 + 卸载按钮
 * - 启停/卸载不关弹层（可连续操作）；reload 提示由宿主原生弹框处理
 * - 交互：Esc / 点击外部关闭（Esc 在 window capture 阶段拦截 stopPropagation，
 *   让位于 Composer 的中断/清空分支）；焦点管理对齐 SessionListPopover
 */
export function ExtensionPopover({ anchor, items, onToggle, onUninstall, onClose }: Props) {
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

  if (!anchor) {
    return null;
  }

  const local = items.filter((i) => i.kind === "local");
  const packages = items.filter((i) => i.kind === "package");

  const renderRow = (item: ExtensionItem) => (
    <div key={`${item.kind}:${item.scope}:${item.id}`} className="extension-item">
      <div className="extension-item-main">
        <span className="extension-item-name" title={item.source}>
          {item.name}
        </span>
        <span className="extension-item-badge">{item.scope}</span>
        {item.filtered && <span className="extension-item-tag">filtered</span>}
      </div>
      <button
        className={`extension-item-toggle${item.enabled ? " on" : ""}`}
        role="switch"
        aria-checked={item.enabled}
        title={item.enabled ? "Disable" : "Enable"}
        onClick={() => onToggle(item, !item.enabled)}
      >
        {item.enabled ? "On" : "Off"}
      </button>
      <button
        className="extension-item-delete"
        title="Uninstall"
        aria-label={`Uninstall ${item.name}`}
        onClick={() => onUninstall(item)}
        dangerouslySetInnerHTML={{ __html: deleteIcon }}
      />
    </div>
  );

  const renderSection = (title: string, list: ExtensionItem[]) =>
    list.length === 0 ? null : (
      <div className="extension-popover-section">
        <div className="extension-popover-title">{title}</div>
        {list.map(renderRow)}
      </div>
    );

  return (
    <>
      <div className="extension-popover-overlay" onClick={onClose} />
      <div
        className="extension-popover"
        role="dialog"
        aria-label="Extensions"
        tabIndex={-1}
        ref={panelRef}
        style={pos}
      >
        {items.length === 0 ? (
          <div className="extension-popover-empty">No extensions found</div>
        ) : (
          <>
            {renderSection("Extensions", local)}
            {renderSection("Packages", packages)}
          </>
        )}
      </div>
    </>
  );
}
