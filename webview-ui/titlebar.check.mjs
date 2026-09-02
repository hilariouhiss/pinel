/**
 * titlebar 自检：守卫「弹窗标题栏 sticky 钉顶，关闭按钮行不随内容滚动」的关键 CSS 不被误删。
 * 挂入 npm run compile 门：规则被误删时编译即红。仅守卫规则存在，不验证渲染（渲染由像素差分验证）。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const css = readFileSync("webview-ui/src/styles.css", "utf8");

// 标题栏 sticky：config/extension 弹层面板 overflow-y:auto，标题栏必须钉在滚动口顶部
assert.match(css, /\.popover-titlebar \{[^}]*position:\s*sticky;/, "styles.css 的 .popover-titlebar 必须 sticky（关闭按钮行不随内容滚走）");
// 不透明背景：盖住从标题栏下滚过的内容（inherit = 取面板菜单底色）
assert.match(css, /\.popover-titlebar \{[^}]*background:\s*inherit;/, "styles.css 的 .popover-titlebar 必须有不透明背景盖住滚过内容");

console.log("titlebar check OK");
