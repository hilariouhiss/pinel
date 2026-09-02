import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ContentBlock, StreamBlock, SubagentCardInfo, ToolCard } from "../types";
import { Markdown } from "./Markdown";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import wrenchIcon from "lucide-static/icons/wrench.svg";
import botIcon from "lucide-static/icons/bot.svg";
import checkIcon from "lucide-static/icons/check.svg";
import xIcon from "lucide-static/icons/x.svg";
import copyIcon from "lucide-static/icons/copy.svg";
import chevronRightIcon from "lucide-static/icons/chevron-right.svg";
import chevronDownIcon from "lucide-static/icons/chevron-down.svg";
import { vscode } from "../index";
import { useSmoothText } from "../use-smooth-text";
import { describeToolArgs } from "../tool-args";

/** toolResult 消息解析结果（webview 内部类型，非宿主协议镜像）。 */
export interface ToolResultInfo {
  text: string;
  isError: boolean;
  toolName: string;
}

/** toolResults 映射 + 命中集合（App.tsx useMemo 构建，下传各 MessageView 实例）。 */
export interface ToolResults {
  results: Record<string, ToolResultInfo>;
  matched: ReadonlySet<string>;
}

interface Props {
  message: ChatMessage;
  tools: Record<string, ToolCard>;
  toolResults: ToolResults;
  /** 流式部分消息（仅当 message 是占位 assistant 时提供）。 */
  streamBlocks?: StreamBlock[];
  /** 消息在 App messages 数组中的全局索引（悬浮状态条点击滚回定位锚）。 */
  msgIndex?: number;
  /** 主会话模型短名（subagent 继承主会话时的兕底显示；null = 未知）。 */
  mainModelName: string | null;
  /** 主会话思考等级（subagent 继承主会话时的兕底显示）。 */
  mainThinkingLevel: string | null;
  /** 旧消息标记（App 计算，末尾 40 条豁免）：content-visibility 跳过离屏布局/绘制。 */
  stale?: boolean;
}

/** 提取用户消息的纯文本（导出：App 悬浮状态条复用提取最近输入）。 */
export function userText(content: ChatMessage["content"]): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as ContentBlock[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  } else {
    return "";
  }
  // 剥离 @ 文件引用的 <file name="...">...</file> 注入块：权威消息（get_messages）
  // 含完整文件内容 markup，直接渲染会让用户气泡突变且文件内 markdown 误渲染——
  // 替换为简洁引用行（对齐乐观渲染的原文观感）
  return text.replace(/<file name="([^"]+)">[\s\S]*?<\/file>/g, "📎 $1");
}

/** 提取用户消息的图片附件。 */
function userImages(content: ChatMessage["content"]): ContentBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as ContentBlock[]).filter((b) => b.type === "image" && typeof b.data === "string");
}

/**
 * 提取卡片渲染后纯文本（所见即所得）：clone 卡片副本、移除角色标签行（You/Pi）、
 * 按钮与右键菜单后取 innerText——clone 临时挂 body（detached 节点无布局信息，
 * innerText 换行会退化）。折叠态 thinking/工具卡片内容不在 DOM，与所见一致。
 */
function extractCardText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".msg-role, .msg-copy-btn, .msg-copy-menu, .msg-copy-overlay").forEach((n) => n.remove());
  // 离屏但保持渲染：visibility:hidden 会让 Chromium innerText 返回空串（实测），
  // 隐藏的 clone 提取不到文本；fixed 离屏不影响布局也无视觉闪现
  clone.style.position = "fixed";
  clone.style.left = "-9999px";
  clone.style.top = "0";
  // 旧消息带 .msg-stale（content-visibility: auto），离屏 clone 被跳过渲染时
  // innerText 返回空串（与 visibility:hidden 同机制）：强制可见再提取
  clone.style.contentVisibility = "visible";
  document.body.appendChild(clone);
  const text = clone.innerText.trim();
  clone.remove();
  return text;
}

/** 剪切板桥：经宿主 vscode.env.clipboard 写入（webview 内 clipboard API 不可靠）。 */
function copyToClipboard(text: string): void {
  if (!text) {
    return;
  }
  vscode.postMessage({ type: "copyText", text });
}

/**
 * 复制按钮：targetRef（DOM 提取，所见即所得）或 getText（数据直拷，如 thinking 全文/工具 args+output）
 * 二选一；hover/focus-visible 显示，CSS 控制。
 */
function CopyButton({
  targetRef,
  getText,
}: {
  targetRef?: React.RefObject<HTMLElement | null>;
  getText?: () => string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const onClick = () => {
    const text = getText ? getText() : targetRef?.current ? extractCardText(targetRef.current) : "";
    if (!text) {
      return; // 无可复制文本：不写剪切板也不显示 ✓（防误导）
    }
    copyToClipboard(text);
    setCopied(true);
    window.clearTimeout(timerRef.current); // 连续点击重置定时器，✓ 不提前恢复
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      className="msg-copy-btn"
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Copied" : "Copy message"}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: copied ? checkIcon : copyIcon }}
    />
  );
}

/**
 * 卡片右键复制菜单：阻止默认菜单，在光标处弹「Copy message」；
 * 点击外部/Esc 关闭；overlay 兼作关闭层。pos=null 不渲染。
 */
function CardContextMenu({
  pos,
  targetRef,
  getText,
  onClose,
}: {
  pos: { x: number; y: number } | null;
  targetRef?: React.RefObject<HTMLElement | null>;
  getText?: () => string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!pos) {
      return;
    }
    // capture：右键其他卡片时先关旧菜单再开新的（contextmenu 在 window 层先到）
    window.addEventListener("contextmenu", onClose, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("contextmenu", onClose, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [pos, onClose]);
  if (!pos) {
    return null;
  }
  const doCopy = () => {
    const text = getText ? getText() : targetRef?.current ? extractCardText(targetRef.current) : "";
    copyToClipboard(text);
    onClose();
  };
  return (
    <>
      <div className="msg-copy-overlay" onClick={onClose} />
      <div className="msg-copy-menu" style={{ left: pos.x, top: pos.y }} role="menu">
        <button role="menuitem" onClick={doCopy}>
          <span className="msg-copy-menu-icon" dangerouslySetInnerHTML={{ __html: copyIcon }} />
          Copy message
        </button>
      </div>
    </>
  );
}

/** 卡片右键打开复制菜单（preventDefault 拦截默认菜单）。 */
function openCardMenu(e: React.MouseEvent<HTMLElement>): { x: number; y: number } {
  e.preventDefault();
  return { x: e.clientX, y: e.clientY };
}

function assistantBlocks(content: ChatMessage["content"]): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function MessageView({ message, tools, toolResults, streamBlocks, msgIndex, mainModelName, mainThinkingLevel, stale }: Props) {
  const userRef = useRef<HTMLDivElement>(null);
  const toolResultRef = useRef<HTMLDivElement>(null);
  /** 右键复制菜单位置（null=关闭）；每卡片实例独立（仅 user 卡片级使用）。 */
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  if (message.role === "bashExecution") {
    return <BashCard message={message} stale={stale} />;
  }
  if (message.role === "user") {
    const text = userText(message.content);
    const images = userImages(message.content);
    return (
      <div
        className={`msg msg-user${stale ? " msg-stale" : ""}`}
        ref={userRef}
        data-msg-index={msgIndex}
        onContextMenu={text ? (e) => setMenuPos(openCardMenu(e)) : undefined}
      >
        <div className="msg-role">You</div>
        {images.map((img, i) => (
          <img
            key={`img-${i}`}
            className="msg-image"
            src={`data:${img.mimeType ?? "image/png"};base64,${img.data}`}
            alt="Attached image"
          />
        ))}
        {text && <div className="msg-text">{text}</div>}
        {/* 图片-only 消息无可复制文本，不渲染按钮 */}
        {text && <CopyButton targetRef={userRef} />}
        <CardContextMenu pos={menuPos} targetRef={userRef} onClose={() => setMenuPos(null)} />
      </div>
    );
  }

  if (message.role === "toolResult") {
    // 结果已内联到原 assistant 消息的工具卡片：命中集合内跳过独立卡片渲染；
    // 孤儿（无 toolCallId / 列表中无匹配 toolCall）回退独立卡片防信息丢失
    const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
    if (id && toolResults.matched.has(id)) {
      return null;
    }
    return <ToolResultView message={message} tools={tools} targetRef={toolResultRef} mainModelName={mainModelName} mainThinkingLevel={mainThinkingLevel} stale={stale} />;
  }

  // assistant（含流式占位）
  if (streamBlocks) {
    // 流式中的消息无消息级复制按钮（半截消息复制无意义；settle 后重渲染自动出现）
    // key 用 blk- 前缀与下方落定分支一致：settle 同 key 原地复用 DOM，动效/展开态不重放；
    // 仅最后一个块 live：出现下一块即上一块已结束（thinking/正文不再停留在流式态）
    return (
      <div className="msg msg-assistant">
        <div className="msg-role">Pi</div>
        {streamBlocks.map((block, i) => (
          <BlockView key={`blk-${i}`} kind={block.kind} text={block.text} toolCall={block.toolCall} live={i === streamBlocks.length - 1} tools={tools} toolResults={toolResults} mainModelName={mainModelName} mainThinkingLevel={mainThinkingLevel} />
        ))}
      </div>
    );
  }

  const blocks = assistantBlocks(message.content);
  // 各区块（正文/思考/工具卡）自带复制入口，不再提供整个 Pi 块级复制——
  // 块级复制会把上方思考全文一并拷走（评审：复制正文不应携带思考内容）
  return (
    <div className={`msg msg-assistant${stale ? " msg-stale" : ""}`}>
      <div className="msg-role">Pi</div>
      {blocks.map((block, i) => (
        <BlockView
          key={`blk-${i}`}
          kind={block.type === "thinking" ? "thinking" : block.type === "toolCall" ? "toolCall" : "text"}
          text={block.type === "thinking" ? (block.thinking ?? "") : block.type === "text" ? (block.text ?? "") : ""}
          toolCall={
            block.type === "toolCall"
              ? {
                  id: (block.id as string) ?? "",
                  name: (block.name as string) ?? "",
                  arguments: block.arguments === undefined ? "" : JSON.stringify(block.arguments),
                }
              : undefined
          }
          tools={tools}
          toolResults={toolResults}
          mainModelName={mainModelName}
          mainThinkingLevel={mainThinkingLevel}
        />
      ))}
    </div>
  );
}

/** 终端命令卡（! / !!）：命令 + 流式输出 + 状态（复用 toolresult 样式）。
 *  运行中输出区自动滚到底（对齐 thinking 体跟随机制）；完成后可复制。 */
function BashCard({ message, stale }: { message: ChatMessage; stale?: boolean }) {
  const [open, setOpen] = useState(true);
  const bodyRef = useRef<HTMLPreElement>(null);
  const command = typeof message.command === "string" ? message.command : "";
  const output = typeof message.output === "string" ? message.output : "";
  const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
  const running = exitCode === null;
  const failed = exitCode !== null && exitCode !== 0;
  // 流式增长时输出区滚到最新（到 max-height 后卡片不再增高，新内容在内部滚动区）
  useLayoutEffect(() => {
    if (running && open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [output, running, open]);
  const copyText = () => [command, output].filter((s) => s.length > 0).join("\n\n");
  return (
    <div className={`msg msg-bash${stale ? " msg-stale" : ""}`}>
      <div className={`toolresult${failed ? " status-error" : ""}`}>
        <button className="toolresult-head" onClick={() => setOpen(!open)}>
          <span className={`toolstatus ${running ? "status-running" : failed ? "status-error" : "status-done"}`}>
            {running ? (
              <span className="spinner" />
            ) : failed ? (
              <span className="toolstatus-icon" dangerouslySetInnerHTML={{ __html: xIcon }} />
            ) : (
              <span className="toolstatus-icon" dangerouslySetInnerHTML={{ __html: checkIcon }} />
            )}
          </span>
          <span className="toolresult-title">
            {message.excludeFromContext ? "!!" : "!"} {command}
          </span>
          <span className="toolresult-len">
            {running ? "running…" : `exit ${exitCode}`}
          </span>
        </button>
        {open && output && (
          <pre className="toolresult-body" ref={bodyRef}>{output}</pre>
        )}
      </div>
      {!running && <CopyButton getText={copyText} />}
    </div>
  );
}

function BlockView({
  kind,
  text,
  toolCall,
  live,
  tools,
  toolResults,
  mainModelName,
  mainThinkingLevel,
}: {
  kind: "text" | "thinking" | "toolCall";
  text: string;
  toolCall?: { id: string; name: string; arguments: string };
  live?: boolean;
  tools: Record<string, ToolCard>;
  toolResults: ToolResults;
  mainModelName: string | null;
  mainThinkingLevel: string | null;
}) {
  if (kind === "thinking") {
    return <ThinkingBlock text={text} live={live} />;
  }
  if (kind === "toolCall") {
    const toolCard = toolCall?.id ? tools[toolCall.id] : undefined;
    const result = toolCall?.id ? toolResults.results[toolCall.id] : undefined;
    // subagent 专属卡片原位渲染（保持统计行 + Markdown 输出样式）
    if (toolCard?.subagent) {
      return (
        <SubagentCard
          card={toolCard.subagent}
          output={toolCard.output || result?.text || ""}
          mainModelName={mainModelName}
          mainThinkingLevel={mainThinkingLevel}
        />
      );
    }
    return <ToolCallCard toolCall={toolCall} live={live} toolCard={toolCard} result={result} />;
  }
  return <TextBlock text={text} live={live} />;
}

/** 正文区块：流式中纯文本 + 平滑揭示，完成态 Markdown（快照重放即完成态）。 */
function TextBlock({ text, live }: { text: string; live?: boolean }) {
  const displayText = useSmoothText(text, live === true);
  /** 正文区块复制（DOM 提取，所见即所得；不含兄弟区块如 thinking/工具卡）。 */
  const textRef = useRef<HTMLDivElement>(null);
  const [textMenuPos, setTextMenuPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="msg-text copy-target" ref={textRef} onContextMenu={(e) => setTextMenuPos(openCardMenu(e))}>
      {/* 流式中纯文本渲染 + 平滑揭示：Markdown 全量重解析是逐 delta 重绘卡顿主源；
          message_end 后切回 Markdown（快照重放即完成态） */}
      {live ? <span className="msg-text-live">{displayText}</span> : <Markdown content={text} />}
      {live && displayText.length > 0 && <span className="caret" />}
      {!live && <CopyButton targetRef={textRef} />}
      <CardContextMenu pos={textMenuPos} targetRef={textRef} onClose={() => setTextMenuPos(null)} />
    </div>
  );
}

function ThinkingBlock({ text, live }: { text: string; live?: boolean }) {
  const displayText = useSmoothText(text, live === true);
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 思考体跟随最新：仅用户滚动关闭，滚回底部恢复（阈值对齐外层 stickToBottom）。 */
  const followRef = useRef(true);
  /** 用户滚动意图标记：锚定补偿/程序性滚动产生的 scroll 事件不关闭跟随
   *  （长思考触顶时锚定会把思考体拖离底部，按位置重算会被误关——与外层同机制）。 */
  const intentRef = useRef(false);
  const intentTimerRef = useRef<number | undefined>(undefined);
  const markIntent = () => {
    intentRef.current = true;
    window.clearTimeout(intentTimerRef.current);
    intentTimerRef.current = window.setTimeout(() => {
      intentRef.current = false;
    }, 400);
  };
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 状态驱动自动开合：思考开始（live 转真）自动展开，思考完毕自动收起；
  // 手动 toggle 在 live 不变时有效（effect 不重跑，尊重用户操作）
  useEffect(() => {
    if (live) {
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [live]);
  // 流式增长时思考体滚到最新（到最大高度后卡片不再增高，新内容在内部滚动区）；
  // 仅用户滚动关闭跟随，滚回底部恢复。useLayoutEffect + rAF：paint 前完成，
  // 异步布局增长后下一帧校正（与消息区自动滚动同机制）
  useLayoutEffect(() => {
    if (!live || !open) {
      return;
    }
    const el = bodyRef.current;
    if (!el || !followRef.current) {
      return;
    }
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      if (followRef.current && bodyRef.current) {
        bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [displayText, live, open]);
  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el || !intentRef.current) {
      return;
    }
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return (
    <details className={`thinking${live ? " thinking-live" : ""}`} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} onContextMenu={(e) => setMenuPos(openCardMenu(e))}>
      <summary className="thinking-summary">
        <span className="thinking-dot" />
        Thinking{live ? "…" : ""}
        {text.length > 0 && !open && <span className="thinking-preview">{text.slice(0, 60)}</span>}
      </summary>
      <div
        className="msg-text thinking-body"
        ref={bodyRef}
        onScroll={onBodyScroll}
        onWheel={markIntent}
        onPointerDown={markIntent}
        onTouchStart={markIntent}
      >
        {/* 流式中纯文本 + 平滑揭示（同正文：免 Markdown 逐 delta 重解析） */}
        {live ? (
          <span className="msg-text-live">
            {displayText}
            {displayText.length > 0 && <span className="caret" />}
          </span>
        ) : (
          <Markdown content={text} />
        )}
      </div>
      {/* 数据直拷思考全文（不受展开态/预览截断影响）；流式中不提供（半截无意义） */}
      {!live && <CopyButton getText={() => text} />}
      <CardContextMenu pos={menuPos} getText={() => text} onClose={() => setMenuPos(null)} />
    </details>
  );
}

/** 统一工具调用卡片：lucide 图标 + 状态 + 预览，展开显示完整 args 与 output。
 *  toolResult 内联（结果展示在原 assistant 消息卡片上，不再出现独立结果卡片）：
 *  - 状态：tools map（实时）优先；流式且均未到时回落 running 防 ✓ 闪现
 *  - 输出：tools map（实时增量）优先，快照重放后回落 toolResult 消息权威文本 */
function ToolCallCard({
  toolCall,
  live,
  toolCard,
  result,
}: {
  toolCall?: { id: string; name: string; arguments: string };
  live?: boolean;
  toolCard?: ToolCard;
  result?: ToolResultInfo;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const args = toolCall?.arguments ?? "";
  const displayArgs = useSmoothText(args, live === true);
  /** 直读化 args（命令/查询/路径等，无命中回退 pretty JSON）；流式中显示揭示中的原始参数。 */
  const describedArgs = useMemo(() => describeToolArgs(args), [args]);
  const shownArgs = live ? displayArgs : describedArgs;
  const output = toolCard?.output ?? result?.text ?? "";
  const status: "running" | "done" | "error" =
    toolCard?.status ?? (result ? (result.isError ? "error" : "done") : live ? "running" : "done");
  // 运行结束自动收起；running 不自动展开（不打扰，用户可手动展开看实时输出）；
  // 手动 toggle 在 status 不变时有效（effect 不重跑，尊重用户操作）
  useEffect(() => {
    setOpen((prev) => prev && status !== "running");
  }, [status]);
  // 工具本名三层兕底：流式/快照块 name → tool_execution 实时 toolName → toolResult 消息落盘 toolName
  //（覆盖快照重放 + tools 清空场景）；三源皆空保留 Tool call 兕底
  const toolName = toolCall?.name || toolCard?.toolName || result?.toolName || "Tool call";
  // 普通工具 wrench；subagent（无实时卡片时按工具名）bot——判定用兕底后的 toolName，
  // name 缺失时图标与卡片风格保持一致
  const isSubagent = toolName === "subagent";
  const preview = output.trim() ? output : shownArgs;
  /** 数据直拷：直读 args（命令等）+ 输出，不经过截断预览/卡片文字。 */
  const copyToolText = () =>
    [describedArgs, output.trim()]
      .filter((s) => s.length > 0)
      .join("\n\n");

  return (
    <div className="toolchip" onContextMenu={(e) => setMenuPos(openCardMenu(e))}>
      <button className="toolchip-head" onClick={() => setOpen(!open)}>
        <span className="toolchip-icon" dangerouslySetInnerHTML={{ __html: isSubagent ? botIcon : wrenchIcon }} />
        <span className="toolchip-name">{toolName}</span>
        <span className={`toolstatus status-${status}`}>
          {status === "running" ? (
            <span className="spinner" />
          ) : status === "error" ? (
            <span className="toolstatus-icon" dangerouslySetInnerHTML={{ __html: xIcon }} />
          ) : (
            <span className="toolstatus-icon" dangerouslySetInnerHTML={{ __html: checkIcon }} />
          )}
        </span>
        <span className="toolchip-args-preview">
          {preview.length > 200 ? preview.slice(0, 200).replace(/\n/g, " ") + "…" : preview.replace(/\n/g, " ")}
        </span>
      </button>
      {open && (
        <div className="toolcard-body">
          {args && <pre className="toolchip-args">{shownArgs}</pre>}
          {output.trim() && <pre className="toolresult-body">{output}</pre>}
        </div>
      )}
      {!live && <CopyButton getText={copyToolText} />}
      <CardContextMenu pos={menuPos} getText={copyToolText} onClose={() => setMenuPos(null)} />
    </div>
  );
}

function SubagentCard({
  card,
  output,
  mainModelName,
  mainThinkingLevel,
}: {
  card: SubagentCardInfo;
  output: string;
  /** 主会话模型短名（继承主会话时兕底显示实际值而非占位）。 */
  mainModelName: string | null;
  /** 主会话思考等级（继承主会话时兕底显示实际值）。 */
  mainThinkingLevel: string | null;
}) {
  const [open, setOpen] = useState(false);
  const running = card.status === "running";
  // 运行中（含后台）的"当前输出" = details.activity 预览：扩展在运行期间只发
  // "N tool uses..." 占位 content（不流式子代理正文，进程内运行），activity 由
  // 宿主实时合并（含截断的实时响应文本或活动描述）；完成后 output = 完整结果
  const live = running || card.status === "background";
  const displayText = live ? (card.activity ?? "") : output;
  // 状态驱动自动开合：background（用户主动挂后台）自动展开实时输出；
  // running 不自动展开（对齐工具卡片）；完成后自动收起；
  // 手动 toggle 在 status 不变时有效（effect 不重跑，尊重用户操作）
  useEffect(() => {
    if (card.status === "background") {
      setOpen(true);
    } else if (card.status !== "running") {
      setOpen(false);
    }
  }, [card.status]);
  // running 中 partial 输出同样可展开/收起（需求：运行时自动展开展示输出）；
  // output 为空时不可展开（无内容）；运行中 partial 随 tools map 实时增长
  const canExpand = displayText.trim().length > 0;
  const meta: string[] = [];
  // 继承主会话时兕底主会话实际模型短名/思考等级，而非 "main model"/"main level" 占位
  meta.push(card.model ?? mainModelName ?? "main model");
  // 思考等级直接显示裸值（去 "thinking: " 前缀）；全缺保留占位
  meta.push(card.thinking ?? mainThinkingLevel ?? "main level");
  const stats: string[] = [];
  if (running && card.activity) {
    stats.push(card.activity);
  }
  if (card.turnCount != null) {
    stats.push(`${card.turnCount} turn${card.turnCount === 1 ? "" : "s"}`);
  }
  if (card.toolUses != null && card.toolUses > 0) {
    stats.push(`${card.toolUses} tool use${card.toolUses === 1 ? "" : "s"}`);
  }
  if (card.tokens) {
    stats.push(card.tokens);
  }
  if (!running && card.durationMs != null && card.durationMs > 0) {
    stats.push(card.durationMs >= 1000 ? `${(card.durationMs / 1000).toFixed(1)}s` : `${card.durationMs}ms`);
  }
  if (card.status === "background") {
    stats.push("Running in background");
  }
  return (
    <div className={`toolresult subagent-card status-${card.status === "error" ? "error" : "done"}`}>
      <button
        className="toolresult-head"
        onClick={() => canExpand && setOpen(!open)}
        style={{ cursor: canExpand ? "pointer" : "default" }}
      >
        <span
          className={`toolstatus status-${
            card.status === "error" ? "error" : card.status === "running" ? "running" : "done"
          }`}
        >
          {running ? (
            <span className="spinner" />
          ) : card.status === "error" ? (
            <span className="toolstatus-icon" dangerouslySetInnerHTML={{ __html: xIcon }} />
          ) : (
            <span className="toolstatus-icon" dangerouslySetInnerHTML={{ __html: checkIcon }} />
          )}
        </span>
        <span className="toolresult-title">
          <span className="subagent-robot" dangerouslySetInnerHTML={{ __html: botIcon }} /> {card.description}
        </span>
        <span className="toolresult-len">{meta.join(" · ")}</span>
        {canExpand && (
          <span className="subagent-caret">
            <span
              dangerouslySetInnerHTML={{ __html: open ? chevronDownIcon : chevronRightIcon }}
            />
          </span>
        )}
      </button>
      {stats.length > 0 && <div className="subagent-stats">{stats.join(" · ")}</div>}
      {open && displayText.trim() && (
        <div className="subagent-body msg-text">
          <Markdown content={displayText} />
        </div>
      )}
    </div>
  );
}

function ToolResultView({
  message,
  tools,
  targetRef,
  mainModelName,
  mainThinkingLevel,
  stale,
}: {
  message: ChatMessage;
  tools: Record<string, ToolCard>;
  targetRef: React.RefObject<HTMLDivElement | null>;
  mainModelName: string | null;
  mainThinkingLevel: string | null;
  stale?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const toolCard = message.toolCallId ? tools[message.toolCallId] : undefined;
  // 注：合并 toolResult 内联后本分支仅孤儿路径可达（有 subagent 实时卡片的
  // 结果已原位渲染在 assistant 消息内）；保留作防御兕底
  if (toolCard?.subagent) {
    return (
      <div className={`msg msg-toolresult${stale ? " msg-stale" : ""}`} ref={targetRef} onContextMenu={(e) => setMenuPos(openCardMenu(e))}>
        <SubagentCard
          card={toolCard.subagent}
          output={toolCard.output || ""}
          mainModelName={mainModelName}
          mainThinkingLevel={mainThinkingLevel}
        />
        <CopyButton targetRef={targetRef} />
        <CardContextMenu pos={menuPos} targetRef={targetRef} onClose={() => setMenuPos(null)} />
      </div>
    );
  }
  const status = toolCard?.status ?? (message.isError ? "error" : "done");
  const rawContent = Array.isArray(message.content) ? message.content : [];
  const text = (rawContent as ContentBlock[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");

  return (
    <div className={`msg msg-toolresult${stale ? " msg-stale" : ""}`} ref={targetRef} onContextMenu={(e) => setMenuPos(openCardMenu(e))}>
      <div className={`toolresult status-${status}`}>
      <button className="toolresult-head" onClick={() => setOpen(!open)}>
        <span className={`toolstatus status-${status}`}>
          {status === "running" ? (
            <span className="spinner" />
          ) : status === "error" ? (
            <span className="toolstatus-icon" dangerouslySetInnerHTML={{ __html: xIcon }} />
          ) : (
            <span className="toolstatus-icon" dangerouslySetInnerHTML={{ __html: checkIcon }} />
          )}
        </span>
        <span className="toolresult-title">
          Tool result{message.toolCallId ? ` · ${toolCard?.toolName ?? message.toolCallId}` : ""}
        </span>
        <span className="toolresult-len">
          {text.length > 400 ? text.slice(0, 400).replace(/\n/g, " ") + "…" : text.slice(0, 80).replace(/\n/g, " ")}
        </span>
      </button>
      {open && <pre className="toolresult-body">{text}</pre>}
      </div>
      <CopyButton targetRef={targetRef} />
      <CardContextMenu pos={menuPos} targetRef={targetRef} onClose={() => setMenuPos(null)} />
    </div>
  );
}
