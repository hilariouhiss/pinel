import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { vscode } from "../index";
import { isCommandQuery, matchCommands } from "../command-match";
import type { Attachment, ChatStatus, FileItem, SlashCommand } from "../types";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import sendIcon from "../../../media/send.svg";
import stopIcon from "../../../media/stop.svg";
import settingsIcon from "../../../media/settings.svg";
import extensionIcon from "../../../media/extension.svg";

interface Props {
  status: ChatStatus;
  commands: SlashCommand[];
  /** 配置面板打开时：Esc 让位给面板关闭，不触发中断/清空（双保险，面板侧 capture 已拦截）。 */
  popoverOpen?: boolean;
  /** Ctrl+G 编辑器保存回填（seq 驱动重复回填）。 */
  fill?: { seq: number; text: string };
  /** Ctrl+G 命令触发版本（每次递增：webview 取当前输入内容发起编辑）。 */
  editPromptTrigger?: number;
  /** 配置面板开合态（下半 ⚙ 设置按钮 aria-expanded）。 */
  settingsOpen?: boolean;
  /** 下半 ⚙ 设置按钮（toggle 打开配置面板）。 */
  onOpenSettings?: () => void;
  /** 扩展管理弹层开合态（下半扩展按钮 aria-expanded）。 */
  extensionOpen?: boolean;
  /** 下半扩展按钮（toggle 打开扩展管理弹层）。 */
  onOpenExtensions?: () => void;
  /** 扩展按钮元素引用（App 持有，ExtensionPopover 锚定用）。 */
  extensionBtnRef?: RefObject<HTMLButtonElement | null>;
  /** 工作区文件列表（@ 添加文件数据；App 持有，getFileList 响应填充）。 */
  fileList?: FileItem[];
}

/** 来源徽标（中文标签）；未知来源兜底"其他"（pi 未来可能新增 source）。 */
function sourceLabel(source: string | undefined): string {
  switch (source) {
    case "extension":
      return "Extension";
    case "prompt":
      return "Prompt";
    case "skill":
      return "Skill";
    default:
      return "Other";
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

export function Composer({
  status,
  commands,
  popoverOpen = false,
  fill,
  editPromptTrigger = 0,
  settingsOpen = false,
  onOpenSettings,
  extensionOpen = false,
  onOpenExtensions,
  extensionBtnRef,
  fileList = [],
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** @ 文件引用（发送时 pinel 自读内容附加；附件区卡片展示）。 */
  const [fileRefs, setFileRefs] = useState<string[]>([]);
  const busy = status.isStreaming || status.isCompacting;
  // 弹窗 Esc 关闭标记：文本变化时复位（继续输入重新触发补全）
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  /** @ 文件弹窗 Esc 关闭标记（文本变化时复位，继续输入重新触发）。 */
  const [fileDismissed, setFileDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 当前输入文本引用（Ctrl+G 触发 effect 需最新值，避免绑定 text 依赖重复触发）。 */
  const textRef = useRef("");
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

  // @ 文件引用触发：当前词（空格分隔的末 token）以 @ 开头（含仅输入 @）；
  // 与命令补全弹窗互斥（isCommandQuery 为 false 时才可能触发）
  const lastToken = text.split(/\s+/).pop() ?? "";
  const atTrigger = lastToken.startsWith("@");
  const atQuery = atTrigger ? lastToken.slice(1) : "";
  const fileCandidates = useMemo(() => {
    if (!atQuery) {
      return fileList;
    }
    const q = atQuery.toLowerCase();
    return fileList.filter((f) => f.path.toLowerCase().includes(q));
  }, [fileList, atQuery]);
  const filePopupVisible = !fileDismissed && atTrigger;
  // 文件弹窗高亮（独立索引，避免与命令补全高亮互相污染）
  const [fileHighlight, setFileHighlight] = useState(0);
  const fileActiveIndex = Math.min(fileHighlight, Math.max(0, fileCandidates.length - 1));
  const fileSuggestRef = useRef<HTMLDivElement>(null);

  // 高亮项滚动同步（文件弹窗）
  useEffect(() => {
    const items = fileSuggestRef.current?.querySelectorAll(".composer-file-suggest-item");
    items?.[fileActiveIndex]?.scrollIntoView({ block: "nearest" });
  }, [fileActiveIndex, fileCandidates]);

  // @ 触发时拉取文件列表（每次触发重新扫描，保证新鲜）
  useEffect(() => {
    if (atTrigger) {
      vscode.postMessage({ type: "getFileList" });
    }
  }, [atTrigger]);

  // 查询变化时高亮重置（弹窗关闭标记由 onChange 复位——直接 @ 选择后
  // atQuery 可能不变（"" → ""），effect 依赖会漏复位）
  useEffect(() => {
    setFileHighlight(0);
  }, [atQuery]);

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

  // 当前输入文本同步到 ref（Ctrl+G 触发 effect 读最新值）
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // Ctrl+G 命令触发（keybinding when: pinel.inputFocused 已限定输入框聚焦）：
  // 取当前输入内容发起编辑（宿主不维护输入状态，内容必须往返）
  useEffect(() => {
    if (editPromptTrigger === 0) {
      return;
    }
    vscode.postMessage({ type: "editPrompt", text: textRef.current });
  }, [editPromptTrigger]);

  // 编辑器保存回填：替换输入内容（caretAtEnd 效果负责聚焦+光标末尾）
  useEffect(() => {
    if (!fill || fill.seq === 0) {
      return;
    }
    setText(fill.text);
    caretAtEnd.current = true;
  }, [fill?.seq]);

  const accept = (cmd: SlashCommand) => {
    // 插入 /命令 + 尾部空格，留在输入框继续编辑（首词仍在输入中，直接整体替换）
    setText(`/${cmd.name} `);
    setSuggestDismissed(false);
    caretAtEnd.current = true;
  };

  /** @ 文件选中：移除输入中 @token + 附件区新增引用卡片 + 关闭弹窗。 */
  const acceptFile = (file: FileItem) => {
    const token = text.split(/\s+/).pop() ?? "";
    const prefix = text.slice(0, Math.max(0, text.length - token.length));
    setText(prefix);
    setFileRefs((prev) => (prev.includes(file.path) ? prev : [...prev, file.path]));
    setFileDismissed(true);
    caretAtEnd.current = true;
  };

  const removeFileRef = (ref: string) => {
    setFileRefs((prev) => prev.filter((r) => r !== ref));
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0 && fileRefs.length === 0) {
      return;
    }
    vscode.postMessage({
      type: "sendPrompt",
      text: trimmed,
      images: attachments.map((a) => ({ data: a.data, mimeType: a.mimeType })),
      fileRefs,
    });
    setText("");
    setAttachments([]);
    setFileRefs([]);
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
    // @ 文件弹窗（与命令补全互斥，不会同时打开；IME 组合输入期间不拦截）
    if (filePopupVisible) {
      if (e.nativeEvent.isComposing) {
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileHighlight((h) => Math.min(h + 1, Math.max(fileCandidates.length - 1, 0)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // 文件弹窗打开时 Enter 优先接受文件（而非发送）
        e.preventDefault();
        const file = fileCandidates[fileActiveIndex];
        if (file) {
          acceptFile(file);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFileDismissed(true);
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

  // 起始 1 行（单行高度），随换行增长，上限 8 行封顶后内部滚动
  const rows = Math.min(8, Math.max(1, text.split("\n").length));

  return (
    <div className="footer-card">
      {popupVisible && (
        <div className="composer-suggest" role="listbox" aria-label="Command suggestions" ref={suggestRef}>
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
      {filePopupVisible && (
        <div className="composer-file-suggest" role="listbox" aria-label="Add file" ref={fileSuggestRef}>
          {fileCandidates.length === 0 ? (
            <div className="composer-file-suggest-empty">No matching files</div>
          ) : (
            fileCandidates.map((file, i) => (
              <div
                key={file.path}
                role="option"
                aria-selected={i === fileActiveIndex}
                className={`composer-file-suggest-item${i === fileActiveIndex ? " active" : ""}`}
                onMouseDown={onSuggestionMouseDown}
                onMouseEnter={() => setFileHighlight(i)}
                onClick={() => acceptFile(file)}
              >
                <span className="composer-file-suggest-path">{file.path}</span>
                {file.isImage && <span className="composer-file-suggest-type">Image</span>}
              </div>
            ))
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <div key={a.id} className="composer-attachment">
              <img src={`data:${a.mimeType};base64,${a.data}`} alt="Attachment" />
              <button
                className="composer-attachment-remove"
                title="Remove"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {fileRefs.length > 0 && (
        <div className="composer-file-refs">
          {fileRefs.map((ref) => (
            <span key={ref} className="composer-file-ref" title={ref}>
              <span className="composer-file-ref-name">📄 {ref}</span>
              <button
                className="composer-file-ref-remove"
                title="Remove"
                onClick={() => removeFileRef(ref)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        className="composer-input"
        placeholder={
          busy ? "Streaming — sending will be queued (steer)" : "Type a message, Ctrl+G to edit in editor"
        }
        rows={rows}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSuggestDismissed(false); // 文本变化复位 Esc 关闭标记，继续输入重新触发补全
          setFileDismissed(false); // 同上：@ 文件弹窗关闭标记（修复：直接 @ 选择后 atQuery 不变导致不复位）
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => vscode.postMessage({ type: "inputFocus", focused: true })}
        onBlur={() => vscode.postMessage({ type: "inputFocus", focused: false })}
      />
      <div className="footer-actions">
        <button
          className="status-settings-btn"
          title="Settings"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onOpenSettings}
          disabled={!onOpenSettings}
          dangerouslySetInnerHTML={{ __html: settingsIcon }}
        />
        <button
          ref={extensionBtnRef}
          className="status-extensions-btn"
          title="Extensions"
          aria-label="Extensions"
          aria-haspopup="dialog"
          aria-expanded={extensionOpen}
          onClick={onOpenExtensions}
          disabled={!onOpenExtensions}
          dangerouslySetInnerHTML={{ __html: extensionIcon }}
        />
        <span className="footer-actions-spacer" />
        {busy ? (
          <button
            className="composer-stop"
            title="Stop current operation (Esc)"
            onClick={() => vscode.postMessage({ type: "abort" })}
            dangerouslySetInnerHTML={{ __html: stopIcon }}
          />
        ) : (
          <button
            className="composer-send"
            title="Send (Enter)"
            onClick={send}
            disabled={!text.trim() && attachments.length === 0 && fileRefs.length === 0}
            dangerouslySetInnerHTML={{ __html: sendIcon }}
          />
        )}
      </div>
    </div>
  );
}
