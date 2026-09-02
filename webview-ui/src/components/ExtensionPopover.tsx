import { useEffect, useRef } from "react";
import type { CatalogItem, ExtensionItem, PinelPluginState } from "../types";
import { extensionRowKey, updatableItems } from "../extension-updates";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import deleteIcon from "lucide-static/icons/trash-2.svg";
import refreshIcon from "lucide-static/icons/refresh-cw.svg";
import xIcon from "lucide-static/icons/x.svg";

/** 视图选项（顺序 = UI 顺序；catalog = 插件目录，本地视图不请求宿主扩展列表）。 */
const VIEW_OPTIONS: { value: "all" | "catalog"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "catalog", label: "Catalog" },
];

interface Props {
  /** 触发按钮元素引用（非 null 即打开，仅作开关信号；焦点管理自记录触发按钮）。 */
  anchor: HTMLElement | null;
  items: ExtensionItem[];
  /** 当前视图（catalog 为本地视图；all 由宿主拉取合并列表）。 */
  view: "all" | "catalog";
  /** Pinel 插件安装态（null=未检测）；offer 显示安装区（仅管理视图）。 */
  pinelPluginState: PinelPluginState | null;
  /** 插件目录项（含安装态；宿主 catalogState 消息）。 */
  catalog: CatalogItem[];
  /** 安装中的 installSpec 集合（防重复点击；宿主刷新时清除）。 */
  installing: Set<string>;
  /** 更新中的行键（按钮置忙防重复点击）。 */
  updating: Set<string>;
  /** 手动刷新更新检查（force 绕过缓存）。 */
  onCheckUpdates: (force: boolean) => void;
  /** 单行更新（官方 pi update 路径）。 */
  onUpdate: (item: ExtensionItem) => void;
  /** 全部更新（targets = updatableItems）。 */
  onUpdateAll: (targets: ExtensionItem[]) => void;
  onInstallPinelPlugin: () => void;
  /** 目录单包安装（spec = installSpec）。 */
  onInstallCatalogEntry: (spec: string) => void;
  /** 目录按组默认集安装（group + 实际 installSpec 列表，供 busy 标记）。 */
  onInstallCatalogGroup: (group: "pi-packages" | "rpiv-mono" | "recommended", specs: string[]) => void;
  onChangeView: (view: "all" | "catalog") => void;
  onToggle: (item: ExtensionItem, enabled: boolean) => void;
  onUninstall: (item: ExtensionItem) => void;
  onClose: () => void;
}

/**
 * 信息条 Extensions chip 的扩展管理弹层（屏幕居中模态，同 config-popover 模式）：
 * - 数据源：宿主 getExtensionList(view)（打开/切视图时按视图拉取；启停/卸载后宿主重发刷新）
 * - All/Catalog 两态切换 + Catalog 插件目录视图（宿主 catalogState）
 * - All 视图：本地扩展不去重（global/local 徽标区分范围）；包按 identity 去重（项目覆盖优先）
 * - catalog 视图：单列表按名称字母排序，每项 Install 按钮 + 已装态 + compat 标注
 *   （tui-only/limited 置灰徽标 + title 说明）；顶部批量安装：推荐集 / rpiv 默认集三包 /
 *   pi-packages git 整仓；安装中按钮禁用防重复点击
 * - 启停/卸载不关弹层（可连续操作）；reload 提示由宿主原生弹框处理
 * - 交互：Esc / 点击外部 / 标题栏关闭按钮关闭（Esc 在 window capture 阶段拦截
 *   stopPropagation，让位于 Composer 的中断/清空分支）；焦点管理对齐 SessionListPopover
 */
export function ExtensionPopover({
  anchor,
  items,
  view,
  pinelPluginState,
  catalog,
  installing,
  updating,
  onCheckUpdates,
  onUpdate,
  onUpdateAll,
  onInstallPinelPlugin,
  onInstallCatalogEntry,
  onInstallCatalogGroup,
  onChangeView,
  onToggle,
  onUninstall,
  onClose,
}: Props) {
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
  // Update all 目标（管理视图才有更新行；catalog 自身无）
  const updatable = view !== "catalog" ? updatableItems(items) : [];
  const updateAllBusy = updatable.some((i) => updating.has(extensionRowKey(i)));

  const renderRow = (item: ExtensionItem) => {
    const busy = updating.has(extensionRowKey(item));
    return (
      <div key={extensionRowKey(item)} className="extension-item">
        <div className="extension-item-main">
          <span className="extension-item-name" title={item.source}>
            {item.name}
          </span>
          {item.sourceKind && (
            <span className="extension-item-badge kind">{item.sourceKind}</span>
          )}
          {/* 范围徽标：global = 全局（agentDir）；local = 项目本地（<workspace>/.pi） */}
          <span className="extension-item-badge">{item.scope === "global" ? "global" : "local"}</span>
          {item.filtered && <span className="extension-item-tag">filtered</span>}
          <span className="extension-item-version">{item.version ?? "—"}</span>
          {item.update === "available" && (
            <button
              className="extension-item-update-btn"
              disabled={busy}
              title={
                item.latestVersion
                  ? `Installed ${item.version ?? "?"} → latest ${item.latestVersion}`
                  : "Update available"
              }
              onClick={() => onUpdate(item)}
            >
              {busy ? "Updating…" : "Update"}
            </button>
          )}
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
  };

  const renderSection = (title: string, list: ExtensionItem[]) =>
    list.length === 0 ? null : (
      <div className="extension-popover-section">
        <div className="extension-popover-title">{title}</div>
        {list.map(renderRow)}
      </div>
    );

  // 目录行渲染。
  const renderCatalogRow = (e: CatalogItem) => {
    const busy = installing.has(e.installSpec);
    return (
      <div key={e.id} className="extension-item catalog-item">
        <div className="extension-item-main">
          <span className="extension-item-name" title={e.installSpec}>
            {e.name}
          </span>
          {e.compat !== "ok" && (
            <span className={`extension-item-badge compat-${e.compat}`} title={e.compatNote ?? ""}>
              {e.compat === "tui-only" ? "TUI only" : "limited"}
            </span>
          )}
          {e.defaultSet && <span className="extension-item-tag">default</span>}
          {e.recommended && <span className="extension-item-tag">recommended</span>}
          <span className="catalog-item-desc" title={e.description}>
            {e.description}
          </span>
        </div>
        {e.state === "installed" ? (
          <span className="catalog-item-installed">Installed</span>
        ) : (
          <button
            className="catalog-item-install"
            disabled={busy}
            title={e.installSpec}
            onClick={() => onInstallCatalogEntry(e.installSpec)}
          >
            {busy ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    );
  };

  // 目录单列表：全部条目按名称字母排序（推荐集不重复置顶，用 recommended/default 标签区分），
  // 顶部一行批量安装按钮（推荐集 12 / rpiv 默认集三包 / pi-packages git 整仓）。
  const renderCatalog = () => {
    const sorted = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
    const recs = sorted.filter((e) => e.recommended);
    const recPending = recs.filter((e) => e.state !== "installed");
    const recBusy = recs.some((e) => installing.has(e.installSpec));
    const defaults = sorted.filter((e) => e.defaultSet);
    const defaultBusy = defaults.some((e) => installing.has(e.installSpec));
    const defaultInstalled = defaults.length > 0 && defaults.every((e) => e.state === "installed");
    return (
      <div className="catalog-groups">
        <div className="extension-popover-section">
          <div className="extension-popover-title catalog-group-header catalog-batch-row">
            <button
              className="catalog-group-install"
              disabled={recPending.length === 0 || recBusy}
              title={`Install ${recPending.length} recommended package${recPending.length === 1 ? "" : "s"}`}
              onClick={() => onInstallCatalogGroup("recommended", recs.map((e) => e.installSpec))}
            >
              {recBusy ? "Installing…" : `Install recommended (${recPending.length})`}
            </button>
            <button
              className="catalog-group-install"
              disabled={defaultInstalled || defaultBusy}
              title="Install default set: rpiv-todo, rpiv-ask-user-question, rpiv-voice"
              onClick={() => onInstallCatalogGroup("rpiv-mono", defaults.map((e) => e.installSpec))}
            >
              {defaultBusy ? "Installing…" : "Install default set"}
            </button>
            <button
              className="catalog-group-install"
              title="Install all 9 packages (git: github.com/gotgenes/pi-packages)"
              onClick={() => onInstallCatalogGroup("pi-packages", [])}
            >
              Install all
            </button>
          </div>
          {sorted.map(renderCatalogRow)}
        </div>
      </div>
    );
  };

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
          {updatable.length > 0 && (
            <button
              className="extension-update-all"
              disabled={updateAllBusy}
              title={`pi update ${updatable.length} package${updatable.length === 1 ? "" : "s"}`}
              onClick={() => onUpdateAll(updatable)}
            >
              {updateAllBusy ? "Updating…" : `Update all (${updatable.length})`}
            </button>
          )}
          <button
            className="popover-refresh"
            aria-label="Check for updates"
            title="Check for updates"
            onClick={() => onCheckUpdates(true)}
            dangerouslySetInnerHTML={{ __html: refreshIcon }}
          />
          <button className="popover-close" aria-label="Close extensions" onClick={onClose}>
            <span dangerouslySetInnerHTML={{ __html: xIcon }} />
          </button>
        </div>
        {/* 内容独立滚动区：关闭按钮行留在滚动区外（见 styles.css .popover-body） */}
        <div className="popover-body">
        <div className="extension-view-switch" role="tablist" aria-label="Extension scope">
          {VIEW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              role="tab"
              aria-selected={view === opt.value}
              className={`extension-view-tab${view === opt.value ? " active" : ""}`}
              onClick={() => onChangeView(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {view !== "catalog" && pinelPluginState !== "installed" && (
          <div className="pinel-plugin-install">
            <span className="pinel-plugin-install-text">
              {pinelPluginState === "removed"
                ? "Pinel plugin was removed — reinstall to restore live prompt composition, MCP status &amp; workflow tracking"
                : "Install the Pinel plugin to unlock live prompt composition, MCP status &amp; workflow tracking"}
            </span>
            <button className="pinel-plugin-install-btn" onClick={onInstallPinelPlugin}>
              Install
            </button>
          </div>
        )}
        {view === "catalog" ? (
          catalog.length === 0 ? (
            <div className="extension-popover-empty">No catalog data</div>
          ) : (
            renderCatalog()
          )
        ) : items.length === 0 ? (
          <div className="extension-popover-empty">No extensions found</div>
        ) : (
          <>
            {renderSection("Extensions", local)}
            {renderSection("Packages", packages)}
          </>
        )}
        </div>{/* /popover-body */}
      </div>
    </>
  );
}
