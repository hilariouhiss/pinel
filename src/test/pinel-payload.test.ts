import assert from "node:assert";
import { describe, it } from "mocha";
import { parsePinelState, parsePinelTree } from "../chat/pinel-payload";

describe("pinel-payload 防御解析", () => {
  describe("parsePinelState", () => {
    it("解析完整快照", () => {
      const parsed = parsePinelState(
        JSON.stringify({
          v: 1,
          messages: { user: 2, assistant: 3, toolResult: 1, total: 6 },
          model: "deepseek/deepseek-v4-pro",
          thinkingLevel: "max",
          leafId: "abc",
          sessionFile: "/tmp/s.jsonl",
        }),
      );
      assert.ok(parsed);
      assert.deepStrictEqual(parsed.messages, { user: 2, assistant: 3, toolResult: 1, total: 6 });
      assert.strictEqual(parsed.model, "deepseek/deepseek-v4-pro");
      assert.strictEqual(parsed.thinkingLevel, "max");
      assert.strictEqual(parsed.leafId, "abc");
      assert.strictEqual(parsed.sessionFile, "/tmp/s.jsonl");
    });

    it("非 JSON / 非对象 / 版本不符 → null", () => {
      assert.strictEqual(parsePinelState("not-json"), null);
      assert.strictEqual(parsePinelState(undefined), null);
      assert.strictEqual(parsePinelState(JSON.stringify([1, 2])), null);
      assert.strictEqual(parsePinelState(JSON.stringify({ v: 2, messages: {} })), null);
    });

    it("messages 缺失/非对象 → null（核心字段缺一不产出）", () => {
      assert.strictEqual(parsePinelState(JSON.stringify({ v: 1 })), null);
      assert.strictEqual(parsePinelState(JSON.stringify({ v: 1, messages: "x" })), null);
    });

    it("计数容缺：非法值按 0，可选字段缺省省略", () => {
      const parsed = parsePinelState(
        JSON.stringify({ v: 1, messages: { user: "x", assistant: -1, toolResult: 1.5, total: null } }),
      );
      assert.ok(parsed);
      assert.deepStrictEqual(parsed.messages, { user: 0, assistant: 0, toolResult: 0, total: 0 });
      assert.strictEqual(parsed.model, undefined);
      assert.strictEqual(parsed.thinkingLevel, undefined);
    });
  });

  describe("parsePinelTree", () => {
    it("解析完整树（widgetLines 数组取首元素）", () => {
      const parsed = parsePinelTree([
        JSON.stringify({
          v: 1,
          nodes: [
            { entryId: "e1", role: "user", text: "hello", timestamp: 123 },
            { entryId: "e2", role: "assistant", text: "hi" },
          ],
          leafId: "e2",
        }),
      ]);
      assert.ok(parsed);
      assert.strictEqual(parsed.leafId, "e2");
      assert.strictEqual(parsed.nodes.length, 2);
      assert.deepStrictEqual(parsed.nodes[0], { entryId: "e1", role: "user", text: "hello", timestamp: 123 });
      assert.deepStrictEqual(parsed.nodes[1], { entryId: "e2", role: "assistant", text: "hi" });
    });

    it("节点容缺：缺 entryId/role/text 逐条跳过，不拖垮整树", () => {
      const parsed = parsePinelTree(
        JSON.stringify({
          v: 1,
          nodes: [
            { role: "user", text: "no id" },
            { entryId: "e2", role: "tool", text: "bad role" },
            { entryId: "e3", role: "user", text: "" },
            { entryId: "e4", role: "assistant", text: "ok" },
            "garbage",
          ],
        }),
      );
      assert.ok(parsed);
      assert.deepStrictEqual(
        parsed.nodes.map((n) => n.entryId),
        ["e4"],
      );
    });

    it("非 JSON / 版本不符 / 非数组输入 → null", () => {
      assert.strictEqual(parsePinelTree("nope"), null);
      assert.strictEqual(parsePinelTree([JSON.stringify({ v: 2, nodes: [] })]), null);
      assert.strictEqual(parsePinelTree([]), null);
      assert.strictEqual(parsePinelTree(undefined), null);
    });
  });
});
