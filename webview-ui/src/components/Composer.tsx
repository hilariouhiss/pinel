import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { vscode } from "../index";
import { isCommandQuery, matchCommands } from "../command-match";
import { parseAtRefs, matchAtToken } from "../at-refs";
import { sliceLiMarker } from "../composer-md";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Attachment, ChatStatus, FileItem, SlashCommand } from "../types";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import sendIcon from "lucide-static/icons/send.svg";
import stopIcon from "lucide-static/icons/square.svg";
import settingsIcon from "lucide-static/icons/settings.svg";
import extensionIcon from "lucide-static/icons/puzzle.svg";

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
  /** 模型 chip 开合态（锚定 ModelPopover）。 */
  modelOpen?: boolean;
  /** 模型 chip 点击（toggle 打开锚定下拉）。 */
  onOpenModel?: () => void;
  /** 模型 chip 元素引用（App 持有，ModelPopover 锚定用）。 */
  modelChipRef?: RefObject<HTMLButtonElement | null>;
  /** 思考 chip 开合态。 */
  thinkingOpen?: boolean;
  /** 思考 chip 点击（toggle 打开锚定下拉）。 */
  onOpenThinking?: () => void;
  /** 思考 chip 元素引用（App 持有，ModelPopover 锚定用）。 */
  thinkingChipRef?: RefObject<HTMLButtonElement | null>;
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

/**
 * 输入框 WYSIWYG 渲染层：块元素全部折叠为行内，与 textarea 原始文本像素级对齐。
 * 对齐前提：等宽字体（--pinel-font-family），仅颜色/字重/斜体/背景等不改变
 * 字形宽度的样式；markdown 语法字符（**、#、- 等）以同宽标记符/样式替换。
 * 列表标记按 node.position 从原文切出（无序 -、*、+ → • ，有序 1. /3) 原样，
 * 宽度忠实）；表格分隔符不渲染、图片 🖼 占位。
 * 复制/发送仍是 textarea 的原始 markdown 源码（本层纯视觉，aria-hidden）。
 */
function ComposerMarkdown({ content, mdRef }: { content: string; mdRef: RefObject<HTMLDivElement | null> }) {
  const h = (marker: string) =>
    ({ children }: { children?: ReactNode }) => (
      <span className="composer-md-h">
        <span className="composer-md-marker">{marker}</span>
        {children}
      </span>
    );
  return (
    <div className="composer-md" aria-hidden="true" ref={mdRef}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <>{children}</>,
          a: ({ children }) => <span className="md-link">{children}</span>,
          code: ({ children, node }) => {
            // 宽度忠实渲染：用 node.position 源偏移切出含反引号/围栏的原始
            // 切片（等宽字体下与 textarea 原文 1:1 对齐，任意反引号数皆准）；
            // position 缺失（异常路径）退回纯内容。围栏含 \n → block 样式
            const text = String(children).replace(/\n$/, "");
            const pos = node?.position;
            const raw =
              pos?.start?.offset != null && pos?.end?.offset != null
                ? content.slice(pos.start.offset, pos.end.offset)
                : text;
            return <code className={raw.includes("\n") ? "composer-md-block" : "composer-md-inline-code"}>{raw}</code>;
          },
          pre: ({ children }) => <>{children}</>,
          h1: h("# "),
          h2: h("## "),
          h3: h("### "),
          h4: h("#### "),
          h5: h("##### "),
          h6: h("###### "),
          ul: ({ children }) => <>{children}</>,
          ol: ({ children }) => <>{children}</>,
          li: ({ children, node }) => (
            <span className="composer-md-li">
              <span className="composer-md-marker">{sliceLiMarker(content, node?.position)}</span>
              {children}
            </span>
          ),
          blockquote: ({ children }) => <span className="composer-md-quote">{children}</span>,
          hr: () => <span className="composer-md-hr">---</span>,
          table: ({ children }) => <>{children}</>,
          thead: ({ children }) => <>{children}</>,
          tbody: ({ children }) => <>{children}</>,
          tr: ({ children }) => <>{children}</>,
          th: ({ children }) => <>{children}</>,
          td: ({ children }) => <>{children}</>,
          img: () => <span className="composer-md-img">🖼</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

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
  modelOpen = false,
  onOpenModel,
  modelChipRef,
  thinkingOpen = false,
  onOpenThinking,
  thinkingChipRef,
  fileList = [],
}: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // @ 文件引用不再有独立 state：内联在输入文本中，发送时从文本解析 @token 注入
  const busy = status.isStreaming || status.isCompacting;
  // 弹窗 Esc 关闭标记：文本变化时复位（继续输入重新触发补全）
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  /** @ 文件弹窗 Esc 关闭标记（文本变化时复位，继续输入重新触发）。 */
  const [fileDismissed, setFileDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // 窗口 resize 触发输入框高度自适应重算（默认上限随面板高变化）
  const [viewportTick, setViewportTick] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 渲染层容器（滚动同步：textarea 内部滚动时 backdrop 同步 scrollTop）。 */
  const mdRef = useRef<HTMLDivElement>(null);
  /** IME 组合输入期间：临时恢复原文（透明文字下组合候选不可见），隐藏渲染层。 */
  const [isComposing, setIsComposing] = useState(false);
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

  // @ 文件引用触发：当前词（空格分隔的末 token）为进行中的 @ 引用
  // （裸 @…或未闭合的 `@…，判定纯函数见 matchAtToken）；与命令补全弹窗互斥
  const lastToken = text.split(/\s+/).pop() ?? "";
  const { trigger: atTrigger, query: atQuery } = matchAtToken(lastToken);
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

  // 高亮项滚动同步（文件弹窗）：仅跟随高亮变化（键盘导航/悬停）；
  // 输入过滤/弹窗打开的滚回顶部由下方复位 effect 的 scrollTop 直置处理
  useEffect(() => {
    const items = fileSuggestRef.current?.querySelectorAll(".composer-file-suggest-item");
    items?.[fileActiveIndex]?.scrollIntoView({ block: "nearest" });
  }, [fileActiveIndex]);

  // @ 触发时拉取文件列表（每次触发重新扫描，保证新鲜）
  useEffect(() => {
    if (atTrigger) {
      vscode.postMessage({ type: "getFileList" });
    }
  }, [atTrigger]);

  // 文件弹窗打开/过滤变化：高亮复位 + 确定性滚回顶部。
  // 依赖 filePopupVisible 覆盖 "" ↔ "@" 重开缺口（atQuery 恒为 ""、fileCandidates
  // 引用不变，仅 atQuery 依赖会漏复位）；scrollTop 直置与复位同 effect 原子生效。
  useEffect(() => {
    setFileHighlight(0);
    const el = fileSuggestRef.current;
    if (el) {
      el.scrollTop = 0;
    }
  }, [fileCandidates, filePopupVisible]);

  // 高亮项滚动同步：仅跟随高亮变化（键盘导航/悬停）。
  // 列表变化路径（过滤输入/命令刷新）的滚回顶部由下方复位 effect 确定性处理
  //（scrollTop 直置），此处不再依赖 candidates——旧实现于同一 flush 内用陈旧
  // activeIndex 先滚到底、复位后置，产生“滑到底再回顶”的一帧闪烁。
  useEffect(() => {
    const items = suggestRef.current?.querySelectorAll(".composer-suggest-item");
    items?.[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // 弹窗打开/候选变化（过滤输入/命令刷新）：高亮复位为首项 + 确定性滚回顶部。
  // 依赖 popupVisible 覆盖 "" ↔ "/" 重开缺口（query 恒为 ""、candidates 引用不变，
  // 仅 candidates 依赖会漏复位）；scrollTop 直置与复位同 effect 原子生效，
  // 声明序在滚动同步之后：同 flush 内覆盖陈旧 scrollIntoView 的滚动。
  useEffect(() => {
    setHighlight(0);
    const el = suggestRef.current;
    if (el) {
      el.scrollTop = 0;
    }
  }, [candidates, popupVisible]);

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

  // 输入框高度自适应：scrollHeight 按渲染行计（软换行计入），上限 = 拖拽值 ?? 面板高 60%，
  // 超上限内部滚动。修复 Ctrl+G 回填/粘贴大文本不适应（旧 rows 机制不计软换行）。
  // resize 后高度重算：默认 cap 随面板高变化（评审 #2）。
  const defaultMaxH = Math.round(window.innerHeight * 0.6);
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) {
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, defaultMaxH)}px`;
    ta.style.overflowY = ta.scrollHeight > defaultMaxH ? "auto" : "hidden";
  }, [text, viewportTick]);
  useEffect(() => {
    const onResize = () => setViewportTick((v) => v + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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

  /** @ 文件选中：末 @token 替换为反引号包裹的规范引用（`@path / `@"含空格"`）+ 尾空格。
   *  仅反引号包裹的 @file 才在发送时解析为文件引用（parseAtRefs 语法）；
   *  尾空格方便直接继续输入，闭合态 token + 尾空格不会重新触发弹窗（matchAtToken），
   *  且 acceptFile 置 fileDismissed 双保险；发送时统一从文本解析 @token（同链路）。 */
  const acceptFile = (file: FileItem) => {
    const token = text.split(/\s+/).pop() ?? "";
    const prefix = text.slice(0, Math.max(0, text.length - token.length));
    const ref = /\s/.test(file.path) ? `@"${file.path}"` : `@${file.path}`;
    setText(`${prefix}\`${ref}\` `);
    setFileDismissed(true);
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
      // 发送时从文本解析 @引用（与列表选择同链路；未匹配 @token 保留普通文本）
      fileRefs: parseAtRefs(trimmed, fileList),
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
        const file = fileCandidates[fileActiveIndex];
        if (file) {
          e.preventDefault();
          acceptFile(file);
          return;
        }
        // 候选为空（手打路径无匹配）：不拦截，落入下方正常发送（发送解析尝试注入）
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

  // 起始 1 行；高度由自适应 effect 以 style 驱动（scrollHeight 按渲染行计，软换行计入）
  const rows = 1;

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
      <div className={`composer-input-wrap${isComposing ? " composing" : ""}`}>
        <ComposerMarkdown content={text} mdRef={mdRef} />
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
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onScroll={(e) => {
            if (mdRef.current) {
              mdRef.current.scrollTop = e.currentTarget.scrollTop;
            }
          }}
          onFocus={() => vscode.postMessage({ type: "inputFocus", focused: true })}
          onBlur={() => vscode.postMessage({ type: "inputFocus", focused: false })}
        />
      </div>
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
        {/* 模型/思考 chip：常显当前值（设置/扩展按钮右侧），点击弹锚定下拉切换（唯一切换入口）；
            无模型时模型 chip 禁用、思考 chip 隐藏（对齐 ConfigPopover 思考行先例）；
            流式中不禁用（变更自下一回合生效） */}
        {status.model === null ? (
          <button className="composer-chip" disabled title="No model">
            No model
          </button>
        ) : (
          <button
            ref={modelChipRef}
            className={`composer-chip${modelOpen ? " open" : ""}`}
            title={status.model.provider && status.model.id ? `${status.model.provider}/${status.model.id}` : "Model"}
            aria-haspopup="listbox"
            aria-expanded={modelOpen}
            onClick={onOpenModel}
            disabled={!onOpenModel}
          >
            {status.model.name ?? status.model.id ?? "Model"}
          </button>
        )}
        {status.model !== null && (
          <button
            ref={thinkingChipRef}
            className={`composer-chip${thinkingOpen ? " open" : ""}`}
            title="Thinking effort"
            aria-haspopup="listbox"
            aria-expanded={thinkingOpen}
            onClick={onOpenThinking}
            disabled={!onOpenThinking}
          >
            {status.thinkingLevel}
          </button>
        )}
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
            disabled={!text.trim() && attachments.length === 0}
            dangerouslySetInnerHTML={{ __html: sendIcon }}
          />
        )}
      </div>
    </div>
  );
}
