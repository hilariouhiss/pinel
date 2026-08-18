import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { vscode } from "../index";
import { isCommandQuery, matchCommands } from "../command-match";
import type { Attachment, ChatStatus, SlashCommand } from "../types";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import sendIcon from "../../../media/send.svg";
import stopIcon from "../../../media/stop.svg";

interface Props {
  status: ChatStatus;
  commands: SlashCommand[];
  /** 配置面板打开时：Esc 让位给面板关闭，不触发中断/清空（双保险，面板侧 capture 已拦截）。 */
  popoverOpen?: boolean;
}

/** 来源徽标（中文标签）；未知来源兜底"其他"（pi 未来可能新增 source）。 */
function sourceLabel(source: string | undefined): string {
  switch (source) {
    case "extension":
      return "扩展";
    case "prompt":
      return "提示模板";
    case "skill":
      return "技能";
    default:
      return "其他";
  }
}

/** 图片压缩：最长边 > 1568px 时用 canvas 缩小并转 JPEG，控制随 prompt 发送的体积。 */
async function compressImage(
  dataUrl: string,
  mimeType: string,
): Promise<{ dataUrl: string; mimeType: string }> {
  const MAX_EDGE = 1568;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale >= 1) {
    return { dataUrl, mimeType }; // 原图足够小，保持原样
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { dataUrl, mimeType };
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), mimeType: "image/jpeg" };
}

let attachmentSeq = 0;

export function Composer({ status, commands, popoverOpen = false }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const busy = status.isStreaming || status.isCompacting;
  // 弹窗 Esc 关闭标记：文本变化时复位（继续输入重新触发补全）
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 候选弹窗容器（滚动同步用）。 */
  const suggestRef = useRef<HTMLDivElement>(null);
  /** 接受补全后把光标置于文本末尾（受控 setState 后需显式设置选区）。 */
  const caretAtEnd = useRef(false);

  const query = useMemo(() => (isCommandQuery(text) ? text.slice(1) : ""), [text]);
  const candidates = useMemo(() => matchCommands(commands, query), [commands, query]);
  // 用 isCommandQuery 而非 query 长度门禁：仅输入 /（空查询）也要弹出全部命令；
  // 接受补全后 text 为 /cmd （含尾空格）谓词失效，弹窗自然关闭（不会重新弹出）
  const popupVisible = !suggestDismissed && isCommandQuery(text) && candidates.length > 0;
  // 防越界夹取（列表变化瞬间 highlight 可能超出新长度）
  const activeIndex = Math.min(highlight, Math.max(0, candidates.length - 1));

  // 列表变化（过滤输入/命令刷新）时高亮重置为第一项
  useEffect(() => {
    setHighlight(0);
  }, [candidates]);

  // 高亮项滚动同步：activeIndex 或列表变化时把选中项滚入弹窗可视区。
  // block:'nearest' 只滚最近的滚动容器（弹窗自身），不牵动消息列表；
  // 依赖含 candidates：覆盖“滚轮滚到底 + 高亮已在 0 + 过滤变化”的路径
  //（activeIndex 值不变时列表变化也需要回滚到首项）。
  // 已知有意行为：鼠标 hover 改 highlight 也会触发本 effect（nearest 无跳跃，良性）。
  useEffect(() => {
    const items = suggestRef.current?.querySelectorAll(".composer-suggest-item");
    items?.[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, candidates]);

  // 接受补全后：聚焦输入框并把光标移到末尾
  useEffect(() => {
    if (!caretAtEnd.current) {
      return;
    }
    caretAtEnd.current = false;
    const ta = inputRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [text]);

  const accept = (cmd: SlashCommand) => {
    // 插入 /命令 + 尾部空格，留在输入框继续编辑（首词仍在输入中，直接整体替换）
    setText(`/${cmd.name} `);
    setSuggestDismissed(false);
    caretAtEnd.current = true;
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return;
    }
    vscode.postMessage({
      type: "sendPrompt",
      text: trimmed,
      images: attachments.map((a) => ({ data: a.data, mimeType: a.mimeType })),
    });
    setText("");
    setAttachments([]);
  };

  const addImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      void compressImage(dataUrl, file.type).then((compressed) => {
        const base64 = compressed.dataUrl.slice(compressed.dataUrl.indexOf(",") + 1);
        setAttachments((prev) => [
          ...prev,
          { id: ++attachmentSeq, data: base64, mimeType: compressed.mimeType },
        ]);
      });
    };
    reader.readAsDataURL(file);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          addImageFile(file);
        }
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popupVisible) {
      // IME 组合输入期间不拦截任何键：候选词确认（Enter）/翻页（↑↓）与弹窗快捷键冲突
      if (e.nativeEvent.isComposing) {
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, candidates.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // 弹窗打开时 Enter 优先接受补全（含 busy 态）；接受后再按 Enter 才是发送
        e.preventDefault();
        accept(candidates[activeIndex]);
        return;
      }
      if (e.key === "Tab") {
        // Tab 仅在弹窗打开时接受补全；弹窗关闭时保持默认焦点移动
        e.preventDefault();
        accept(candidates[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        // Esc 分层：弹窗打开 → 仅关闭弹窗；再次 Esc 才走中断/清空
        e.preventDefault();
        setSuggestDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      // 配置面板打开：Esc 只关面板（面板侧 capture 监听负责），不中断/清空
      e.preventDefault();
      if (popoverOpen) {
        return;
      }
      // 流式中 Esc 中断；空闲时清空输入
      if (busy) {
        vscode.postMessage({ type: "abort" });
      } else {
        setText("");
      }
    }
  };

  const onSuggestionMouseDown = (e: MouseEvent) => {
    // 防止点击候选项导致 textarea 失焦（失焦后 webview 滚动可能跳动）
    e.preventDefault();
  };

  const rows = Math.min(8, Math.max(2, text.split("\n").length));

  return (
    <div className="composer">
      {popupVisible && (
        <div className="composer-suggest" role="listbox" aria-label="命令补全" ref={suggestRef}>
          {candidates.map((cmd, i) => (
            <div
              key={`${cmd.name}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`composer-suggest-item${i === activeIndex ? " active" : ""}`}
              onMouseDown={onSuggestionMouseDown}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => accept(cmd)}
            >
              <span className="composer-suggest-name">/{cmd.name}</span>
              {cmd.description && (
                <span className="composer-suggest-desc">{cmd.description}</span>
              )}
              <span className="composer-suggest-source">{sourceLabel(cmd.source)}</span>
            </div>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <div key={a.id} className="composer-attachment">
              <img src={`data:${a.mimeType};base64,${a.data}`} alt="附件" />
              <button
                className="composer-attachment-remove"
                title="移除"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={inputRef}
          className="composer-input"
          placeholder={
            busy
              ? "流式输出中——发送将加入队列（steer）"
              : "输入消息或 / 命令"
          }
          rows={rows}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSuggestDismissed(false); // 文本变化复位 Esc 关闭标记，继续输入重新触发补全
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {busy ? (
          <button
            className="composer-stop"
            title="中断当前操作 (Esc)"
            onClick={() => vscode.postMessage({ type: "abort" })}
            dangerouslySetInnerHTML={{ __html: stopIcon }}
          />
        ) : (
          <button
            className="composer-send"
            title="发送 (Enter)"
            onClick={send}
            disabled={!text.trim() && attachments.length === 0}
            dangerouslySetInnerHTML={{ __html: sendIcon }}
          />
        )}
      </div>
    </div>
  );
}
