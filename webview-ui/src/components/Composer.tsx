import { useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { vscode } from "../index";
import type { Attachment, ChatStatus } from "../types";

interface Props {
  status: ChatStatus;
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

export function Composer({ status }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = status.isStreaming || status.isCompacting;

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

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      for (const file of files) {
        addImageFile(file);
      }
    }
    e.target.value = "";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      // 流式中 Esc 中断；空闲时清空输入
      e.preventDefault();
      if (busy) {
        vscode.postMessage({ type: "abort" });
      } else {
        setText("");
      }
    }
  };

const rows = Math.min(8, Math.max(2, text.split("\n").length));

  return (
    <div className="composer">
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
        <button
          className="composer-icon-btn"
          title="添加图片"
          onClick={() => fileInput.current?.click()}
        >
          🖼
        </button>
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={onPick} />
        <textarea
          className="composer-input"
          placeholder={
            busy ? "流式输出中——发送将加入队列（steer）" : "给 Pi 发送消息（Enter 发送，Shift+Enter 换行，Esc 中断）"
          }
          rows={rows}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {busy ? (
          <button className="composer-stop" title="中断当前操作 (Esc)" onClick={() => vscode.postMessage({ type: "abort" })}>
            ⏹
          </button>
        ) : (
          <button className="composer-send" title="发送 (Enter)" onClick={send} disabled={!text.trim() && attachments.length === 0}>
            ➤
          </button>
        )}
      </div>
    </div>
  );
}
