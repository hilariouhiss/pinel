/**
 * pinel-payload 自检：守卫 pinel.prompt 解析器——启动帧宽松分支 + 全帧严格分支。
 * 挂入 npm run compile 门：解析器被改坏时编译即红。
 */
import assert from "node:assert";
import { parsePinelPrompt } from "./pinel-payload.ts";

const FULL = {
  v: 1,
  system: { chars: 4, kind: "default", preview: "BASE" },
  files: [{ level: "project", name: "AGENTS.md", path: "/repo/AGENTS.md", chars: 5, preview: "PROJ" }],
  counts: { guidelines: 0, skills: 1, tools: 2 },
  finalChars: 10,
};

// 全帧严格分支：完整载荷通过，system/counts/finalChars 缺一即丢
assert.ok(parsePinelPrompt(JSON.stringify(FULL)), "全帧必须通过");
assert.strictEqual(parsePinelPrompt(JSON.stringify({ ...FULL, counts: undefined })), null, "全帧缺 counts 必须丢弃");
assert.strictEqual(parsePinelPrompt(JSON.stringify({ ...FULL, finalChars: undefined })), null, "全帧缺 finalChars 必须丢弃");

// 启动帧宽松分支：仅 v/files 必需
const startup = parsePinelPrompt(JSON.stringify({ v: 1, startup: true, files: FULL.files }));
assert.ok(startup, "启动帧必须通过");
assert.strictEqual(startup.startup, true);
assert.strictEqual(startup.files.length, 1);
assert.strictEqual(startup.system, undefined);
assert.strictEqual(startup.counts, undefined);
assert.strictEqual(startup.finalChars, undefined);
assert.strictEqual(parsePinelPrompt(JSON.stringify({ v: 1, startup: true })), null, "启动帧无 files 数组必须丢弃");
assert.strictEqual(parsePinelPrompt(JSON.stringify({ v: 1, startup: true, files: "x" })), null, "启动帧 files 非数组必须丢弃");

// 恶意/畸形帧仍拒绝
assert.strictEqual(parsePinelPrompt("{nope"), null, "畸形 JSON 必须丢弃");
assert.strictEqual(parsePinelPrompt(JSON.stringify({ v: 2 })), null, "版本不符必须丢弃");

console.log("pinel-payload check OK");
