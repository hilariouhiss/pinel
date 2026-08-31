# 滚动条：全区域去箭头 + 不滚动时自动隐藏 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** webview 内所有区域（横向 + 垂直）滚动条无箭头按钮，且 1s 无滚动后滑块淡出自动隐藏。

**Architecture:** 全 webview 用非 layer 规则把 `scrollbar-color` 复位为 `auto`，强制所有滚动条走 `-webkit` 自定义路径（VS Code 注入的 `@layer vscode-default` 标准路径在 Windows 会画带箭头的原生滚动条，且 CSS 无法隐藏/淡出）；配合全局 `::-webkit-scrollbar-button { display: none }` 去箭头；index.tsx 加一个文档级 capture 滚动监听，滚动时给 `<html>` 打 `pinel-scrolling` 类，1s 无滚动移除，CSS 据此过渡滑块 opacity 实现自动隐藏。

**Tech Stack:** VS Code webview（Electron/Chromium 132+）、纯 CSS + ~12 行 TS、零新依赖。

**Spec:** 本会话用户需求（无独立 spec 文档，本 plan 即规范，见「需求明细」节）。

**当前状态（重要）：** 提交 `311a213` 已移除此前三个滚动区自画的三角箭头按钮，并在 styles.css 末尾留下 10 行「仅滑块」块（`::-webkit-scrollbar-button { display: none }`）。但三个常驻滚动区此时回落到了 VS Code 注入的标准 `scrollbar-color` 路径——该路径在 Windows 上渲染原生滚动条（带箭头），不可用 CSS 隐藏。本计划在既有基础上：① 全局强制自定义路径彻底杜绝箭头；② 增加空闲自动隐藏。

## 需求明细

1. **去箭头**：所有区域（消息区、待办面板、输入框、通知条、popover、历史视图、代码块预览等）的横向和垂直滚动条均无上下/左右箭头按钮。
2. **空闲自动隐藏**：不滚动时滚动条滑块不可见；滚动期间及停止后短暂窗口内可见；常驻滚动区 hover 时可见（可直接抓取）。
3. **不回归**：主题化 thumb 颜色（VS Code 注入）、10px 滚动条宽度、现有滚动交互逻辑（App.tsx 的 stickToBottom/onScroll、Composer 的 scrollTop 同步）全部保持不变。

## Global Constraints

- 引擎版本：VS Code `^1.125.0`（Electron Chromium 132+，`::-webkit-scrollbar-*`、`@layer`、`:is()`、capture 监听均可用）。
- 只允许使用 `--vscode-*` 主题变量；不新增依赖；不新增构建步骤。
- CSS 注释沿用中文、行宽约 90、区块分隔线风格（`/* ---- 标题 */`）。
- `npm run compile` / `npm run package` 全绿为验收底线。
- 不改 App.tsx / Composer.tsx 的滚动逻辑。

## File Structure

- 修改 `vscode/webview-ui/src/styles.css` — 文件末尾 10 行「仅滑块」块替换为「无箭头 + 空闲淡出」块（含全局 `scrollbar-color` 复位）。全 webview 滚动条样式的唯一来源。
- 修改 `vscode/webview-ui/src/index.tsx` — 模块作用域加文档级滚动活动监听（聊天气泡/历史两个视图共用此入口，一处生效）。
- 新建 `vscode/webview-ui/scrollbar.check.mjs` — 静态自检（沿用仓库 `*.check.mjs` 模式），守卫关键规则不被误删。
- 修改 `vscode/package.json` — 挂入 `check:scrollbar` 到 `compile` / `package` 门。

---

### Task 1: styles.css — 全局自定义路径 + 去箭头 + 空闲淡出

**Files:**
- Modify: `vscode/webview-ui/src/styles.css`（文件末尾块替换）

**Interfaces:**
- Consumes: 无
- Produces: 类名契约 `html.pinel-scrolling`（Task 2 的 JS 打/撤此类）；CSS 规则：
  - `* { scrollbar-color: auto; }`（全局复位标准路径）
  - `::-webkit-scrollbar-button { display: none; }`（全区域去箭头）
  - `html:not(.pinel-scrolling) ::-webkit-scrollbar-thumb { opacity: 0; }`（空闲隐藏）
  - `html:not(.pinel-scrolling) :is(.pinel-scroll, .todopanel-body, .composer-input):hover::-webkit-scrollbar-thumb { opacity: 1; }`（hover 保持可见）
  - `::-webkit-scrollbar-thumb { transition: opacity 0.3s ease; }`

- [ ] **Step 1: 替换文件末尾的「仅滑块」块**

`vscode/webview-ui/src/styles.css` 末尾，将旧块：

```css
/* ------------------------------------------------------------ 滚动条：仅滑块 */
/* 全局隐藏滚动条上下箭头按钮，只保留滑块。
   - 此前在面板/消息区/输入框画的三角箭头已移除，三处回归 VS Code 注入的
     标准滚动条（scrollbar-color 路径，本身不带箭头）；
   - 本规则兜底任何落入 -webkit 自定义路径的滚动条，保证整个 webview 无箭头。 */
::-webkit-scrollbar-button {
  display: none;
}
```

整体替换为：

```css
/* -------------------------------------------- 滚动条：无箭头 + 空闲自动隐藏 */
/* 全 webview 强制 -webkit 自定义滚动条路径：
   - VS Code 在 @layer vscode-default 注入 scrollbar-color（标准路径，Windows 上
     渲染原生经典滚动条——带上下/左右箭头，且 CSS 无法隐藏或淡出）；
   - 非 layer 的 auto 复位压过注入规则；复位后 VS Code 注入的 width/height 10px
     与主题化 thumb 颜色（同为 @layer 规则）继续生效，只多不少。 */
* {
  scrollbar-color: auto;
}

/* 兜底无箭头（自定义路径下不样式化按钮即无箭头，此规则显式保证） */
::-webkit-scrollbar-button {
  display: none;
}

/* 空闲自动隐藏：html 无 .pinel-scrolling（1s 内无滚动事件）时滑块淡出；
   三大常驻滚动区 hover 时保持可见，方便直接抓取滚动条 */
::-webkit-scrollbar-thumb {
  transition: opacity 0.3s ease;
}

html:not(.pinel-scrolling) ::-webkit-scrollbar-thumb {
  opacity: 0;
}

html:not(.pinel-scrolling) :is(.pinel-scroll, .todopanel-body, .composer-input):hover::-webkit-scrollbar-thumb {
  opacity: 1;
}
```

- [ ] **Step 2: 确认替换完整、旧规则无残留**

Run: `grep -n "scrollbar" vscode/webview-ui/src/styles.css`
Expected: 只有新块的 6 处匹配（`scrollbar-color: auto`、`::-webkit-scrollbar-button`、`::-webkit-scrollbar-thumb` ×3、`::-webkit-scrollbar-thumb` 的 hover 规则里 `pinel-scrolling` 的 3 处类名引用）；不再出现「三角箭头」旧注释。

- [ ] **Step 3: Commit**

```bash
git -C vscode add webview-ui/src/styles.css
git -C vscode commit -m "feat(scrollbar): 全 webview 强制自定义滚动条路径并支持空闲淡出"
```

---

### Task 2: index.tsx — 文档级滚动活动监听

**Files:**
- Modify: `vscode/webview-ui/src/index.tsx`（模块作用域，boot-loader 块之后）

**Interfaces:**
- Consumes: 类名契约 `pinel-scrolling`（Task 1 CSS 依赖）
- Produces: `<html>` 元素上 `pinel-scrolling` 类的增删时序：任意滚动事件 → 立即加类；停止 1000ms 后移除。常量 `SCROLL_IDLE_MS = 1000`。

- [ ] **Step 1: 在 `if (container) { ... }` 块之后追加监听**

```tsx
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
```

- [ ] **Step 2: 类型检查**

Run: `cd vscode && npm run check-types`
Expected: PASS（`window.setTimeout` 返回 number 与 `scrollIdleTimer` 声明匹配）。

- [ ] **Step 3: Commit**

```bash
git -C vscode add webview-ui/src/index.tsx
git -C vscode commit -m "feat(scrollbar): 文档级滚动监听驱动空闲自动隐藏"
```

---

### Task 3: 静态自检脚本 + 挂入 compile 门

**Files:**
- Create: `vscode/webview-ui/scrollbar.check.mjs`
- Modify: `vscode/package.json`（scripts 区）

**Interfaces:**
- Consumes: Task 1 的 CSS 规则文本、Task 2 的类名与 capture 选项
- Produces: `npm run check:scrollbar`（退出码 0 = 关键规则齐全）；被 `compile` / `package` 链引用

- [ ] **Step 1: 写自检脚本**

```js
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
```

- [ ] **Step 2: package.json 挂入门链**

`vscode/package.json` scripts 区：
- 新增一行：`"check:scrollbar": "node webview-ui/scrollbar.check.mjs",`
- `compile` 与 `package` 两条链中，在 `check:composer-md` 之后插入 `npm run check:scrollbar &&`（两处）。

- [ ] **Step 3: 跑自检确认通过**

Run: `cd vscode && npm run check:scrollbar`
Expected: 输出 `scrollbar check OK`，退出码 0。

- [ ] **Step 4: 跑完整编译门**

Run: `cd vscode && npm run compile`
Expected: 全部 check 通过，esbuild 构建成功（media/webview.js 已更新）。

- [ ] **Step 5: Commit**

```bash
git -C vscode add webview-ui/scrollbar.check.mjs package.json
git -C vscode commit -m "feat(scrollbar): 自检脚本守卫无箭头+空闲隐藏规则并入 compile 门"
```

---

### Task 4: 行为验证（headless Edge + 手动清单）

**Files:**
- Create（临时，验证后删除）: `.tmp-scrollbar-verify/check.html`

**Interfaces:**
- Consumes: Task 1 CSS、Task 2 JS 的最终形态
- Produces: 验证记录（DOM 计算样式断言输出）；不做代码修改

- [ ] **Step 1: 行为验证页**

`.tmp-scrollbar-verify/check.html` —— 复刻 VS Code 注入层 + 本次 CSS/JS 原样贴入，用 `getComputedStyle` 断言实际生效状态：

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
  @layer vscode-default {
    html { scrollbar-color: #797979 #1e1e1e; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb { background-color: #797979; }
  }
  :root { --vscode-scrollbarSlider-background: #797979; }
  .pinel-scroll { width: 200px; height: 120px; overflow-y: auto; }
  /* === styles.css 新增块（原样）=== */
  * { scrollbar-color: auto; }
  ::-webkit-scrollbar-button { display: none; }
  ::-webkit-scrollbar-thumb { transition: opacity 0.3s ease; }
  html:not(.pinel-scrolling) ::-webkit-scrollbar-thumb { opacity: 0; }
  html:not(.pinel-scrolling) :is(.pinel-scroll, .todopanel-body, .composer-input):hover::-webkit-scrollbar-thumb { opacity: 1; }
</style></head><body>
  <div class="pinel-scroll" id="s"><p>1</p><p>2</p><p>3</p><p>4</p><p>5</p><p>6</p><p>7</p><p>8</p><p>9</p><p>10</p></div>
  <pre id="out"></pre>
<script>
  // === index.tsx 新增监听（原样）===
  const SCROLL_IDLE_MS = 1000;
  let scrollIdleTimer;
  document.addEventListener("scroll", () => {
    document.documentElement.classList.add("pinel-scrolling");
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => document.documentElement.classList.remove("pinel-scrolling"), SCROLL_IDLE_MS);
  }, { capture: true, passive: true });

  const el = document.getElementById("s");
  const gs = (e, p) => getComputedStyle(e, p);
  const r = {};
  r.scrollbarColor = gs(el).scrollbarColor;                     // 期望 auto（复位生效）
  r.buttonDisplay = gs(el, "::-webkit-scrollbar-button").display; // 期望 none
  r.thumbIdleOpacity = gs(el, "::-webkit-scrollbar-thumb").opacity; // 期望 0（无类）
  el.dispatchEvent(new Event("scroll"));                        // 触发监听 → 加类
  r.thumbScrollingOpacity = gs(el, "::-webkit-scrollbar-thumb").opacity; // 期望 1
  document.getElementById("out").textContent = "RESULT " + JSON.stringify(r);
</script></body></html>
```

- [ ] **Step 2: headless Edge 跑断言**

Run:

```bash
mkdir -p .tmp-scrollbar-verify && cd .tmp-scrollbar-verify
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --no-first-run --dump-dom --virtual-time-budget=8000 --user-data-dir="$PWD/profile" "file:///$PWD/check.html" 2>/dev/null | grep -o "RESULT.*"
```

Expected: `"scrollbarColor":"auto","buttonDisplay":"none","thumbIdleOpacity":"0","thumbScrollingOpacity":"1"`。
（若 `thumbScrollingOpacity` 因 transition 报中间值，删除测试页里的 `transition` 行重跑——transition 本身在真机肉眼验证。）

- [ ] **Step 3: 删临时目录**

Run: `rm -rf .tmp-scrollbar-verify`

- [ ] **Step 4: VS Code 手动验证清单**

`cd vscode && npm run package` 后 F5（或重装 vsix）：
1. 消息区 / 待办面板 / 输入框 / 通知条 / popover / 历史视图：任何滚动条均无箭头（横向、垂直）。
2. 滚轮滚动任一区域 → 滑块出现；停止 1s 后淡出不可见。
3. 鼠标悬停消息区（不滚动）→ 滑块可见，可直接拖拽。
4. 键盘滚动（输入框 ↑/↓、消息区 PgDn）同样触发显示/隐藏。
5. 深色/浅色主题各验一次：滑块颜色随主题，淡入淡出无闪烁。

- [ ] **Step 5: 无代码变更则跳过 commit；如有微调，提交并注明**

---

## Self-Review

- **Spec coverage:** 需求 1（去箭头）→ Task 1 的 `* { scrollbar-color: auto }` + `::-webkit-scrollbar-button { display: none }`；需求 2（空闲隐藏）→ Task 1 的 opacity 规则 + Task 2 的监听；需求 3（不回归）→ 复位只动 `scrollbar-color`，注入的 10px 宽度与 thumb 颜色规则不动，App/Composer 滚动逻辑零改动（File Structure 明确）。全覆盖。
- **Placeholder scan:** 无 TBD/TODO；所有步骤含可执行代码与命令。
- **Type consistency:** 类名 `pinel-scrolling` 在 CSS、TS、check.mjs、验证页四处一致；`SCROLL_IDLE_MS = 1000` 与 CSS 注释「1s」一致；`capture: true` 与自检断言一致。
