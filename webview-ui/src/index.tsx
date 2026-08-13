import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// acquireVsCodeApi 必须在模块作用域调用一次（webview 会话内重复调用会抛错）
export const vscode = acquireVsCodeApi();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
