import type { KeyboardEvent } from "react";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import paperclipIcon from "lucide-static/icons/paperclip.svg";

interface Props {
  /** 最近用户输入文本（已含引用替换）；空串 → 不渲染（空会话/仅图片兜底由 App 处理）。 */
  lastUserText: string;
  /** 仅图片消息：文案为兜底 "图片"，前置回形针图标。 */
  imageOnly?: boolean;
  /** 点击滚回原用户消息位置。 */
  onLocate: () => void;
}

/**
 * 最近回合悬浮条：经 App 内 .recent-round-anchor（高 0 sticky）钉在滚动视口
 * 顶部（不占布局、不随消息流滚走），宽度与消息卡片结构级同宽；
 * 纯显示最近一次用户发送的消息（最多 3 行、超出 ellipsis 截断，CSS clamp），
 * 滚动查看历史时始终可见当前回合输入。点击滚回原消息位置。
 */
export function RecentRoundBar({ lastUserText, imageOnly = false, onLocate }: Props) {
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
      <span className="recent-round-bar-text">
        {imageOnly && (
          <span className="recent-round-bar-icon" dangerouslySetInnerHTML={{ __html: paperclipIcon }} />
        )}{" "}
        {lastUserText}
      </span>
    </div>
  );
}
