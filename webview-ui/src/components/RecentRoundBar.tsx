import type { KeyboardEvent } from "react";

interface Props {
  /** 最近用户输入文本（已含 📎 引用替换）；空串 → 不渲染（空会话/仅图片兜底由 App 处理）。 */
  lastUserText: string;
  /** 点击滚回原用户消息位置。 */
  onLocate: () => void;
}

/**
 * 最近回合悬浮条：锚 .chat-header 下方（不占布局、不随消息流滚走），
 * 纯显示最近一次用户发送的消息（最多 3 行、超出 ellipsis 截断，CSS clamp），
 * 滚动查看历史时始终可见当前回合输入。点击滚回原消息位置。
 */
export function RecentRoundBar({ lastUserText, onLocate }: Props) {
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
      <span className="recent-round-bar-text">{lastUserText}</span>
    </div>
  );
}
