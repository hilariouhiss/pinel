/**
 * composer-md 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：列表标记切片规则坏掉时编译即红。
 */
import assert from "node:assert";
import {
  sliceLiMarker,
  stripLeadingNewline,
  supportEmptyListItems,
  strictListSyntax,
  composerGapAlign,
} from "./src/composer-md.ts";

const pos = (start, end) => ({ start: { offset: start }, end: { offset: end } });

// 无序：-、*、+ → •
assert.strictEqual(sliceLiMarker("- a", pos(0, 3)), "• ");
assert.strictEqual(sliceLiMarker("* a", pos(0, 3)), "• ");
assert.strictEqual(sliceLiMarker("+ a", pos(0, 3)), "• ");
// 有序：数字 + . / ) 原样保留
assert.strictEqual(sliceLiMarker("1. a", pos(0, 4)), "1. ");
assert.strictEqual(sliceLiMarker("3) a", pos(0, 4)), "3) ");
// 多位数
assert.strictEqual(sliceLiMarker("10. a", pos(0, 5)), "10. ");
// 裸标记（无尾空白）：标记本身灰显，不回退 •
assert.strictEqual(sliceLiMarker("1.", pos(0, 2)), "1.");
assert.strictEqual(sliceLiMarker("-", pos(0, 1)), "•");
assert.strictEqual(sliceLiMarker("1. ", pos(0, 3)), "1. ");
// 缩进（嵌套 li 行首空格）：原样保留（对齐原文宽度）
assert.strictEqual(sliceLiMarker("  - a", pos(0, 5)), "  • ");
assert.strictEqual(sliceLiMarker("   1. b", pos(0, 8)), "   1. ");
// 多行条目：只取首行标记
assert.strictEqual(sliceLiMarker("1. a\n   b", pos(0, 8)), "1. ");
// position 缺失 / 无 offset：退回 •
assert.strictEqual(sliceLiMarker("x", null), "• ");
assert.strictEqual(sliceLiMarker("x", { start: {}, end: {} }), "• ");

// 空列表项补零宽字符：裸标记行补 ZWSP（行尾已有空白）或 空格+ZWSP，其余行原样
assert.strictEqual(supportEmptyListItems("x\n1."), "x\n1. \u200b");
assert.strictEqual(supportEmptyListItems("-"), "- \u200b");
assert.strictEqual(supportEmptyListItems("1. "), "1. \u200b", "已有尾空白只补 ZWSP");
assert.strictEqual(supportEmptyListItems("  - "), "  - \u200b");
assert.strictEqual(supportEmptyListItems("1. a"), "1. a", "有内容的列表行不补");
assert.strictEqual(supportEmptyListItems("1.a"), "1.a", "非标记行不补");
assert.strictEqual(supportEmptyListItems("x\n1. a\n2.\n"), "x\n1. a\n2. \u200b\n", "逐行处理且保留换行");
assert.strictEqual(supportEmptyListItems(""), "");
// 行首回扫：position 指向标记而非行首时，缩进从上一换行处取回
assert.strictEqual(sliceLiMarker("x\n  - a", pos(4, 7)), "  • ");

// 块容器合成换行剥离：首子为 "\n" 时去掉（ol/ul/li/blockquote 对齐修复）
assert.deepStrictEqual(stripLeadingNewline(["\n", "a", "\n"]), ["a", "\n"]);
// 首子非换行：原样返回（紧凑 li / 内容开头的文本）
assert.deepStrictEqual(stripLeadingNewline(["a", "\n", "b"]), ["a", "\n", "b"]);
// 非数组（单文本子）原样返回
assert.strictEqual(stripLeadingNewline("abc"), "abc");
// 空数组原样返回
assert.deepStrictEqual(stripLeadingNewline([]), []);

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
assert.strictEqual(strictListSyntax("> * x"), "> \\* x", "块引用前缀后同样转义");
assert.strictEqual(strictListSyntax("> > 1) x"), "> > 1\\) x", "嵌套块引用前缀后同样转义");
assert.strictEqual(strictListSyntax("\t* x"), "\t* x", "tab 缩进是代码块不转义");
assert.strictEqual(strictListSyntax("\t1) x"), "\t1) x", "tab 缩进是代码块不转义（有序）");
assert.strictEqual(strictListSyntax("> - x"), "> - x", "块引用内合法无序列表不动");

// ---- composerGapAlign：渲染行数 = 源文行数（真实管线）----
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

/** 复刻 Composer 压平（块塌缩行内；code/table 用源切片）；与插件组合后行数必等。 */
function flatten(content, node) {
  if (node.type === "text") return node.value;
  if (node.type === "element" && (node.tagName === "code" || node.tagName === "table")) {
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
  "> * x\n\npara", // 块引用内嵌转义
  "\t* x\n\npara", // tab 缩进代码块
  "| a | b |\n|---|---|\n| c | d |", // 表格（分隔行可见）
  "para\n\n| a | b |\n|---|---|\n| c | d |\n\npara2", // 表格夹在段落间（周边空行）
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

// ---- 精确渲染断言（字符级）：嵌套列表缩进不得双计 ----
/** 复刻 Composer 渲染（li 前置 sliceLiMarker；code/table 用源切片）。 */
const exact = (content) => {
  const mdContent = strictListSyntax(content);
  const hast = processor.runSync(processor.parse(mdContent));
  composerGapAlign(mdContent)(hast);
  const render = (node) => {
    if (node.type === "text") return node.value;
    if (node.type === "element") {
      if (node.tagName === "code" || node.tagName === "table") {
        const p = node.position;
        return p ? mdContent.slice(p.start.offset, p.end.offset) : "";
      }
      if (node.tagName === "li") {
        return sliceLiMarker(mdContent, node.position) + (node.children ?? []).map(render).join("");
      }
      return (node.children ?? []).map(render).join("");
    }
    return (node.children ?? []).map(render).join("");
  };
  return render(hast);
};
// 间隙 "\n  " 携带缩进 + sliceLiMarker 再含缩进 = 双计；修正后缩进只保留一份
assert.strictEqual(exact("- a\n  - b"), "• a\n  • b");
assert.strictEqual(exact("- a\n  - b\n  - c"), "• a\n  • b\n  • c");
assert.strictEqual(exact("para\n\n- a"), "para\n\n• a");
console.log("composer-md check OK");
