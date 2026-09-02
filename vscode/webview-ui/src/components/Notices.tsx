import { useEffect } from "react";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import xIcon from "lucide-static/icons/x.svg";

interface Notice {
  id: number;
  level: string;
  text: string;
}

interface Props {
  notices: Notice[];
  onDismiss: (id: number) => void;
}

/** 顶部提示条：自动 8 秒消失，可手动关闭。 */
export function Notices({ notices, onDismiss }: Props) {
  useEffect(() => {
    if (notices.length === 0) {
      return;
    }
    const latest = notices[notices.length - 1];
    const timer = setTimeout(() => onDismiss(latest.id), 8000);
    return () => clearTimeout(timer);
  }, [notices, onDismiss]);

  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="notices">
      {notices.slice(-3).map((n) => (
        <div key={n.id} className={`notice notice-${n.level}`} role="status">
          <span className="notice-text">{n.text}</span>
          <button className="notice-close" onClick={() => onDismiss(n.id)}>
            <span dangerouslySetInnerHTML={{ __html: xIcon }} />
          </button>
        </div>
      ))}
    </div>
  );
}
