/**
 * ui-layout 自检：守卫四项 UI 修复的关键 CSS 规则不被误删。
 * 挂入 npm run compile 门：规则被误删时编译即红。仅守卫规则存在，不验证渲染。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const css = readFileSync("webview-ui/src/styles.css", "utf8");

// 1) TodoPanel 收起细条：0fr 折叠容器必须裁剪 item 溢出，body 必须 border-box
assert.match(css, /\.todopanel-collapse \{\s*[\s\S]*?overflow:\s*hidden;/, "todopanel-collapse 必须 overflow:hidden（0fr 时裁剪 padding/border 溢出）");
assert.match(css, /\.todopanel-body \{\s*[\s\S]*?box-sizing:\s*border-box;/, "todopanel-body 必须 border-box（行高归零 padding 坍缩）");

// 2) Context 条换行：窄面板下 chip 换行而非溢出
assert.match(css, /\.context-bar \{\s*[\s\S]*?flex-wrap:\s*wrap;/, "context-bar 必须 flex-wrap:wrap");

// 3) 水平滚动条：隐藏提示条用 visibility 门控（opacity:0 仍参与滚动溢出）
assert.match(css, /\.ctx-hover-tip \{\s*[\s\S]*?visibility:\s*hidden;/, "ctx-hover-tip 必须 visibility:hidden 隐藏");
assert.match(css, /\.ctx-chip-wrap:hover \.ctx-hover-tip \{\s*[\s\S]*?visibility:\s*visible;/, "hover 必须切 visibility:visible");

// 4) 对话框按钮禁用态（问卷 Submit 未答完视觉反馈）
assert.match(css, /\.uidialog-btn:disabled \{\s*opacity:\s*0\.5;/, "uidialog-btn 必须有 :disabled 半透明样式");

console.log("ui-layout check OK");
