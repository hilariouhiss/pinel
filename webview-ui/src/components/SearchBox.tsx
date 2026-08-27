import searchIcon from "lucide-static/icons/search.svg";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * 会话列表搜索框（弹层与主侧边栏共用）：
 * lucide search 左侧内联（stroke=currentColor 跟随输入框前景色）+ 受控 input。
 * 过滤逻辑由调用方实现（本地过滤，items 已全量在 webview）。
 */
export function SearchBox({ value, onChange, placeholder = "Search sessions" }: Props) {
  return (
    <div className="search-box">
      <span className="search-box-icon" dangerouslySetInnerHTML={{ __html: searchIcon }} />
      <input
        className="search-box-input"
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
