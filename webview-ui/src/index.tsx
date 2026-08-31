import { createRoot } from "react-dom/client";
import App from "./App";
import HistoryApp from "./HistoryApp";
import "./styles.css";

// acquireVsCodeApi 必须在模块作用域调用一次（webview 会话内重复调用会抛错）
export const vscode = acquireVsCodeApi();

// 双视图分支：宿主 HTML 的 body[data-pinel-view] 标记视图类型
//（"history" = 会话历史主侧边栏；其余 = 聊天次侧边栏）
const view = document.body.dataset.pinelView ?? "chat";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(view === "history" ? <HistoryApp /> : <App />);
  // 移除挂载前的加载动画（HTML 内联 #boot-loader，主题化 spinner）。
  // 字体（font-display:block）就绪后再揭晓：div 渲染层随字体就绪自动重排，
  // textarea 却可能以回退字体完成首次布局（候选加载竞态）——在字体就绪前
  // 遮住 UI 可避免用户在错位状态下开始输入；3s 兑底 = block 期上限。
  const boot = document.getElementById("boot-loader");
  if (boot) {
    let done = false;
    const remove = () => {
      if (!done) {
        done = true;
        boot.remove();
      }
    };
    const fallback = setTimeout(remove, 3000);
    document.fonts.ready.then(() => {
      clearTimeout(fallback);
      remove();
    });
  }
}

// 滚动条空闲自动隐藏：文档级 capture 监听任意区域的 scroll 事件（scroll 不冒泡，
// capture 才能一网打尽）→ 给 <html> 打 pinel-scrolling 类；1s 无滚动移除，
// CSS 据此淡出所有滑块。覆盖聊天/历史两个视图的全部滚动区。
const SCROLL_IDLE_MS = 1000;
let scrollIdleTimer: number | undefined;
document.addEventListener(
  "scroll",
  () => {
    document.documentElement.classList.add("pinel-scrolling");
    window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      document.documentElement.classList.remove("pinel-scrolling");
    }, SCROLL_IDLE_MS);
  },
  { capture: true, passive: true },
);
