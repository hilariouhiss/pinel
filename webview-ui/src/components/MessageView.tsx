import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ContentBlock, StreamBlock, SubagentCardInfo, ToolCard } from "../types";
import { Markdown } from "./Markdown";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import wrenchIcon from "lucide-static/icons/wrench.svg";
import botIcon from "lucide-static/icons/bot.svg";
import checkIcon from "lucide-static/icons/check.svg";
import xIcon from "lucide-static/icons/x.svg";
import copyIcon from "lucide-static/icons/copy.svg";

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
 * 复制消息卡片内容按钮（hover/focus-visible 显示，CSS 控制）。
 * 提取渲染后纯文本（所见即所得）：clone 卡片副本、移除角色标签行（You/Pi）与
 * 按钮自身后取 innerText——clone 临时挂 body（detached 节点无布局信息，
 * innerText 换行会退化）。折叠态 thinking/工具卡片内容不在 DOM，与所见一致。
 */
function CopyButton({ targetRef }: { targetRef: React.RefObject<HTMLDivElement | null> }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const onClick = () => {
    const el = targetRef.current;
    if (!el) {
      return;
    }
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".msg-role, .msg-copy-btn").forEach((n) => n.remove());
    clone.style.position = "fixed";
    clone.style.left = "-9999px";
    clone.style.visibility = "hidden";
    document.body.appendChild(clone);
    const text = clone.innerText.trim();
    clone.remove();
    if (!text) {
      return;
    }
    // clipboard 不存在（非安全上下文边缘）时同步 TypeError，.catch 接不住——可选链兑底静默
    navigator.clipboard?.writeText(text)?.catch(() => {});
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

function assistantBlocks(content: ChatMessage["content"]): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function MessageView({ message, tools, toolResults, streamBlocks, msgIndex }: Props) {
  const userRef = useRef<HTMLDivElement>(null);
  const assistantRef = useRef<HTMLDivElement>(null);
  const toolResultRef = useRef<HTMLDivElement>(null);
  if (message.role === "user") {
    const text = userText(message.content);
    const images = userImages(message.content);
    return (
      <div className="msg msg-user" ref={userRef} data-msg-index={msgIndex}>
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
    return <ToolResultView message={message} tools={tools} targetRef={toolResultRef} />;
  }

  // assistant（含流式占位）
  if (streamBlocks) {
    // 流式中的消息无复制按钮（半截消息复制无意义；settle 后重渲染自动出现）
    return (
      <div className="msg msg-assistant">
        <div className="msg-role">Pi</div>
        {streamBlocks.map((block, i) => (
          <BlockView key={`s-${i}`} kind={block.kind} text={block.text} toolCall={block.toolCall} live tools={tools} toolResults={toolResults} />
        ))}
      </div>
    );
  }

  const blocks = assistantBlocks(message.content);
  return (
    <div className="msg msg-assistant" ref={assistantRef}>
      <div className="msg-role">Pi</div>
      {blocks.map((block, i) => (
        <BlockView
          key={`b-${i}`}
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
        />
      ))}
      <CopyButton targetRef={assistantRef} />
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
}: {
  kind: "text" | "thinking" | "toolCall";
  text: string;
  toolCall?: { id: string; name: string; arguments: string };
  live?: boolean;
  tools: Record<string, ToolCard>;
  toolResults: ToolResults;
}) {
  if (kind === "thinking") {
    return <ThinkingBlock text={text} live={live} />;
  }
  if (kind === "toolCall") {
    const toolCard = toolCall?.id ? tools[toolCall.id] : undefined;
    const result = toolCall?.id ? toolResults.results[toolCall.id] : undefined;
    // subagent 专属卡片原位渲染（保持统计行 + Markdown 输出样式）
    if (toolCard?.subagent) {
      return <SubagentCard card={toolCard.subagent} output={toolCard.output || result?.text || ""} />;
    }
    return <ToolCallCard toolCall={toolCall} live={live} toolCard={toolCard} result={result} />;
  }
  return (
    <div className="msg-text">
      <Markdown content={text} />
      {live && text.length > 0 && <span className="caret" />}
    </div>
  );
}

function ThinkingBlock({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="thinking" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="thinking-summary">
        <span className="thinking-dot" />
        Thinking{live ? "…" : ""}
        {text.length > 0 && !open && <span className="thinking-preview">{text.slice(0, 60)}</span>}
      </summary>
      <div className="msg-text thinking-body">
        <Markdown content={text} />
      </div>
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
  const args = toolCall?.arguments ?? "";
  const prettyArgs = useMemo(() => {
    if (!args) {
      return "";
    }
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }, [args]);
  const output = toolCard?.output ?? result?.text ?? "";
  const status: "running" | "done" | "error" =
    toolCard?.status ?? (result ? (result.isError ? "error" : "done") : live ? "running" : "done");
  // 普通工具 wrench；subagent（无实时卡片时按工具名）bot
  const isSubagent = toolCall?.name === "subagent";
  const preview = output.trim() ? output : args;

  return (
    <div className="toolchip">
      <button className="toolchip-head" onClick={() => setOpen(!open)}>
        <span className="toolchip-icon" dangerouslySetInnerHTML={{ __html: isSubagent ? botIcon : wrenchIcon }} />
        <span className="toolchip-name">{toolCall?.name || "Tool call"}</span>
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
          {args && <pre className="toolchip-args">{prettyArgs}</pre>}
          {output.trim() && <pre className="toolresult-body">{output}</pre>}
        </div>
      )}
    </div>
  );
}

function SubagentCard({ card, output }: { card: SubagentCardInfo; output: string }) {
  const [open, setOpen] = useState(false);
  const running = card.status === "running";
  // running 中 partial content 仅 "N tool uses..." 无展开价值；background/stopped
  // 视为终态，有 output 即可展开，无则仅显示状态标签
  const canExpand = !running && output.trim().length > 0;
  const meta: string[] = [];
  meta.push(card.model ?? "main model");
  meta.push(card.thinking ? `thinking: ${card.thinking}` : "main level");
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
        {canExpand && <span className="subagent-caret">{open ? "▾" : "▸"}</span>}
      </button>
      {stats.length > 0 && <div className="subagent-stats">{stats.join(" · ")}</div>}
      {open && (
        <div className="subagent-body msg-text">
          <Markdown content={output} />
        </div>
      )}
    </div>
  );
}

function ToolResultView({
  message,
  tools,
  targetRef,
}: {
  message: ChatMessage;
  tools: Record<string, ToolCard>;
  targetRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const toolCard = message.toolCallId ? tools[message.toolCallId] : undefined;
  // 注：合并 toolResult 内联后本分支仅孤儿路径可达（有 subagent 实时卡片的
  // 结果已原位渲染在 assistant 消息内）；保留作防御兜底
  if (toolCard?.subagent) {
    return (
      <div className="msg msg-toolresult" ref={targetRef}>
        <SubagentCard card={toolCard.subagent} output={toolCard.output} />
        <CopyButton targetRef={targetRef} />
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
    <div className="msg msg-toolresult" ref={targetRef}>
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
    </div>
  );
}
