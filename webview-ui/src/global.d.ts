/** webview 全局声明 */

// VS Code webview 注入的 API（每个 webview 会话只能调用一次）
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T>(state: T): void;
};

// 允许 esbuild 打包 CSS side-effect 导入
// 允许 import SVG 原始文本（esbuild text loader，图标内联进 DOM 渲染）
declare module "*.css";
declare module "*.svg";
