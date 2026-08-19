import { useMemo, useState } from "react";
import type { ChatMessage, ContentBlock, StreamBlock, ToolCard } from "../types";
import { Markdown } from "./Markdown";

interface Props {
  message: ChatMessage;
  tools: Record<string, ToolCard>;
  /** 流式部分消息（仅当 message 是占位 assistant 时提供）。 */
  streamBlocks?: StreamBlock[];
}

/** 提取用户消息的纯文本。 */
function userText(content: ChatMessage["content"]): string {
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

function assistantBlocks(content: ChatMessage["content"]): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function MessageView({ message, tools, streamBlocks }: Props) {
  if (message.role === "user") {
    const text = userText(message.content);
    const images = userImages(message.content);
    return (
      <div className="msg msg-user">
        <div className="msg-role">你</div>
        {images.map((img, i) => (
          <img
            key={`img-${i}`}
            className="msg-image"
            src={`data:${img.mimeType ?? "image/png"};base64,${img.data}`}
            alt="附件图片"
          />
        ))}
        {text && <div className="msg-text">{text}</div>}
      </div>
    );
  }

  if (message.role === "toolResult") {
    return <ToolResultView message={message} tools={tools} />;
  }

  // assistant（含流式占位）
  if (streamBlocks) {
    return (
      <div className="msg msg-assistant">
        <div className="msg-role">Pi</div>
        {streamBlocks.map((block, i) => (
          <BlockView key={`s-${i}`} kind={block.kind} text={block.text} toolCall={block.toolCall} live />
        ))}
      </div>
    );
  }

  const blocks = assistantBlocks(message.content);
  return (
    <div className="msg msg-assistant">
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
        />
      ))}
    </div>
  );
}

function BlockView({
  kind,
  text,
  toolCall,
  live,
}: {
  kind: "text" | "thinking" | "toolCall";
  text: string;
  toolCall?: { id: string; name: string; arguments: string };
  live?: boolean;
}) {
  if (kind === "thinking") {
    return <ThinkingBlock text={text} live={live} />;
  }
  if (kind === "toolCall") {
    return <ToolChip toolCall={toolCall} live={live} />;
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
        思考过程{live ? "…" : ""}
        {text.length > 0 && !open && <span className="thinking-preview">{text.slice(0, 60)}</span>}
      </summary>
      <div className="msg-text thinking-body">
        <Markdown content={text} />
      </div>
    </details>
  );
}

function ToolChip({
  toolCall,
  live,
}: {
  toolCall?: { id: string; name: string; arguments: string };
  live?: boolean;
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

  return (
    <div className="toolchip">
      <button className="toolchip-head" onClick={() => setOpen(!open)}>
        <span className="toolchip-icon">🔧</span>
        <span className="toolchip-name">{toolCall?.name || "工具调用"}</span>
        {live && <span className="spinner" />}
        <span className="toolchip-args-preview">{args.slice(0, 60)}</span>
      </button>
      {open && args && <pre className="toolchip-args">{prettyArgs}</pre>}
    </div>
  );
}

function ToolResultView({ message, tools }: { message: ChatMessage; tools: Record<string, ToolCard> }) {
  const [open, setOpen] = useState(false);
  const toolCard = message.toolCallId ? tools[message.toolCallId] : undefined;
  const status = toolCard?.status ?? (message.isError ? "error" : "done");
  const rawContent = Array.isArray(message.content) ? message.content : [];
  const text = (rawContent as ContentBlock[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  const long = text.split("\n").length > 10;
  const shown = long && !open ? text.split("\n").slice(0, 10).join("\n") + "\n…" : text;

  return (
    <div className={`toolresult status-${status}`}>
      <button className="toolresult-head" onClick={() => setOpen(!open)}>
        <span className={`toolstatus status-${status}`}>
          {status === "running" ? <span className="spinner" /> : status === "error" ? "✕" : "✓"}
        </span>
        <span className="toolresult-title">
          工具结果{message.toolCallId ? ` · ${toolCard?.toolName ?? message.toolCallId}` : ""}
        </span>
        <span className="toolresult-len">
          {text.length > 400 ? text.slice(0, 400).replace(/\n/g, " ") + "…" : text.slice(0, 80).replace(/\n/g, " ")}
        </span>
      </button>
      {open && <pre className="toolresult-body">{shown}</pre>}
    </div>
  );
}
