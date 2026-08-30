/**
 * at-refs 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：@ 文件引用解析规则坏掉时编译即红。
 */
import assert from "node:assert";
import { parseAtRefs } from "./src/at-refs.ts";

const fileList = [
  { path: "src/a.ts" },
  { path: "src/a b.ts" },
  { path: "README.md" },
  { path: "docs/指南.md" },
];

// 反引号包裹：裸形式
assert.deepStrictEqual(parseAtRefs("看 `@src/a.ts` 这个文件", fileList), ["src/a.ts"]);
// 反引号包裹：含空格路径用引号
assert.deepStrictEqual(parseAtRefs("`@\"src/a b.ts\"`", fileList), ["src/a b.ts"]);
// 大小写不敏感，返回 fileList 原始 path
assert.deepStrictEqual(parseAtRefs("`@SRC/A.TS`", fileList), ["src/a.ts"]);
// 非 ASCII 路径
assert.deepStrictEqual(parseAtRefs("`@docs/指南.md`", fileList), ["docs/指南.md"]);

// 未包裹的 @ 提及 = 普通文本（不解析）
assert.deepStrictEqual(parseAtRefs("@src/a.ts 和 @README.md", fileList), []);
assert.deepStrictEqual(parseAtRefs("邮箱 contact@example.com 不误伤", fileList), []);

// 未命中文件列表：不返回（保留普通文本）
assert.deepStrictEqual(parseAtRefs("`@missing.ts`", fileList), []);

// 未闭合反引号：不解析
assert.deepStrictEqual(parseAtRefs("`@src/a.ts", fileList), []);

// 尾随标点剥离（在反引号内）
assert.deepStrictEqual(parseAtRefs("`@README.md,`", fileList), ["README.md"]);

// 去重保序（含空格路径用引号形式）
assert.deepStrictEqual(parseAtRefs("`@src/a.ts` `@\"src/a b.ts\"` `@SRC/A.TS`", fileList), [
  "src/a.ts",
  "src/a b.ts",
]);

// 反引号内非 @ 内容不解析
assert.deepStrictEqual(parseAtRefs("`code` and `@src/a.ts`", fileList), ["src/a.ts"]);

// 空列表 / 空文本
assert.deepStrictEqual(parseAtRefs("`@src/a.ts`", []), []);
assert.deepStrictEqual(parseAtRefs("", fileList), []);

console.log("at-refs check OK");
