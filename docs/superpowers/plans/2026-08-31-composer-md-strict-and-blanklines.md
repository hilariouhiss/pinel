# 输入框 markdown 严格渲染 + 空行/光标对齐修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 输入框 WYSIWYG 渲染层严格按 markdown 语法渲染（有序 `数字. `、无序 `- `，其余按正文），并修复空行不显示与光标错位。

**Architecture:** 渲染库结论——**react-markdown v10 + remark-gfm 已是输入框与消息渲染器**（Composer.tsx:17-18、Markdown.tsx:2-3，package.json 既有依赖），无需换库；任何现成库都不提供「与 textarea 等宽字体逐行像素对齐」的 WYSIWYG 层（这是本项目的定制约束），问题全部出在自定义压平层：① 块间合成换行只有一个 `\n`，源文空行全部塌缩（remark-rehype 探针实证）；② 非严格列表标记（`* `、`+ `、`1) `）被 CommonMark 解析成列表。修复：新增纯函数 `strictListSyntax`（逐行转义非严格标记为字面文本，围栏感知）+ rehype 插件 `composerGapAlign`（剔除合成换行、按节点 position 在块间注入**源文精确间隙**、根级补首尾空白），渲染行数与 textarea 原文严格一致 → 空行可见、光标对齐。

**Tech Stack:** react-markdown v10 / remark-gfm（既有）、rehype 插件、纯函数 + `node --experimental-strip-types` 自检（沿仓库 check 模式）。零新依赖。

**Spec:** 本会话用户需求（无独立 spec，本 plan 即规范）。

## 需求明细

1. 渲染库评估：现有库是否可用（结论见「Architecture」，证据见 Task 2 探针）。
2. 输入框渲染严格遵循 markdown 语法：`#` 标题、`**粗体**`、`` `code` ``、围栏代码块、`- ` 列表、`1. ` 列表、`> ` 引用、`---`、GFM 表格/删除线等照常渲染。
3. 非 markdown 块按正文渲染（含被转义的非严格列表行，原文可见）。
4. 有序列表仅 `数字. `（`1) ` 等一律按正文）；无序列表仅 `- `（`* `、`+ ` 按正文）。
5. 空行修复：任意数量的空行、块间空行、列表项间换行、首尾空行，渲染层行数与 textarea 原文一致；光标/选区与显示文本对齐。

## Global Constraints

- 等宽对齐前提不变：渲染层仅改变颜色/字重/背景，不改变字形宽度；markdown 语法字符以同宽标记符替换（`- `→`• ` 等宽）。转义新增的 `\` 在渲染输出中被 remark 消费，不占宽度（探针验证：`\* x` 渲染为 `* x`）。
- 仅作用于渲染层输入（`mdContent` 流水线）；发送/复制仍是 textarea 原始源码（现状契约，`supportEmptyListItems` 注释同）。
- 围栏代码块内（``` / ~~~）不得转义/修改（字面文本契约）。
- 缩进 ≤3 空格的行首才是列表标记候选（CommonMark 语义）；≥4 空格为缩进代码块，不动。
- 零新依赖；中文注释；`npm run compile` / `npm run package` 全绿；composer-md.check.mjs 既有用例保持全绿。
- 已知不修（挂账）：GFM 表格分隔行不渲染（行数偏差，既有注释承认）；块引用内嵌的非严格列表标记（`> * x`）不转义；tab 缩进列表。

## File Structure

- 修改 `vscode/webview-ui/src/composer-md.ts` — 新增 `strictListSyntax()`、`composerGapAlign()`（rehype 插件工厂）及内部 `gapBetween()`/`GAP_BLOCKS`；既有导出不动。
- 修改 `vscode/webview-ui/composer-md.check.mjs` — 新增严格列表转义用例 + 用真实 remark-rehype 管线的行数对齐探针（vscode/node_modules 依赖直引）。
- 修改 `vscode/webview-ui/src/components/Composer.tsx` — `mdContent` 流水线接入 strictListSyntax；ReactMarkdown 挂 `rehypePlugins={[[composerGapAlign, mdContent]]}`；移除 ul/ol/li/blockquote 组件内已冗余的 `stripLeadingNewline` 调用。

---

### Task 1: composer-md.ts — 严格列表转义 + 间隙对齐插件

**Files:**
- Modify: `vscode/webview-ui/src/composer-md.ts`

**Interfaces:**
- Consumes: 无（纯函数文件；hast 节点形状 `{type:"text"|"element", tagName?, value?, children?, position?:{start:{offset},end:{offset}}}`）
- Produces:
  - `strictListSyntax(content: string): string` — 围栏感知逐行转义 `* `、`+ `、`N) ` 为字面文本
  - `composerGapAlign(content: string): (tree: Root) => void` — rehype 插件：剔除合成换行、块间注入源间隙、根级补首尾空白
  - 内部：`GAP_BLOCKS: Set<string>`（p/h1-6/ul/ol/pre/blockquote/table/hr/li）、`gapBetween(content, a, b): string`

- [ ] **Step 1: 在 composer-md.ts 末尾追加**

```ts
/** 严格列表语法：仅 "数字. " 有序与 "- " 无序是列表；"* "、"+"、"N) " 逐行转义为
 *  字面文本（渲染输出与原文等宽——反斜杠被 remark 消费不占位）。
 *  围栏代码块内不动（字面契约）；缩进 ≤3 才是列表候选（≥4 是缩进代码块）。 */
export function strictListSyntax(content: string): string {
  let fence: string | null = null;
  return content
    .split("\n")
    .map((line) => {
      const fm = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
      if (fm) {
        fence = fence === null ? fm[2][0] : fence === fm[2][0] ? null : fence;
        return line;
      }
      if (fence !== null) return line;
      // 组1=缩进，组2=非严格标记（* / + / 数字+闭括号），后随空白或行尾
      return line.replace(/^(\s{0,3})([*+]|\d+\))(?=\s|$)/, (_m, indent: string, marker: string) => {
        return indent + marker.replace(/[*+)]/g, (c) => `\\${c}`);
      });
    })
    .join("\n");
}

/** 间隙注入的「块」集合（li 同块：每个列表项都始于新行）。 */
const GAP_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "blockquote", "table", "hr", "li"]);

/** 两相邻块间的源文精确切片（含全部空行）；position 缺失退回单个换行。 */
function gapBetween(content: string, a: any, b: any): string {
  const ae = a?.position?.end?.offset;
  const bs = b?.position?.start?.offset;
  return typeof ae === "number" && typeof bs === "number" ? content.slice(ae, bs) : "\n";
}

/**
 * rehype 插件：让渲染层行数与 textarea 原文严格一致。
 * 1) 剔除所有空白纯文本子（remark-rehype 的合成 "\n" 分隔符——单个换行
 *    只能让下一块另起一行，源文的 N 个空行会塌缩成 0）；
 * 2) 相邻块元素之间注入 gapBetween 源间隙（含精确空行数）；
 * 3) 根级首尾：源文以空行开头/结尾时补足前缀/后缀（光标停在首尾空行不飘）。
 */
export function composerGapAlign(content: string) {
  return (tree: any): void => {
    const fix = (node: any): void => {
      const children: any[] = node.children ?? [];
      const kids = children.filter((c: any) => !(c.type === "text" && /^[\n ]*$/.test(c.value)));
      const out: any[] = [];
      for (const c of kids) {
        const prev = out[out.length - 1];
        if (prev && GAP_BLOCKS.has(c.tagName) && GAP_BLOCKS.has(prev.tagName)) {
          out.push({ type: "text", value: gapBetween(content, prev, c) });
        }
        out.push(c);
      }
      if (node.type === "root" && out.length > 0 && GAP_BLOCKS.has(out[0].tagName)) {
        const s = out[0]?.position?.start?.offset;
        if (typeof s === "number" && s > 0 && /^[\n ]+$/.test(content.slice(0, s))) {
          out.unshift({ type: "text", value: content.slice(0, s) });
        }
        const last = out[out.length - 1];
        const e = last?.position?.end?.offset;
        if (typeof e === "number" && e < content.length && /^[\n ]+$/.test(content.slice(e))) {
          out.push({ type: "text", value: content.slice(e) });
        }
      }
      node.children = out;
      for (const c of out) {
        if (c.type === "element") fix(c);
      }
    };
    fix(tree);
  };
}
```

- [ ] **Step 2: 跑既有自检确认无回归**

Run: `cd vscode && npm run check:composer-md`
Expected: 既有断言全绿（本任务只追加导出，不改旧函数）。

- [ ] **Step 3: Commit**

```bash
git -C vscode add webview-ui/src/composer-md.ts
git -C vscode commit -m "feat(composer-md): 严格列表转义 + rehype 间隙对齐插件（源文行数精确还原）"
```

---

### Task 2: composer-md.check.mjs — 转义用例 + 真实管线行数对齐探针

**Files:**
- Modify: `vscode/webview-ui/composer-md.check.mjs`

**Interfaces:**
- Consumes: Task 1 的 `strictListSyntax`、`composerGapAlign`；vscode/node_modules 的 `unified`/`remark-parse`/`remark-gfm`/`remark-rehype`
- Produces: 自检断言（转义规则 + 渲染行数 = 源文行数）

- [ ] **Step 1: 追加用例（import 补 `strictListSyntax, composerGapAlign`）**

```js
// ---- strictListSyntax：仅 "数字. " 与 "- " 是列表 ----
assert.strictEqual(strictListSyntax("* item"), "\\* item");
assert.strictEqual(strictListSyntax("+ item"), "\\+ item");
assert.strictEqual(strictListSyntax("1) item"), "1\\) item");
assert.strictEqual(strictListSyntax("123) item"), "123\\) item");
assert.strictEqual(strictListSyntax("  * sub"), "  \\* sub", "缩进≤3 同样转义");
assert.strictEqual(strictListSyntax("    * code"), "    * code", "缩进≥4 是代码块不动");
assert.strictEqual(strictListSyntax("- item"), "- item", "合法无序列表不动");
assert.strictEqual(strictListSyntax("1. item"), "1. item", "合法有序列表不动");
assert.strictEqual(strictListSyntax("1.item"), "1.item", "无空白不是列表候选");
assert.strictEqual(strictListSyntax("***"), "***", "星号 HR 不动（无尾空白）");
assert.strictEqual(
  strictListSyntax("```\n* x\n```\n* y"),
  "```\n* x\n```\n\\* y",
  "围栏内不动、围栏外转义",
);
assert.strictEqual(strictListSyntax("a\n\n*b"), "a\n\n\\*b", "块间空行后同样转义");
```

- [ ] **Step 2: 追加行数对齐探针（真实 remark-gfm 管线，复刻 Composer 压平规则）**

```js
// ---- composerGapAlign：渲染行数 = 源文行数（真实管线）----
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

/** 复刻 Composer 压平（块塌缩行内；code 用源切片）；与插件组合后行数必等。 */
function flatten(content, node) {
  if (node.type === "text") return node.value;
  if (node.type === "element" && node.tagName === "code") {
    const p = node.position;
    return p ? content.slice(p.start.offset, p.end.offset) : "";
  }
  return (node.children ?? []).map((c) => flatten(content, c)).join("");
}

const CASES = [
  "para1\n\npara2",
  "para1\n\n\npara2",
  "- a\n\npara2",
  "- a\n- b",
  "# H\n\npara",
  "para1\npara2",
  "- a\n  - b\n\npara",
  "```\nx\ny\n```\n\npara",
  "> q1\n> q2\n\npara",
  "\n\npara", // 开头空行
  "para\n\n", // 结尾空行
  "* em\n\npara", // 转义后按正文
  "1) x\n\npara", // 转义后按正文
];
for (const src of CASES) {
  const mdContent = strictListSyntax(src); // 与 Composer 相同的流水线
  const hast = processor.runSync(processor.parse(mdContent));
  composerGapAlign(mdContent)(hast);
  const rendered = flatten(mdContent, hast);
  assert.strictEqual(
    rendered.split("\n").length,
    src.split("\n").length,
    `行数必须一致: ${JSON.stringify(src)} → ${JSON.stringify(rendered)}`,
  );
}
```

- [ ] **Step 3: 跑自检**

Run: `cd vscode && npm run check:composer-md`
Expected: `composer-md check OK`（旧用例 + 12 条转义 + 13 条行数对齐全绿）。

- [ ] **Step 4: Commit**

```bash
git -C vscode add webview-ui/composer-md.check.mjs
git -C vscode commit -m "test(composer-md): 严格转义用例 + 真实管线行数对齐探针"
```

---

### Task 3: Composer.tsx — 接入流水线与插件

**Files:**
- Modify: `vscode/webview-ui/src/components/Composer.tsx`

**Interfaces:**
- Consumes: Task 1 的 `strictListSyntax`、`composerGapAlign`
- Produces: 渲染层行数与 textarea 一致；发送/复制路径不变

- [ ] **Step 1: import 与 mdContent 流水线**

```tsx
import { composerGapAlign, sliceLiMarker, strictListSyntax, supportEmptyListItems } from "../composer-md";
```

`ComposerMarkdown` 内（`:109` 附近）：

```tsx
  // 渲染层输入流水线：严格列表转义（* + N) → 字面文本）→ 裸标记行补零宽
  // 字符；后续 code/li 的位置切片与间隙对齐插件均以本串为准
  const mdContent = strictListSyntax(supportEmptyListItems(content));
```

- [ ] **Step 2: ReactMarkdown 挂 rehype 插件**

`<ReactMarkdown ...>` 处，`remarkPlugins={[remarkGfm]}` 同行加：

```tsx
        rehypePlugins={[[composerGapAlign, mdContent]]}
```

- [ ] **Step 3: 移除已冗余的 stripLeadingNewline 调用**

ul/ol/li/blockquote 组件改为直接透传 children（插件已剔除合成换行）：

```tsx
          ul: ({ children }) => <>{children}</>,
          ol: ({ children }) => <>{children}</>,
          li: ({ children, node }) => (
            <span className="composer-md-li">
              <span className="composer-md-marker">{sliceLiMarker(mdContent, node?.position)}</span>
              {children}
            </span>
          ),
          blockquote: ({ children }) => (
            <span className="composer-md-quote">{children}</span>
          ),
```

删除 `import { ..., stripLeadingNewline } ...` 中的 `stripLeadingNewline`（composer-md.ts 保留导出——check 脚本仍在测它）。

- [ ] **Step 4: 类型检查 + 构建 + 自检**

Run: `cd vscode && npm run check:composer-md && npm run check-types && node webview-ui/esbuild.js`
Expected: 全绿；media/webview.js 构建成功。

- [ ] **Step 5: Commit**

```bash
git -C vscode add webview-ui/src/components/Composer.tsx
git -C vscode commit -m "feat(composer): 渲染层接入严格列表转义与间隙对齐插件"
```

---

### Task 4: 端到端验证（构建 + F5 手动清单）

**Files:**
- 无生产变更；临时探针不落库

**Interfaces:**
- Consumes: Task 1-3 全部
- Produces: 验证记录；手动清单留给用户

- [ ] **Step 1: 全门验证**

Run: `cd vscode && npm run compile && npm run package`
Expected: 全部 check（含 composer-md 探针）+ lint + esbuild 绿。

- [ ] **Step 2: 浏览器级渲染抽查（headless Edge，临时页）**

用 `.tmp-composer-verify/check.html`：内嵌 webview 打包产物不可行（React 应用），改抽查 rehype 管线输出——把 `composerGapAlign` 的等价 JS 内联进页面脚本对 13 个 CASES 行数断言（与 Task 2 探针同源）；再加一个纯 DOM 布局断言：等宽字体下 `div(white-space:pre-wrap)` 与 `textarea` 同文本的 clientHeight 相等（空行布局的浏览器级实证）。
Run: `"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --no-first-run --dump-dom --virtual-time-budget=8000 --user-data-dir="<tmp profile>" "file:///C:/source_code/Other/pinel/.tmp-composer-verify/check.html" 2>/dev/null | grep -o "RESULT.*"`
Expected: `RESULT all-ok`（含行数与高度断言）。验证后删除临时目录。

- [ ] **Step 3: F5 手动清单（人类步骤，记录在案）**

装好扩展后：
1. 输入 `para1`、空行、`para2` → 空行可见；光标在 para2 行首与显示文本对齐；Ctrl+G 打开编辑器对比完全一致。
2. 输入 `* item`、`+ item`、`1) item` → 按原文正文显示（星号/加号/右括号可见，无列表样式）。
3. 输入 `- item`、`1. item` → 列表标记灰显、内容正常；连续多行列表无多余/缺失空行。
4. 空列表项（裸 `-` / `1.` 行）行为不变；围栏代码块内 `* x` 原样字面。
5. 复制/发送内容仍是原始 markdown 源码。
6. 粘贴多空行长文本：滚动、光标、选区位置与显示一致。

- [ ] **Step 4: 清理临时目录；无代码变更则跳过 commit**

---

## Self-Review

- **Spec coverage:** 需求 1 → Architecture 结论 + Task 2 真实管线探针；需求 2/3/4 → Task 1 strictListSyntax + Task 3 接入；需求 5 → composerGapAlign + Task 2 行数断言 + Task 4 浏览器级高度断言与手动清单。全覆盖。
- **Placeholder scan:** 无 TBD；全部步骤含可执行代码/命令。
- **Type consistency:** `strictListSyntax(content: string): string`、`composerGapAlign(content: string): (tree) => void` 在 Task 1/2/3 一致；`GAP_BLOCKS` 含 li；gap 注入条件（双侧块）与 li 换行场景匹配（Task 2 CASES 覆盖 `- a\n- b` 与嵌套列表）。
- **风险记录:** 转义依赖 remark 反斜杠消费（探针 `\* x`→`* x` 已证）；表格式分隔行与块引用内嵌标记不修（挂账，见 Global Constraints）；hast position 在 react-markdown 管线存在性由既有 `code`/`li` 切片代码实证（同管线同数据）。
