import { useState, type KeyboardEvent } from "react";
import { vscode } from "../index";
import type { UiRequest } from "../types";
import { Markdown } from "./Markdown";

interface Props {
  requests: UiRequest[];
}

/**
 * 扩展对话框内联卡片（渲染在聊天流末尾）。
 *
 * 对话框方法（select/confirm/input/editor）阻塞 agent，等待用户答复；
 * 卡片内的 Esc 只取消当前对话框（输入框 keydown 独立处理，不触发
 * Composer 的全局 abort）。
 */
export function UiDialogs({ requests }: Props) {
  if (requests.length === 0) {
    return null;
  }
  return (
    <div className="uidialogs">
      {requests.map((req) => (
        <DialogCard key={req.id} request={req} />
      ))}
    </div>
  );
}

function DialogCard({ request }: { request: UiRequest }) {
  const cancel = () => vscode.postMessage({ type: "uiResponse", id: request.id, cancelled: true });

  switch (request.method) {
    case "select":
      return <SelectCard request={request} onCancel={cancel} />;
    case "confirm":
      return <ConfirmCard request={request} onCancel={cancel} />;
    case "input":
    case "editor":
      return <TextCard request={request} multiline={request.method === "editor"} onCancel={cancel} />;
    default:
      return (
        <div className="uidialog" data-dialog-id={request.id}>
          <DialogTitle request={request} />
          <div className="uidialog-actions">
            <button className="uidialog-btn" onClick={cancel}>
              关闭
            </button>
          </div>
        </div>
      );
  }
}

function DialogTitle({ request }: { request: UiRequest }) {
  if (!request.title) {
    return null;
  }
  return (
    <div className="uidialog-title">
      <Markdown content={request.title} />
    </div>
  );
}

function SelectCard({ request, onCancel }: { request: UiRequest; onCancel: () => void }) {
  const options = request.options ?? [];
  return (
    <div className="uidialog" data-dialog-id={request.id}>
      <DialogTitle request={request} />
      {options.length > 0 ? (
        <div className="uidialog-options">
          {options.map((option, i) => (
            <button
              key={`${i}-${option}`}
              className="uidialog-option"
              onClick={() => vscode.postMessage({ type: "uiResponse", id: request.id, value: option })}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <div className="uidialog-empty">（无可用选项）</div>
      )}
      <div className="uidialog-actions">
        <button className="uidialog-btn uidialog-btn-ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function ConfirmCard({ request, onCancel }: { request: UiRequest; onCancel: () => void }) {
  return (
    <div className="uidialog" data-dialog-id={request.id}>
      <DialogTitle request={request} />
      {request.message && <div className="uidialog-message">{request.message}</div>}
      <div className="uidialog-actions">
        <button
          className="uidialog-btn uidialog-btn-primary"
          onClick={() => vscode.postMessage({ type: "uiResponse", id: request.id, confirmed: true })}
        >
          确认
        </button>
        <button
          className="uidialog-btn"
          onClick={() => vscode.postMessage({ type: "uiResponse", id: request.id, confirmed: false })}
        >
          拒绝
        </button>
        <button className="uidialog-btn uidialog-btn-ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function TextCard({
  request,
  multiline,
  onCancel,
}: {
  request: UiRequest;
  multiline: boolean;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const submit = () => vscode.postMessage({ type: "uiResponse", id: request.id, value });

  // Esc 只取消当前对话框；Ctrl+Enter（多行）提交
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (!multiline || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="uidialog" data-dialog-id={request.id}>
      <DialogTitle request={request} />
      {multiline ? (
        <textarea
          className="uidialog-textarea"
          value={value}
          rows={6}
          placeholder={request.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <input
          className="uidialog-input"
          value={value}
          placeholder={request.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      <div className="uidialog-actions">
        <button className="uidialog-btn uidialog-btn-primary" onClick={submit}>
          提交
        </button>
        <button className="uidialog-btn uidialog-btn-ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
