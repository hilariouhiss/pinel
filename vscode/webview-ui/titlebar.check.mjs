/**
 * titlebar 自检：守卫「弹窗内容区独立滚动，关闭按钮行固定」的布局不被误改。
 * 挂入 npm run compile 门：规则被误删时编译即红。仅守卫规则存在，不验证渲染（渲染由像素差分验证）。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const css = readFileSync("webview-ui/src/styles.css", "utf8");

// 标题栏 flex:none 固定尺寸，不参与 flex 收缩
assert.match(css, /\.popover-titlebar \{[^}]*flex:\s*none;/, "styles.css 的 .popover-titlebar 必须 flex:none（关闭按钮行不随内容收缩/滚走）");
// 滚动只发生在标题栏之下的 .popover-body
assert.match(css, /\.popover-body \{[^}]*min-height:\s*0;/, "styles.css 的 .popover-body 必须 min-height:0（flex 子项可收缩，overflow 才生效）");
assert.match(css, /\.popover-body \{[^}]*overflow-y:\s*auto;/, "styles.css 必须有 .popover-body 独立滚动区");
// 面板本体不得自带 overflow——否则整个面板滚动，标题栏随之滚走
assert.doesNotMatch(css, /\.config-popover \{[^}]*overflow/, "styles.css 的 .config-popover 不得自带 overflow（滚动只允许在 .popover-body）");
assert.doesNotMatch(css, /\.extension-popover \{[^}]*overflow/, "styles.css 的 .extension-popover 不得自带 overflow（滚动只允许在 .popover-body）");

console.log("titlebar check OK");
