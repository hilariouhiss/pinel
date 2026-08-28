import * as assert from "assert";
import { applySubagentDetails, buildSubagentCard } from "../chat/subagents";

suite("subagent 卡片解析单元测试", () => {
  suite("buildSubagentCard", () => {
    test("全量合法 args：解析 description/subagent_type/model/thinking", () => {
      const card = buildSubagentCard({
        description: "Exploring auth flow",
        prompt: "Find the auth flow",
        subagent_type: "Explore",
        model: "haiku",
        thinking: "high",
      });
      assert.deepStrictEqual(card, {
        description: "Exploring auth flow",
        subagentType: "Explore",
        model: "haiku",
        thinking: "high",
        status: "running",
        activity: null,
        turnCount: null,
        toolUses: null,
        tokens: null,
        durationMs: null,
      });
    });

    test("args 缺失/损坏 → 全字段兜底（description 'Subagent'、model/thinking null=继承）", () => {
      assert.deepStrictEqual(buildSubagentCard(undefined).description, "Subagent");
      assert.strictEqual(buildSubagentCard("str").model, null);
      assert.strictEqual(buildSubagentCard(null).thinking, null);
      assert.strictEqual(buildSubagentCard({ description: 42 }).description, "Subagent");
      assert.strictEqual(buildSubagentCard({ description: "  " }).description, "Subagent");
      assert.strictEqual(buildSubagentCard({}).subagentType, null);
    });

    test("camelCase subagentType 兜底识别", () => {
      assert.strictEqual(buildSubagentCard({ subagentType: "Plan" }).subagentType, "Plan");
    });
  });

  suite("applySubagentDetails", () => {
    test("全量合法 details：modelName/tags(thinking)/activity/统计/终态全合并", () => {
      const card = buildSubagentCard({ description: "D", subagent_type: "Explore" });
      applySubagentDetails(card, {
        displayName: "Explore",
        description: "D",
        subagentType: "Explore",
        modelName: "haiku",
        tags: ["thinking: high", "inherit context"],
        status: "completed",
        activity: "reading src/auth.ts",
        turnCount: 5,
        toolUses: 3,
        tokens: "12.3k",
        durationMs: 4200,
      });
      assert.strictEqual(card.model, "haiku");
      assert.strictEqual(card.thinking, "high");
      assert.strictEqual(card.status, "completed");
      assert.strictEqual(card.activity, "reading src/auth.ts");
      assert.strictEqual(card.turnCount, 5);
      assert.strictEqual(card.toolUses, 3);
      assert.strictEqual(card.tokens, "12.3k");
      assert.strictEqual(card.durationMs, 4200);
    });

    test("details 优先于 args：model/thinking 被解析值覆盖", () => {
      const card = buildSubagentCard({ description: "D", model: "args-model", thinking: "low" });
      applySubagentDetails(card, { modelName: "sonnet", tags: ["thinking: max"] });
      assert.strictEqual(card.model, "sonnet");
      assert.strictEqual(card.thinking, "max");
    });

    test("继承场景：modelName/tags 缺失 → 保留 null（webview 显示 main 文案）", () => {
      const card = buildSubagentCard({ description: "D" });
      applySubagentDetails(card, { status: "completed", turnCount: 2, toolUses: 0, tokens: "" });
      assert.strictEqual(card.model, null);
      assert.strictEqual(card.thinking, null);
      assert.strictEqual(card.status, "completed");
    });

    test("部分损坏：坏类型字段跳过，好字段照常合并", () => {
      const card = buildSubagentCard({ description: "D" });
      applySubagentDetails(card, {
        modelName: 42,
        tags: "not-array",
        status: "garbage-status",
        turnCount: "5",
        toolUses: NaN,
        durationMs: Infinity,
        activity: 7,
        tokens: 1.5,
      });
      assert.strictEqual(card.model, null);
      assert.strictEqual(card.thinking, null);
      assert.strictEqual(card.turnCount, null);
      assert.strictEqual(card.toolUses, null);
      assert.strictEqual(card.durationMs, null);
      assert.strictEqual(card.activity, null);
      assert.strictEqual(card.tokens, null);
      // 未知 status 不覆盖 running
      assert.strictEqual(card.status, "running");
    });

    test("status 映射：completed/steered→completed、stopped/aborted→stopped、background→background", () => {
      const mk = (raw: string) => {
        const c = buildSubagentCard({ description: "D" });
        applySubagentDetails(c, { status: raw });
        return c.status;
      };
      assert.strictEqual(mk("steered"), "completed");
      assert.strictEqual(mk("aborted"), "stopped");
      assert.strictEqual(mk("background"), "background");
      assert.strictEqual(mk("queued"), "running");
    });

    test("isError=true 强制 error，优先于 details.status", () => {
      const card = buildSubagentCard({ description: "D" });
      applySubagentDetails(card, { status: "completed", modelName: "haiku" }, true);
      assert.strictEqual(card.status, "error");
      assert.strictEqual(card.model, "haiku");
    });

    test("details 非对象 → 不做任何修改", () => {
      const card = buildSubagentCard({ description: "D" });
      applySubagentDetails(card, undefined);
      applySubagentDetails(card, "oops");
      applySubagentDetails(card, null);
      assert.strictEqual(card.status, "running");
      assert.strictEqual(card.description, "D");
    });

    test("args 缺 description 时从 details 补", () => {
      const card = buildSubagentCard(undefined);
      applySubagentDetails(card, { description: "Filled from details" });
      assert.strictEqual(card.description, "Filled from details");
      assert.strictEqual(card.subagentType, null);
      applySubagentDetails(card, { subagentType: "Plan" });
      assert.strictEqual(card.subagentType, "Plan");
    });
  });
});
