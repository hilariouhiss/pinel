/**
 * composer-md 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：列表标记切片规则坏掉时编译即红。
 */
import assert from "node:assert";
import { sliceLiMarker, stripLeadingNewline, supportEmptyListItems } from "./src/composer-md.ts";

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
console.log("composer-md check OK");
