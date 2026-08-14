import * as assert from "assert";
import { parseCommands } from "../chat/commands";

suite("parseCommands 单元测试", () => {
  test("合法列表：解析 name/description/source（忽略 sourceInfo 等多余字段）", () => {
    const data = {
      commands: [
        { name: "fix", description: "修复测试失败", source: "prompt", sourceInfo: { path: "/x/fix.md" } },
        { name: "skill:ctx-search", description: "检索本地索引", source: "skill", sourceInfo: {} },
        { name: "session-name", source: "extension", sourceInfo: {} },
      ],
    };
    assert.deepStrictEqual(parseCommands(data), [
      { name: "fix", description: "修复测试失败", source: "prompt" },
      { name: "skill:ctx-search", description: "检索本地索引", source: "skill" },
      { name: "session-name", source: "extension" },
    ]);
  });

  test("结构不符 → 空列表", () => {
    assert.deepStrictEqual(parseCommands(undefined), []);
    assert.deepStrictEqual(parseCommands(null), []);
    assert.deepStrictEqual(parseCommands("str"), []);
    assert.deepStrictEqual(parseCommands(42), []);
    assert.deepStrictEqual(parseCommands({}), []);
    assert.deepStrictEqual(parseCommands({ commands: "not-array" }), []);
  });

  test("部分条目损坏：跳过坏条目保留好条目", () => {
    const data = {
      commands: [
        { name: "fix", source: "prompt" },
        { name: "", source: "prompt" }, // 空白名
        { description: "无名字", source: "prompt" }, // 缺 name
        42, // 非对象
        { name: "plan", source: "prompt" },
        { name: "bad-desc", description: 123, source: ["prompt"] }, // 字段类型不符：忽略该字段
      ],
    };
    assert.deepStrictEqual(parseCommands(data), [
      { name: "fix", source: "prompt" },
      { name: "plan", source: "prompt" },
      { name: "bad-desc" },
    ]);
  });

  test("未知 source 值：原样保留为 string（webview 有兜底徽标，pi 未来新增来源不破坏运行时）", () => {
    const data = { commands: [{ name: "future", source: "builtin" }] };
    assert.deepStrictEqual(parseCommands(data), [{ name: "future", source: "builtin" }]);
  });
});
