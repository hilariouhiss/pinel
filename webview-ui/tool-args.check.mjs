/**
 * tool-args 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：工具 args 直读化规则坏掉时编译即红。
 */
import assert from "node:assert";
import { describeToolArgs } from "./src/tool-args.ts";

// command 类：直取命令文本
assert.strictEqual(
  describeToolArgs('{"command":"npm test","timeout":60}'),
  "npm test",
  "bash 类取 command",
);

// query 类：直取检索词
assert.strictEqual(
  describeToolArgs('{"query":"react vs vue","numResults":5}'),
  "react vs vue",
  "检索类取 query",
);

// url 类
assert.strictEqual(
  describeToolArgs('{"url":"https://example.com/a.md"}'),
  "https://example.com/a.md",
  "取链类取 url",
);

// read：仅 path
assert.strictEqual(
  describeToolArgs('{"path":"src/a.ts"}'),
  "src/a.ts",
  "read 取 path",
);

// write：path + content
assert.strictEqual(
  describeToolArgs('{"path":"a.ts","content":"export const x = 1;"}'),
  "a.ts\n\nexport const x = 1;",
  "write 取 path+content",
);

// edit：path + edits[].newText
assert.strictEqual(
  describeToolArgs('{"path":"a.ts","edits":[{"oldText":"a","newText":"b"}]}'),
  "a.ts\n\nb",
  "edit 取 path+newText",
);

// 无惯例字段：回退 pretty JSON
assert.strictEqual(
  describeToolArgs('{"action":"update","id":1}'),
  '{\n  "action": "update",\n  "id": 1\n}',
  "无命中回退 pretty JSON",
);

// 非 JSON（流式半截）/ 非对象：原样返回
assert.strictEqual(describeToolArgs('{"command":"ec'), '{"command":"ec', "非 JSON 原样");
assert.strictEqual(describeToolArgs("[1,2,3]"), "[1,2,3]", "数组原样");
assert.strictEqual(describeToolArgs(""), "", "空串回空");

console.log("tool-args check OK");
