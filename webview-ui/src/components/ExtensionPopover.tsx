import { useEffect, useRef } from "react";
import { vscode } from "../index";
import type { ExtensionItem } from "../types";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import deleteIcon from "lucide-static/icons/trash-2.svg";

interface Props {
  /** 触发按钮元素引用（非 null 即打开，仅作开关信号；焦点管理自记录触发按钮）。 */
  anchor: HTMLElement | null;
  items: ExtensionItem[];
  onToggle: (item: ExtensionItem, enabled: boolean) => void;
  onUninstall: (item: ExtensionItem) => void;
  onClose: () => void;
}

/**
 * footer「扩展」按钮的扩展管理弹层（屏幕居中模态，同 config-popover 模式）：
 * - 数据源：宿主 getExtensionList（打开时拉取；每次启停/卸载后宿主重发刷新）
 * - 分组展示：本地扩展（Extensions）+ 包（Packages），每行 name + scope 徽标 +
 *   filtered 标记 + On/Off 启停开关 + 卸载按钮
 * - 启停/卸载不关弹层（可连续操作）；reload 提示由宿主原生弹框处理
 * - 交互：Esc / 点击外部 / 标题栏关闭按钮关闭（Esc 在 window capture 阶段拦截
 *   stopPropagation，让位于 Composer 的中断/清空分支）；焦点管理对齐 SessionListPopover
 */
export function ExtensionPopover({ anchor, items, onToggle, onUninstall, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

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
      >
        <div className="popover-titlebar">
          <span className="popover-titlebar-title">Extensions</span>
          <button className="popover-close" aria-label="Close extensions" onClick={onClose}>
            ×
          </button>
        </div>
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
