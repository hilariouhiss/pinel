import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { McpStatus, PinelPrompt, PinelPromptFile, SlashCommand } from "../types";

interface Props {
  /** 斜杠命令列表（宿主 get_commands 镜像；prompt/skill chip 计数与弹层明细数据源）。 */
  commands: SlashCommand[];
  /** MCP 服务器摘要（宿主 statusKey "mcp" 帧；null=未收到帧 → MCP chip 隐藏）。 */
  mcpStatus: McpStatus | null;
  /** 提示词组成（宿主 statusKey "pinel.prompt" 帧；null=未收到 → Sys chip 隐藏）。 */
  pinelPrompt: PinelPrompt | null;
}

/** 弹层种类（与四个 chip 一一对应；null=关闭）。 */
type CtxKind = "sys" | "prompt" | "skill" | "mcp";

/** 紧凑字符数（K 一位小数；对齐信息条 compact 语义）。 */
function compactChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/**
 * 输入卡顶部上下文状态条：Sys(提示词组成)/Prompt/Skill/MCP 计数 chip 行 + 锚定明细弹层（纯展示）：
 * - 可见性：Sys（收到 pinel.prompt 帧）、Prompt N / Skill N（N>0 才显示）、
 *   MCP C/N（enabled>0 才显示；connecting 态显示 "MCP …"）；全空 → 整条隐藏（null）
 * - Sys 弹层 = 提示词组成四段（系统提示词/用户级/项目级/插件注入）：
 *   段行点击展开预览文本（插件侧截断 2000 字符）；插件注入不可按插件拆分
 *   （pi API 只给链式合并结果），合并段 + 注脚说明
 * - 弹层：chip 上方 bottom 锚定，定位/Esc/焦点三 effect 逐段移植 ModelPopover
 *   （左对齐 + 超右缘右对齐回退 + resize 重算；Esc window capture 拦截
 *   stopPropagation 让位 Composer 的中断/清空分支；打开焦点入弹层、关闭还原触发 chip）
 * - rows 为信息展示（非 listbox 选项），弹层开关是组件内局部 state，
 *   不触碰 App 的弹层枚举
 */
export function ContextBar({ commands, mcpStatus, pinelPrompt }: Props) {
  const prompts = commands.filter((c) => c.source === "prompt");
  const skills = commands.filter((c) => c.source === "skill");
  const [open, setOpen] = useState<CtxKind | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const sysChipRef = useRef<HTMLButtonElement>(null);
  const promptChipRef = useRef<HTMLButtonElement>(null);
  const skillChipRef = useRef<HTMLButtonElement>(null);
  const mcpChipRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ bottom?: number; left?: number; right?: number }>({});

  // MCP chip 可见 = 收到帧且启用数 > 0（ready 态 0 服务器为清除信号，隐藏）
  const mcpVisible = mcpStatus !== null && mcpStatus.enabled > 0;

  // 当前弹层锚点；种类数据消失（chip 卸载）时按 null 关闭，防重挂载幽灵弹层
  const anchor =
    open === "sys"
      ? pinelPrompt
        ? sysChipRef.current
        : null
      : open === "prompt"
        ? prompts.length > 0
          ? promptChipRef.current
          : null
        : open === "skill"
          ? skills.length > 0
            ? skillChipRef.current
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

  if (!pinelPrompt && prompts.length === 0 && skills.length === 0 && !mcpVisible) {
    return null;
  }

  const close = () => {
    setOpen(null);
    setExpanded(null);
  };

  const renderChip = (kind: CtxKind, label: string, title: string) => {
    const ref = kind === "sys" ? sysChipRef : kind === "prompt" ? promptChipRef : kind === "skill" ? skillChipRef : mcpChipRef;
    return (
      <button
        ref={ref}
        className={`composer-chip context-chip${open === kind ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open === kind}
        title={title}
        onClick={() => {
          setExpanded(null);
          setOpen((o) => (o === kind ? null : kind));
        }}
      >
        {label}
      </button>
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

  /** Sys 弹层：提示词组成四段 + 计数脚注。 */
  const renderComposition = () => {
    const p = pinelPrompt!;
    const userFiles = p.files.filter((f) => f.level === "user");
    const projectFiles = p.files.filter((f) => f.level === "project");
    const fileRow = (f: PinelPromptFile) =>
      renderCompRow(`file:${f.path}`, f.name, compactChars(f.chars), f.preview);
    return (
      <>
        {renderCompRow(
          "system",
          "系统提示词",
          `${compactChars(p.system.chars)} · ${p.system.kind === "custom" ? "自定义" : "pi 内置"}`,
          p.system.preview,
        )}
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

  // 弹层行（纯展示）：prompt/skill = `/name` + 截断描述（title 全文）；mcp = 计数摘要
  const renderRows = () => {
    if (open === "sys") {
      return renderComposition();
    }
    if (open === "mcp") {
      if (!mcpStatus) {
        return null;
      }
      const disabledSuffix = (mcpStatus.disabled ?? 0) > 0 ? ` · ${mcpStatus.disabled} disabled` : "";
      return (
        <div className="ctx-popover-row">
          <span className="ctx-popover-desc">
            {mcpStatus.state === "connecting"
              ? `Connecting to ${mcpStatus.enabled} servers…`
              : `${mcpStatus.enabled} enabled · ${mcpStatus.connected} connected${disabledSuffix}`}
          </span>
        </div>
      );
    }
    const list = open === "prompt" ? prompts : skills;
    return list.map((c) => (
      <div key={c.name} className="ctx-popover-row" title={c.description}>
        <span className="ctx-popover-name">/{c.name}</span>
        {c.description && <span className="ctx-popover-desc">{c.description}</span>}
      </div>
    ));
  };

  const ariaLabel =
    open === "sys"
      ? "Prompt composition"
      : open === "prompt"
        ? "Prompt commands"
        : open === "skill"
          ? "Skills"
          : "MCP servers";

  return (
    <>
      <div className={`context-bar${open !== null ? " lifted" : ""}`}>
        {pinelPrompt &&
          renderChip(
            "sys",
            `Sys ${compactChars(pinelPrompt.finalChars)}`,
            "Prompt composition（系统提示词 / 用户级 / 项目级 / 插件注入）",
          )}
        {prompts.length > 0 && renderChip("prompt", `Prompt ${prompts.length}`, "Prompt commands")}
        {skills.length > 0 && renderChip("skill", `Skill ${skills.length}`, "Skills")}
        {mcpStatus && mcpStatus.enabled > 0 && (
          renderChip(
            "mcp",
            mcpStatus.state === "connecting" ? "MCP …" : `MCP ${mcpStatus.connected}/${mcpStatus.enabled}`,
            mcpStatus.state === "connecting" ? "Connecting to MCP servers…" : "MCP servers",
          )
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
}
