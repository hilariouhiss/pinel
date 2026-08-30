import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { McpStatus, SlashCommand } from "../types";

interface Props {
  /** 斜杠命令列表（宿主 get_commands 镜像；prompt/skill chip 计数与弹层明细数据源）。 */
  commands: SlashCommand[];
  /** MCP 服务器摘要（宿主 statusKey "mcp" 帧；null=未收到帧 → MCP chip 隐藏）。 */
  mcpStatus: McpStatus | null;
}

/** 弹层种类（与三个 chip 一一对应；null=关闭）。 */
type CtxKind = "prompt" | "skill" | "mcp";

/**
 * 输入卡顶部上下文状态条：Prompt/Skill/MCP 计数 chip 行 + 锚定明细弹层（纯展示）：
 * - 可见性：Prompt N / Skill N（N>0 才显示）、MCP C/N（enabled>0 才显示；
 *   connecting 态显示 "MCP …" 且 title 提示连接中）；三者全空 → 整条隐藏（null）
 * - 弹层：chip 上方 bottom 锚定，定位/Esc/焦点三 effect 逐段移植 ModelPopover
 *   （左对齐 + 超右缘右对齐回退 + resize 重算；Esc window capture 拦截
 *   stopPropagation 让位 Composer 的中断/清空分支；打开焦点入弹层、关闭还原触发 chip）
 * - rows 为信息展示（非 listbox 选项），弹层开关是组件内局部 state，
 *   不触碰 App 的弹层枚举
 */
export function ContextBar({ commands, mcpStatus }: Props) {
  const prompts = commands.filter((c) => c.source === "prompt");
  const skills = commands.filter((c) => c.source === "skill");
  const [open, setOpen] = useState<CtxKind | null>(null);
  const promptChipRef = useRef<HTMLButtonElement>(null);
  const skillChipRef = useRef<HTMLButtonElement>(null);
  const mcpChipRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ bottom?: number; left?: number; right?: number }>({});

  // MCP chip 可见 = 收到帧且启用数 > 0（ready 态 0 服务器为清除信号，隐藏）
  const mcpVisible = mcpStatus !== null && mcpStatus.enabled > 0;

  // 当前弹层锚点；种类数据消失（chip 卸载）时按 null 关闭，防重挂载幽灵弹层
  const anchor =
    open === "prompt"
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
        setOpen(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [anchor]);

  // 数据消失（如 pi 重启清空命令）时收回弹层，防数据回填后弹层无操作复活抢焦点
  useEffect(() => {
    if (open !== null && anchor === null) {
      setOpen(null);
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

  if (prompts.length === 0 && skills.length === 0 && !mcpVisible) {
    return null;
  }

  const close = () => setOpen(null);

  const renderChip = (kind: CtxKind, label: string, title: string) => {
    const ref = kind === "prompt" ? promptChipRef : kind === "skill" ? skillChipRef : mcpChipRef;
    return (
      <button
        ref={ref}
        className={`composer-chip context-chip${open === kind ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open === kind}
        title={title}
        onClick={() => setOpen((o) => (o === kind ? null : kind))}
      >
        {label}
      </button>
    );
  };

  // 弹层行（纯展示）：prompt/skill = `/name` + 截断描述（title 全文）；mcp = 计数摘要
  const renderRows = () => {
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

  return (
    <>
      <div className={`context-bar${open !== null ? " lifted" : ""}`}>
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
            aria-label={open === "prompt" ? "Prompt commands" : open === "skill" ? "Skills" : "MCP servers"}
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
