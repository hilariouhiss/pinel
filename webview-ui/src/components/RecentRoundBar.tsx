import type { KeyboardEvent } from "react";

interface Props {
  /** 最近用户输入文本（已含 📎 引用替换）；空串 → 不渲染（空会话/仅图片兜底由 App 处理）。 */
  lastUserText: string;
  /** Pi 是否正在处理（流式/工具运行）。 */
  streaming: boolean;
  /** 流式尾部状态文本：最近文本块尾 60 字符 / 工具名 / "Thinking…" / 空（仅 spinner）。 */
  streamTail: string;
  /** 点击滚回原用户消息位置。 */
  onLocate: () => void;
}

/**
 * 最近回合悬浮状态条：锚 .chat-header 下方（不占布局、不随消息流滚走），
 * 滚动查看历史时始终可见当前回合输入与 Pi 处理状态。
 * 形态：左状态（流式中 spinner / 空闲 ✓ 已完成）、中最近输入单行截断、右流式尾部。
 */
export function RecentRoundBar({ lastUserText, streaming, streamTail, onLocate }: Props) {
  if (!lastUserText) {
    return null;
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onLocate();
    }
  };
  return (
    <div
      className="recent-round-bar"
      role="button"
      tabIndex={0}
      title="Scroll to this message"
      aria-label={`Current round: ${lastUserText.slice(0, 80)}`}
      onClick={onLocate}
      onKeyDown={onKeyDown}
    >
      <span className="recent-round-bar-status">
        {streaming ? <span className="spinner" /> : "✓ 已完成"}
      </span>
      <span className="recent-round-bar-text">{lastUserText}</span>
      {streaming && streamTail && <span className="recent-round-bar-tail">…{streamTail}</span>}
    </div>
  );
}
