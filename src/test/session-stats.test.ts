import * as assert from "assert";
import { parseSessionStats } from "../chat/session-stats";

suite("parseSessionStats 防御解析", () => {
  function fullStats(): Record<string, unknown> {
    return {
      sessionFile: "/fake/session.jsonl",
      sessionId: "fake-id",
      userMessages: 3,
      assistantMessages: 4,
      toolCalls: 7,
      toolResults: 7,
      totalMessages: 21,
      tokens: { input: 5000, output: 1000, cacheRead: 4000, cacheWrite: 500, total: 10500 },
      cost: 0.45,
      contextUsage: { tokens: 6000, contextWindow: 20000, percent: 30 },
    };
  }

  test("全量合法：tokens 五项 + cost + contextUsage + 消息计数", () => {
    const stats = parseSessionStats(fullStats());
    assert.ok(stats);
    assert.deepStrictEqual(stats!.tokens, { input: 5000, output: 1000, cacheRead: 4000, cacheWrite: 500, total: 10500 });
    assert.strictEqual(stats!.cost, 0.45);
    assert.deepStrictEqual(stats!.contextUsage, { tokens: 6000, contextWindow: 20000, percent: 30 });
    assert.strictEqual(stats!.userMessages, 3);
    assert.strictEqual(stats!.toolCalls, 7);
    assert.strictEqual(stats!.sessionFile, "/fake/session.jsonl");
  });

  test("data 非对象 / tokens 缺失或非对象 → null", () => {
    assert.strictEqual(parseSessionStats(null), null);
    assert.strictEqual(parseSessionStats("x"), null);
    assert.strictEqual(parseSessionStats({}), null);
    assert.strictEqual(parseSessionStats({ tokens: "x" }), null);
  });

  test("tokens 核心四项缺一 → null（统计不完整不产出部分数据）", () => {
    const bad = fullStats();
    delete (bad.tokens as Record<string, unknown>).cacheRead;
    assert.strictEqual(parseSessionStats(bad), null);
    const nan = fullStats();
    (nan.tokens as Record<string, unknown>).output = "x";
    assert.strictEqual(parseSessionStats(nan), null);
  });

  test("tokens.total 缺省/无效 → 按四值之和补齐", () => {
    const stats = parseSessionStats({
      tokens: { input: 5000, output: 1000, cacheRead: 4000, cacheWrite: 500 },
    });
    assert.ok(stats);
    assert.strictEqual(stats!.tokens.total, 10500);
  });

  test("contextUsage 缺省（无模型/旧版 pi）→ 字段不产出", () => {
    const stats = parseSessionStats({ tokens: fullStats().tokens });
    assert.ok(stats);
    assert.strictEqual(stats!.contextUsage, undefined);
  });

  test("contextUsage tokens/percent 为 null（压缩后无新响应）→ 原样保留", () => {
    const stats = parseSessionStats({
      tokens: fullStats().tokens,
      contextUsage: { tokens: null, contextWindow: 20000, percent: null },
    });
    assert.ok(stats);
    assert.deepStrictEqual(stats!.contextUsage, { tokens: null, contextWindow: 20000, percent: null });
  });

  test("contextUsage contextWindow 无效 → 整个 contextUsage 丢弃", () => {
    const stats = parseSessionStats({
      tokens: fullStats().tokens,
      contextUsage: { tokens: 6000, contextWindow: "x", percent: 30 },
    });
    assert.ok(stats);
    assert.strictEqual(stats!.contextUsage, undefined);
  });

  test("cost 为 0 是合法值（保留）；非数字忽略", () => {
    const zero = parseSessionStats({ tokens: fullStats().tokens, cost: 0 });
    assert.ok(zero);
    assert.strictEqual(zero!.cost, 0);
    const bad = parseSessionStats({ tokens: fullStats().tokens, cost: "x" });
    assert.ok(bad);
    assert.strictEqual(bad!.cost, undefined);
  });

  test("部分字段损坏：消息计数非数字忽略，不拖垮整体", () => {
    const stats = parseSessionStats({
      tokens: fullStats().tokens,
      userMessages: "x",
      assistantMessages: 4,
    });
    assert.ok(stats);
    assert.strictEqual(stats!.userMessages, undefined);
    assert.strictEqual(stats!.assistantMessages, 4);
  });
});
