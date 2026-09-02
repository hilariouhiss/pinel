import * as assert from "assert";
import { parseModels, parseThinkingLevels } from "../chat/models";

suite("parseModels 单元测试", () => {
  test("合法列表：解析 id/name/provider（忽略其余字段）", () => {
    const data = {
      models: [
        { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", reasoning: true },
        { id: "fake-model-b", name: "Fake Model B", provider: "fake" },
      ],
    };
    assert.deepStrictEqual(parseModels(data), [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
      { id: "fake-model-b", name: "Fake Model B", provider: "fake" },
    ]);
  });

  test("结构不符 → 空列表", () => {
    assert.deepStrictEqual(parseModels(undefined), []);
    assert.deepStrictEqual(parseModels(null), []);
    assert.deepStrictEqual(parseModels("str"), []);
    assert.deepStrictEqual(parseModels(42), []);
    assert.deepStrictEqual(parseModels({}), []);
    assert.deepStrictEqual(parseModels({ models: "not-array" }), []);
  });

  test("部分条目损坏：跳过坏条目保留好条目", () => {
    const data = {
      models: [
        { id: "a", name: "A", provider: "p" },
        { id: "", name: "EmptyId", provider: "p" }, // 空白 id
        { name: "NoId", provider: "p" }, // 缺 id
        42, // 非对象
        { id: "b", name: "B", provider: "p" },
        { id: "c", name: 123, provider: ["p"] }, // 字段类型不符：跳过
      ],
    };
    assert.deepStrictEqual(parseModels(data), [
      { id: "a", name: "A", provider: "p" },
      { id: "b", name: "B", provider: "p" },
    ]);
  });
});

suite("parseThinkingLevels 单元测试", () => {
  test("合法列表：逐项保留", () => {
    const data = { levels: ["off", "minimal", "low", "medium", "high"] };
    assert.deepStrictEqual(parseThinkingLevels(data), ["off", "minimal", "low", "medium", "high"]);
  });

  test("不支持思考的模型：[\"off\"] 原样解析", () => {
    assert.deepStrictEqual(parseThinkingLevels({ levels: ["off"] }), ["off"]);
  });

  test("结构不符 → 空列表", () => {
    assert.deepStrictEqual(parseThinkingLevels(undefined), []);
    assert.deepStrictEqual(parseThinkingLevels(null), []);
    assert.deepStrictEqual(parseThinkingLevels("str"), []);
    assert.deepStrictEqual(parseThinkingLevels({}), []);
    assert.deepStrictEqual(parseThinkingLevels({ levels: "not-array" }), []);
  });

  test("部分条目损坏：跳过非字符串/空白项", () => {
    const data = { levels: ["off", "", 42, null, "high"] };
    assert.deepStrictEqual(parseThinkingLevels(data), ["off", "high"]);
  });
});
