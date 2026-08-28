import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 流式 markdown 渲染（react-markdown v10 + remark-gfm）。
 *
 * 安全：react-markdown 默认不渲染原始 HTML（无 rehype-raw），
 * 配合 webview CSP（default-src 'none'）天然防 XSS。
 * 链接在 v0.1 渲染为纯文本（CSP 禁止导航，暂不接 vscode.open 命令）。
 * GFM：表格/删除线/任务列表等（remark-gfm 打进 webview bundle）。
 */
export function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children }) => <span className="md-link">{children}</span>,
        code: ({ className, children }) => {
          // 块级代码（带 language-xxx class 或含换行）→ 代码块；否则行内
          const text = String(children).replace(/\n$/, "");
          const isBlock = Boolean(className) || text.includes("\n");
          if (isBlock) {
            return (
              <pre className="md-codeblock">
                <code className={className}>{text}</code>
              </pre>
            );
          }
          return <code className="md-code">{text}</code>;
        },
        pre: ({ children }) => <>{children}</>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
