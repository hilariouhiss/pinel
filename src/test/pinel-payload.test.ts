import assert from "node:assert";
import { describe, it } from "mocha";
import { parsePinelState, parsePinelTree, parsePinelWorkflow } from "../chat/pinel-payload";

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

  describe("parsePinelWorkflow", () => {
    it("解析运行中阶段推送（含 stage/stageNumber）", () => {
      const parsed = parsePinelWorkflow(
        JSON.stringify({
          v: 1,
          runId: "run-1",
          workflow: "sp-build",
          totalStages: 5,
          status: "running",
          stage: "implement",
          stageNumber: 2,
        }),
      );
      assert.ok(parsed);
      assert.strictEqual(parsed.runId, "run-1");
      assert.strictEqual(parsed.workflow, "sp-build");
      assert.strictEqual(parsed.totalStages, 5);
      assert.strictEqual(parsed.status, "running");
      assert.strictEqual(parsed.stage, "implement");
      assert.strictEqual(parsed.stageNumber, 2);
      assert.strictEqual(parsed.message, undefined);
    });

    it("解析终态：done（最小字段）与 failed（含 message）", () => {
      const done = parsePinelWorkflow(
        JSON.stringify({ v: 1, runId: "r", workflow: "sp-fix", totalStages: 0, status: "done" }),
      );
      assert.ok(done);
      assert.strictEqual(done.status, "done");
      assert.strictEqual(done.totalStages, 0);

      const failed = parsePinelWorkflow(
        JSON.stringify({
          v: 1,
          runId: "r2",
          workflow: "sp-review",
          totalStages: 3,
          status: "failed",
          stage: "review",
          message: "boom",
        }),
      );
      assert.ok(failed);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.message, "boom");
      assert.strictEqual(failed.stage, "review");
    });

    it("awaiting-approval 状态合法", () => {
      const parsed = parsePinelWorkflow(
        JSON.stringify({
          v: 1,
          runId: "r3",
          workflow: "sp-build",
          totalStages: 4,
          status: "awaiting-approval",
          stage: "gate-2",
          stageNumber: 3,
        }),
      );
      assert.ok(parsed);
      assert.strictEqual(parsed.status, "awaiting-approval");
    });

    it("非法 status / 缺 runId/workflow / 非 JSON / 空数组（widget 清空）→ null", () => {
      assert.strictEqual(
        parsePinelWorkflow(JSON.stringify({ v: 1, runId: "r", workflow: "w", totalStages: 1, status: "paused" })),
        null,
      );
      assert.strictEqual(
        parsePinelWorkflow(JSON.stringify({ v: 1, workflow: "w", totalStages: 1, status: "done" })),
        null,
      );
      assert.strictEqual(
        parsePinelWorkflow(JSON.stringify({ v: 1, runId: "", workflow: "w", totalStages: 1, status: "done" })),
        null,
      );
      assert.strictEqual(parsePinelWorkflow("nope"), null);
      assert.strictEqual(parsePinelWorkflow(JSON.stringify({ v: 2, runId: "r", workflow: "w", status: "done" })), null);
      assert.strictEqual(parsePinelWorkflow([]), null);
      assert.strictEqual(parsePinelWorkflow(undefined), null);
    });

    it("容缺字段：stageNumber 非整数 / totalStages 非法 → 丢弃该字段不整帧失败", () => {
      const parsed = parsePinelWorkflow(
        JSON.stringify({
          v: 1,
          runId: "r4",
          workflow: "sp-build",
          totalStages: "many",
          status: "running",
          stage: "plan",
          stageNumber: 1.5,
          message: 42,
        }),
      );
      assert.ok(parsed);
      assert.strictEqual(parsed.totalStages, 0);
      assert.strictEqual(parsed.stage, "plan");
      assert.strictEqual(parsed.stageNumber, undefined);
      assert.strictEqual(parsed.message, undefined);
    });
  });
});
