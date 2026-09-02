import * as assert from "assert";
import { encodeRecord, JsonlDecoder } from "../rpc/framing";

suite("framing 单元测试", () => {
  test("单帧完整记录", () => {
    const d = new JsonlDecoder();
    const records = d.push('{"type":"agent_start"}\n');
    assert.deepStrictEqual(records, ['{"type":"agent_start"}']);
  });

  test("容忍 \\r\\n（去掉尾部 \\r）", () => {
    const d = new JsonlDecoder();
    const records = d.push('{"a":1}\r\n');
    assert.deepStrictEqual(records, ['{"a":1}']);
  });

  test("粘包拆包：半包保留在缓冲区，下次补齐后输出", () => {
    const d = new JsonlDecoder();
    assert.deepStrictEqual(d.push('{"a":'), []);
    assert.deepStrictEqual(d.push("1}\n"), ['{"a":1}']);
  });

  test("多帧同包", () => {
    const d = new JsonlDecoder();
    const records = d.push('{"a":1}\n{"b":2}\n');
    assert.deepStrictEqual(records, ['{"a":1}', '{"b":2}']);
  });

  test("U+2028 / U+2029 在 JSON 字符串内不被切分（readline 会违反此约束）", () => {
    const d = new JsonlDecoder();
    const line = JSON.stringify({ text: "a\u2028b\u2029c" });
    const records = d.push(line + "\n" + '{"x":1}\n');
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(JSON.parse(records[0]), { text: "a\u2028b\u2029c" });
    assert.deepStrictEqual(JSON.parse(records[1]), { x: 1 });
  });

  test("空行与空输入被忽略", () => {
    const d = new JsonlDecoder();
    assert.deepStrictEqual(d.push("\n\n"), []);
    assert.deepStrictEqual(d.push(""), []);
  });

  test("encodeRecord 输出 LF 结尾、无 \\r", () => {
    const frame = encodeRecord({ type: "abort" });
    assert.strictEqual(frame, '{"type":"abort"}\n');
    assert.ok(!frame.includes("\r"));
  });
});
