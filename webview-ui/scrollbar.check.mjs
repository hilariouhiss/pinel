/**
 * scrollbar 自检：守卫「全 webview 无箭头 + 空闲自动隐藏」的关键 CSS/JS 不被误删。
 * 挂入 npm run compile 门：规则被误删时编译即红。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const css = readFileSync("webview-ui/src/styles.css", "utf8");
const tsx = readFileSync("webview-ui/src/index.tsx", "utf8");

// 全局复位标准滚动条路径（压过 VS Code @layer 注入 → 全 webview 可定制/可淡出）
assert.match(css, /\* \{\s*scrollbar-color:\s*auto;?\s*\}/, "styles.css 必须含 * { scrollbar-color: auto }");

// 无箭头
assert.match(css, /::-webkit-scrollbar-button \{\s*display:\s*none;?\s*\}/, "styles.css 必须隐藏滚动条按钮");

// 空闲淡出（html 无 pinel-scrolling 类时）
assert.match(css, /html:not\(\.pinel-scrolling\) ::-webkit-scrollbar-thumb \{\s*opacity:\s*0;?\s*\}/, "styles.css 必须含空闲隐藏规则");

// 滚动活动监听：加/撤类与 capture 缺一不可
assert.match(tsx, /classList\.add\("pinel-scrolling"\)/, "index.tsx 必须给 html 加 pinel-scrolling");
assert.match(tsx, /classList\.remove\("pinel-scrolling"\)/, "index.tsx 必须空闲后移除 pinel-scrolling");
assert.match(tsx, /capture:\s*true/, "index.tsx 滚动监听必须 capture（scroll 不冒泡）");

console.log("scrollbar check OK");
