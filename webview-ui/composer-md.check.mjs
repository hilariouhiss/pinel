/**
 * composer-md 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：列表标记切片规则坏掉时编译即红。
 */
import assert from "node:assert";
import { sliceLiMarker, stripLeadingNewline } from "./src/composer-md.ts";

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
// 缩进（嵌套 li 行首空格）：标记不含缩进（缩进由块间空白文本节点承载）
assert.strictEqual(sliceLiMarker("  - a", pos(2, 5)), "• ");
// 多行条目：只取首行标记
assert.strictEqual(sliceLiMarker("1. a\n   b", pos(0, 8)), "1. ");
// position 缺失 / 无 offset：退回 •
assert.strictEqual(sliceLiMarker("x", null), "• ");
assert.strictEqual(sliceLiMarker("x", { start: {}, end: {} }), "• ");

// 块容器合成换行剥离：首子为 "\n" 时去掉（ol/ul/li/blockquote 对齐修复）
assert.deepStrictEqual(stripLeadingNewline(["\n", "a", "\n"]), ["a", "\n"]);
// 首子非换行：原样返回（紧凑 li / 内容开头的文本）
assert.deepStrictEqual(stripLeadingNewline(["a", "\n", "b"]), ["a", "\n", "b"]);
// 非数组（单文本子）原样返回
assert.strictEqual(stripLeadingNewline("abc"), "abc");
// 空数组原样返回
assert.deepStrictEqual(stripLeadingNewline([]), []);
console.log("composer-md check OK");
