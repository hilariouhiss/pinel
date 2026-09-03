import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ExtensionItem, ModeState, PinelMcp, PinelMcpServer, PinelPrompt, PinelPromptFile, SlashCommand } from "../types";
import { modeResourceView } from "../mode-counts";

interface Props {
  /** 斜杠命令列表（宿主 get_commands 镜像；prompts/skills chip 计数与弹层明细数据源）。 */
  commands: SlashCommand[];
  /** MCP 服务器明细（宿主 statusKey "pinel.mcp" 帧；null=未收到帧 → MCP chip 隐藏）。 */
  pinelMcp: PinelMcp | null;
  /** 提示词组成（宿主 statusKey "pinel.prompt" 帧；null=未收到 → Context chip 占位态）。 */
  pinelPrompt: PinelPrompt | null;
  /** 扩展列表（宿主 getExtensionList 镜像；面板挂载预热拉取，装/卸/启停后宿主重推）。 */
  extensions: ExtensionItem[];
  /** Extensions chip 点击 → 打开 App 侧扩展管理弹层（popover "ext"，居中模态）。 */
  onOpenExtensions: () => void;
  /** 管理弹层开启态（chip 高亮 + aria-expanded）。 */
  extensionsOpen: boolean;
  /** Extensions chip 元素引用（App 持有，ExtensionPopover 开关信号 + 焦点还原锚）。 */
  extensionChipRef: RefObject<HTMLButtonElement | null>;
  /** 模式状态（宿主 modeState 消息；undefined = 未加载 → 计数回退 live/磁盘源）。 */
  modeState?: ModeState | null;
  /** 当前模式名（宿主 pinel.modes.active 镜像；undefined = Default）。 */
  modeName?: string;
  /** 模式弹层开启态（chip 高亮 + aria-expanded）。 */
  modesOpen?: boolean;
  /** 模式 chip 点击 → 打开 App 侧模式管理弹层（popover "mode"）。 */
  onOpenModes?: () => void;
  /** 模式 chip 元素引用（App 持有，ModePopover 开关信号 + 焦点还原锚）。 */
  modeChipRef?: RefObject<HTMLButtonElement | null>;
}

/** 弹层种类（与四个内部弹层 chip 一一对应；null=关闭；Extensions chip 走 App 侧管理弹层不在此列）。 */
type CtxKind = "context" | "skill" | "prompt" | "mcp";

/** 紧凑字符数（K 一位小数；对齐信息条 compact 语义）。 */
function compactChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * 输入卡顶部上下文状态条：Context/Skills/Prompts/Extensions/MCP 计数 chip 行（对齐 pi tui
 * 启动头 [Context][Skills][Prompts][Extensions] 段语义与顺序）+ hover 预览 + 锚定明细弹层（纯展示）：
 * - 可见性：Context 常驻（未收到 pinel.prompt 帧显示 "Context –" 占位，弹层说明等待首轮推送；
 *   计数 = 加载的上下文文件数：自定义系统提示词 + 用户/项目级文件 + 追加段）、
 *   Skills N / Prompts N（N>0 才显示，对齐 pi tui 空段隐藏）、
 *   Extensions N 常驻（原 footer 管理按钮兼任入口：点击打开 App 侧扩展管理弹层，
 *   常驻保证零扩展时目录安装仍可达；计数 = 启用项数）、
 *   MCP n/m（收到 pinel.mcp 帧且服务器非空才显示）
 * - hover 预览：chip 悬停显示紧凑名单（对齐 pi tui 段折叠行），CSS 自绘悬浮条（pointer-events
 *   none，弹层开启时隐藏防双浮层）；点击弹层显示完整明细
 * - Context 弹层 = 提示词组成四段（系统提示词/用户级/项目级/插件注入）：
 *   段行点击展开预览文本（插件侧截断 2000 字符）；插件注入不可按插件拆分
 *   （pi API 只给链式合并结果），合并段 + 注脚说明；Context 0 时弹层留白
 * - Extensions chip 点击 → App 侧扩展管理弹层（浏览/启停/卸载/目录安装，居中模态），
 *   本组件只负责触发与计数，不内部弹层
 * - MCP 弹层 = 服务器明细行：连接状态 + 全局/项目范围 + 工具数
 * - 弹层：chip 上方 bottom 锚定，定位/Esc/焦点三 effect 逐段移植 ModelPopover
 *   （左对齐 + 超右缘右对齐回退 + resize 重算；Esc window capture 拦截
 *   stopPropagation 让位 Composer 的中断/清空分支；打开焦点入弹层、关闭还原触发 chip）
 * - rows 为信息展示（非 listbox 选项），弹层开关是组件内局部 state，
 *   不触碰 App 的弹层枚举
 */
export const ContextBar = memo(function ContextBar({
  commands,
  pinelMcp,
  pinelPrompt,
  extensions,
  onOpenExtensions,
  extensionsOpen,
  extensionChipRef,
  modeState,
  modeName,
  modesOpen = false,
  onOpenModes,
  modeChipRef,
}: Props) {
  const prompts = commands.filter((c) => c.source === "prompt");
  const skills = commands.filter((c) => c.source === "skill");
  // 扩展计数只算启用项（对齐 pi tui [Extensions] 段只列已加载；禁用项在管理弹层中灰显）
  const enabledExtensions = extensions.filter((e) => e.enabled);
  // 模式感知计数：激活自定义模式时 Skills/Extensions chip 一律改用模式勾选集
  // （Default/未加载 → modeView null → 回退 live commands / 磁盘启用项，零回归）
  const modeView = modeResourceView(modeState ?? null);
  const visibleSkills = modeView ? modeView.skills : skills;
  const skillCount = visibleSkills.length;
  const extensionCount = modeView ? modeView.extensions.length : enabledExtensions.length;
  const extensionNames = modeView ? modeView.extensions : enabledExtensions.map((e) => e.name);
  const [open, setOpen] = useState<CtxKind | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const contextChipRef = useRef<HTMLButtonElement>(null);
  const skillChipRef = useRef<HTMLButtonElement>(null);
  const promptChipRef = useRef<HTMLButtonElement>(null);
  const mcpChipRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ bottom?: number; left?: number; right?: number }>({});

  // MCP chip 可见 = 收到帧且服务器列表非空（空列表为适配器关闭清除信号，隐藏）
  const mcpVisible = pinelMcp !== null && pinelMcp.servers.length > 0;
  // MCP 计数：n=已连接，m=启用（非禁用）
  const connectedCount = pinelMcp
    ? pinelMcp.servers.filter((s) => s.status === "connected").length
    : 0;
  const enabledCount = pinelMcp
    ? pinelMcp.servers.filter((s) => s.status !== "disabled").length
    : 0;

  // 当前弹层锚点；种类数据消失（chip 卸载）时按 null 关闭，防重挂载幽灵弹层
  const anchor =
    open === "context"
      ? contextChipRef.current
      : open === "skill"
        ? skillCount > 0
          ? skillChipRef.current
          : null
        : open === "prompt"
          ? prompts.length > 0
            ? promptChipRef.current
            : null
          : open === "mcp" && mcpVisible
            ? mcpChipRef.current
            : null;

  // 锚定定位：chip 上方（bottom 锚定）；左对齐、弹层宽于右缘距离时右对齐回退
  useLayoutEffect(() => {
    if (!anchor) {
      return;
    }
    const compute = () => {
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const leftAligned = rect.left + 240 <= vw - 8;
      setPos({
        bottom: window.innerHeight - rect.top + 4,
        left: leftAligned ? rect.left : undefined,
        right: leftAligned ? undefined : vw - rect.right,
      });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [anchor]);

  // Esc 关闭：capture 阶段拦截 + stopPropagation，防止 Composer 的 Esc 分支
  //（流式中会 abort）同时触发——弹层打开时 Esc 只关弹层
  useEffect(() => {
    if (!anchor) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (expanded !== null) {
          setExpanded(null); // 先收起展开段，再 Esc 才关弹层
          return;
        }
        setOpen(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [anchor, expanded]);

  // 数据消失（如 pi 重启清空组成/命令）时收回弹层，防数据回填后弹层无操作复活抢焦点
  useEffect(() => {
    if (open !== null && anchor === null) {
      setOpen(null);
    }
    if (anchor === null) {
      setExpanded(null); // 展开段不跨弹层生命周期残留
    }
  }, [open, anchor]);

  // 打开时焦点移入弹层；关闭（anchor 变 null 触发 cleanup）时焦点还原到触发 chip
  //（anchor 即当前种类 chip 元素，切换弹层时还原到最新触发 chip）
  useEffect(() => {
    if (!anchor) {
      return;
    }
    panelRef.current?.focus();
    return () => {
      if (anchor.isConnected) {
        anchor.focus();
      }
    };
  }, [anchor]);

  const close = () => {
    setOpen(null);
    setExpanded(null);
  };

  const renderChip = (kind: CtxKind, label: string, hover: string) => {
    const ref =
      kind === "context"
        ? contextChipRef
        : kind === "skill"
          ? skillChipRef
          : kind === "prompt"
            ? promptChipRef
            : mcpChipRef;
    return (
      <span className="ctx-chip-wrap">
        <button
          ref={ref}
          className={`composer-chip context-chip${open === kind ? " open" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open === kind}
          aria-label={hover}
          onClick={() => {
            setExpanded(null);
            setOpen((o) => (o === kind ? null : kind));
          }}
        >
          {label}
        </button>
        <span className="ctx-hover-tip" role="tooltip">
          {hover}
        </span>
      </span>
    );
  };

  /** 组成段行：点击展开预览（key 唯一；body 为空只读行）。 */
  const renderCompRow = (
    key: string,
    label: string,
    meta: string,
    preview?: string,
    note?: string,
  ) => (
    <div key={key} className="ctx-comp-group">
      <button
        type="button"
        className="ctx-comp-row"
        aria-expanded={expanded === key}
        onClick={() => setExpanded((e) => (e === key ? null : key))}
        disabled={!preview && !note}
        title={preview ?? note}
      >
        <span className="ctx-popover-name">{label}</span>
        <span className="ctx-comp-meta">{meta}</span>
      </button>
      {expanded === key && (note || preview) && (
        <div className="ctx-comp-detail">
          {note && <div className="ctx-comp-note">{note}</div>}
          {preview && <pre className="ctx-comp-preview">{preview}</pre>}
        </div>
      )}
    </div>
  );

  /** Context 弹层：提示词组成四段 + 计数脚注；未收到帧时占位说明。 */
  const renderComposition = () => {
    if (!pinelPrompt) {
      return (
        <div className="ctx-popover-row">
          <span className="ctx-popover-desc">等待首轮推送：首条消息发出后（agent_start）由插件推送提示词组成</span>
        </div>
      );
    }
    const p = pinelPrompt;
    // Context 0（无自定义系统提示词/文件/追加段）：弹层留白，不显示启动帧/未发现文件等内置提示
    if (p.files.length === 0 && p.system?.kind !== "custom" && !p.append) {
      return null;
    }
    const userFiles = p.files.filter((f) => f.level === "user");
    const projectFiles = p.files.filter((f) => f.level === "project");
    const fileRow = (f: PinelPromptFile) =>
      renderCompRow(`file:${f.path}`, f.name, compactChars(f.chars), f.preview);
    /** 空上下文文件提示行（启动帧/全帧零文件共用）。 */
    const renderNoFilesRow = () => (
      <div className="ctx-comp-row">
        <span className="ctx-comp-desc">未发现上下文文件（~/.pi/agent/AGENTS.md 或项目 AGENTS.md/CLAUDE.md）</span>
      </div>
    );
    /** 启动帧/降级弹层体：仅文件列表 + 说明（首轮权威全帧到达后覆盖）。 */
    const renderStartupBody = () => (
      <>
        <div className="ctx-comp-row">
          <span className="ctx-comp-desc">启动帧：首条消息发出后补充系统提示词/注入段明细</span>
        </div>
        {userFiles.length > 0 && (
          <>
            <div className="ctx-comp-heading">用户级</div>
            {userFiles.map(fileRow)}
          </>
        )}
        {projectFiles.length > 0 && (
          <>
            <div className="ctx-comp-heading">项目级</div>
            {projectFiles.map(fileRow)}
          </>
        )}
        {userFiles.length === 0 && projectFiles.length === 0 && renderNoFilesRow()}
      </>
    );
    if (p.startup) {
      return renderStartupBody();
    }
    // 全帧渲染路径：system/counts/finalChars 缺一即降级启动帧同款（宿主解析保证全帧完整，纯防御）
    const system = p.system;
    if (!system || !p.counts || p.finalChars === undefined) {
      return renderStartupBody();
    }
    return (
      <>
        {renderCompRow(
          "system",
          "系统提示词",
          `${compactChars(system.chars)} · ${system.kind === "custom" ? "自定义" : "pi 内置"}`,
          system.preview,
        )}
        {userFiles.length === 0 && projectFiles.length === 0 && renderNoFilesRow()}
        {userFiles.length > 0 && (
          <>
            <div className="ctx-comp-heading">用户级</div>
            {userFiles.map(fileRow)}
          </>
        )}
        {projectFiles.length > 0 && (
          <>
            <div className="ctx-comp-heading">项目级</div>
            {projectFiles.map(fileRow)}
          </>
        )}
        {p.append &&
          renderCompRow("append", "追加段", compactChars(p.append.chars), p.append.preview)}
        {p.injected
          ? renderCompRow(
              "injected",
              "插件注入",
              `+${compactChars(p.injected.chars)}`,
              p.injected.preview,
              "注入方不可按插件拆分（pi API 只暴露链式合并结果），此处为合并文本",
            )
          : renderCompRow(
              "injected",
              "插件注入",
              p.injectedUnknown ? "不可差分" : "无",
              undefined,
              p.injectedUnknown
                ? "插件对系统提示词是替换而非追加，无法从最终文本中拆分注入部分"
                : "本回合无插件注入",
            )}
        <div className="ctx-comp-heading">
          最终 {compactChars(p.finalChars)} · 技能 {p.counts.skills} · 工具 {p.counts.tools} · 准则 {p.counts.guidelines}
        </div>
      </>
    );
  };

  // MCP 服务器行状态/范围标签（host 解析产物与 plugin status 枚举对齐）
  const MCP_STATUS_LABELS: Record<PinelMcpServer["status"], string> = {
    connected: "已连接",
    disabled: "已禁用",
    "needs-auth": "需认证",
    failed: "连接失败",
    cached: "缓存",
    "not-connected": "未连接",
    unknown: "未知",
  };

  // 弹层行（纯展示）：skill/prompt = `/name` + 截断描述（title 全文）；mcp = 服务器明细
  const renderRows = () => {
    if (open === "context") {
      return renderComposition();
    }
    if (open === "mcp") {
      if (!pinelMcp) {
        return null;
      }
      return pinelMcp.servers.map((s) => {
        const status = s.status;
        return (
          <div
            key={s.name}
            className="ctx-popover-row ctx-mcp-row"
            title={`${s.name} · ${MCP_STATUS_LABELS[status]} · ${s.scope === "project" ? "项目级" : "全局"}${
              s.toolCount !== undefined ? ` · ${s.toolCount} tools` : ""
            }`}
          >
            <span className="ctx-popover-name ctx-mcp-name">{s.name}</span>
            {s.toolCount !== undefined && (
              <span className="ctx-popover-desc">{s.toolCount} tools</span>
            )}
            <span className={`ctx-mcp-status ${status}`}>{MCP_STATUS_LABELS[status]}</span>
            <span className="ctx-mcp-scope">{s.scope === "project" ? "项目" : "全局"}</span>
          </div>
        );
      });
    }
    const list = open === "prompt" ? prompts : visibleSkills;
    return list.map((c) => (
      <div key={c.name} className="ctx-popover-row" title={c.description}>
        <span className="ctx-popover-name">/{c.name}</span>
        {c.description && <span className="ctx-popover-desc">{c.description}</span>}
      </div>
    ));
  };

  // Context 计数/hover 名单：加载的上下文文件（自定义系统提示词 + 用户/项目级 + 追加段）
  const contextCount = pinelPrompt
    ? pinelPrompt.files.length +
      (pinelPrompt.system?.kind === "custom" ? 1 : 0) +
      (pinelPrompt.append ? 1 : 0)
    : 0;
  const contextHover = !pinelPrompt
    ? "等待首轮推送：首条消息发出后显示上下文组成"
    : [
        pinelPrompt.system?.kind === "custom" ? "系统提示词" : null,
        ...pinelPrompt.files.map((f) => f.name),
        pinelPrompt.append ? "追加段" : null,
      ]
        .filter((s): s is string => s !== null)
        .join(" · ");

  const ariaLabel =
    open === "context"
      ? "Context composition"
      : open === "skill"
        ? "Skills"
        : open === "prompt"
          ? "Prompts"
          : "MCP servers";

  return (
    <>
      <div className={`context-bar${open !== null ? " lifted" : ""}`}>
        {/* 模式 chip 常驻（Context 之前，对齐 pi tui 启动头段顺序的最前位）：
            点击走 App 侧模式管理弹层；先收内部弹层防双浮层 */}
        <span className="ctx-chip-wrap">
          <button
            ref={modeChipRef}
            className={`composer-chip context-chip${modesOpen ? " open" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={modesOpen}
            aria-label="Agent mode"
            title={modeName ? `Mode: ${modeName}` : "Mode: Default"}
            onClick={() => {
              setOpen(null);
              setExpanded(null);
              onOpenModes?.();
            }}
            disabled={!onOpenModes}
          >
            {modeName ?? "Default"}
          </button>
          <span className="ctx-hover-tip" role="tooltip">
            {modeName ? `Mode: ${modeName}（点击切换/管理）` : "Mode: Default（全部资源生效，点击管理）"}
          </span>
        </span>
        {renderChip(
          "context",
          pinelPrompt ? `Context ${contextCount}` : "Context –",
          contextHover,
        )}
        {skillCount > 0 && renderChip("skill", `Skills ${skillCount}`, visibleSkills.map((s) => s.name).join(", "))}
        {prompts.length > 0 && renderChip("prompt", `Prompts ${prompts.length}`, prompts.map((p) => `/${p.name}`).join(", "))}
        {/* Extensions chip 常驻（管理入口不可因零扩展而消失）：点击走 App 侧管理弹层；
            先收内部弹层防双浮层 */}
        <span className="ctx-chip-wrap">
          <button
            ref={extensionChipRef}
            className={`composer-chip context-chip${extensionsOpen ? " open" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={extensionsOpen}
            aria-label="Extensions 管理"
            onClick={() => {
              setOpen(null);
              setExpanded(null);
              onOpenExtensions();
            }}
          >
            {`Extensions ${extensionCount}`}
          </button>
          <span className="ctx-hover-tip" role="tooltip">
            {extensionNames.join(", ") || "无已启用扩展（点击打开管理弹层）"}
          </span>
        </span>
        {mcpVisible &&
          renderChip(
            "mcp",
            `MCP ${connectedCount}/${enabledCount}`,
            pinelMcp.servers.map((s) => s.name).join(", "),
          )}
      </div>
      {anchor && (
        <>
          <div className="session-popover-overlay" onClick={close} />
          <div
            className="model-popover ctx-popover"
            role="dialog"
            aria-label={ariaLabel}
            tabIndex={-1}
            ref={panelRef}
            style={pos}
          >
            {renderRows()}
          </div>
        </>
      )}
    </>
  );
});
