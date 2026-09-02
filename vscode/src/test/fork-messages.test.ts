import * as assert from "assert";
import { parseForkMessages } from "../chat/fork-messages";

suite("parseForkMessages 单元测试", () => {
  test("合法列表：解析 entryId/text（忽略多余字段）", () => {
    const data = {
      messages: [
        { entryId: "abc123", text: "第一条 prompt" },
        { entryId: "def456", text: "第二条 prompt", extra: { unused: true } },
      ],
    };
    assert.deepStrictEqual(parseForkMessages(data), [
      { entryId: "abc123", text: "第一条 prompt" },
      { entryId: "def456", text: "第二条 prompt" },
    ]);
  });

  test("空列表：原样返回空数组", () => {
    assert.deepStrictEqual(parseForkMessages({ messages: [] }), []);
  });

  test("结构不符 → 空列表", () => {
    assert.deepStrictEqual(parseForkMessages(undefined), []);
    assert.deepStrictEqual(parseForkMessages(null), []);
    assert.deepStrictEqual(parseForkMessages("str"), []);
    assert.deepStrictEqual(parseForkMessages(42), []);
    assert.deepStrictEqual(parseForkMessages({}), []);
    assert.deepStrictEqual(parseForkMessages({ messages: "not-array" }), []);
  });

  test("部分条目损坏：跳过坏条目保留好条目", () => {
    const data = {
      messages: [
        { entryId: "abc123", text: "好的" },
        { entryId: "", text: "空 entryId" }, // 空 entryId
        { text: "缺 entryId" }, // 缺 entryId
        { entryId: "ghi789", text: "" }, // 空 text
        { entryId: "jkl012", text: 42 }, // text 类型不符
        42, // 非对象
        { entryId: "mno345", text: "第二个好的" },
      ],
    };
    assert.deepStrictEqual(parseForkMessages(data), [
      { entryId: "abc123", text: "好的" },
      { entryId: "mno345", text: "第二个好的" },
    ]);
  });
});
