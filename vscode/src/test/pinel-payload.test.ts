import assert from "node:assert";
import { describe, it } from "mocha";
import { parsePinelWorkflow, parsePonytailStatus, parseMcpStatus, parsePinelMcp, parsePinelPrompt } from "../chat/pinel-payload";

describe("pinel-payload 防御解析", () => {
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

  describe("parsePonytailStatus", () => {
    it("ANSI 装饰的实心点激活帧 → active + full", () => {
      const parsed = parsePonytailStatus("\u001b[36m●\u001b[0m 🐴 \u001b[2mponytail: \u001b[0m\u001b[39m⚡ FULL\u001b[0m");
      assert.deepStrictEqual(parsed, { active: true, mode: "full" });
    });

    it("空心点空闲帧 → inactive + lite", () => {
      const parsed = parsePonytailStatus("○ 🐴 ponytail: 🌿 LITE");
      assert.deepStrictEqual(parsed, { active: false, mode: "lite" });
    });

    it("空文本（mode off 清除指示器）→ off", () => {
      const parsed = parsePonytailStatus("");
      assert.deepStrictEqual(parsed, { active: false, mode: "off" });
    });

    it("形状不符（无档位单词/非字符串/超极档位）→ null", () => {
      assert.strictEqual(parsePonytailStatus("loaded"), null);
      assert.strictEqual(parsePonytailStatus("● 🐴 ponytail: ⚡"), null);
      assert.strictEqual(parsePonytailStatus(42), null);
      assert.strictEqual(parsePonytailStatus(undefined), null);
    });
  });

  describe("parseMcpStatus", () => {
    it("解析 full 模式：N servers enabled (C connected) (D disabled)", () => {
      assert.deepStrictEqual(parseMcpStatus("🔌 MCP: 3 servers enabled (2 connected) (1 disabled)"), {
        state: "ready", enabled: 3, connected: 2, disabled: 1,
      });
    });

    it("full 模式单数 + 括号段缺席 + 无图标前缀", () => {
      assert.deepStrictEqual(parseMcpStatus("MCP: 1 server enabled"), {
        state: "ready", enabled: 1, connected: 0,
      });
    });

    it("解析 compact 模式 MCP C/N", () => {
      assert.deepStrictEqual(parseMcpStatus("MCP 2/3"), {
        state: "ready", enabled: 3, connected: 2,
      });
    });

    it("解析 connecting 状态（含 ANSI 色码）", () => {
      assert.deepStrictEqual(parseMcpStatus("\u001b[36m🔌 MCP: connecting to 3 servers...\u001b[0m"), {
        state: "connecting", enabled: 3, connected: 0,
      });
    });

    it("空文本 = 清除信号（enabled 0）", () => {
      assert.deepStrictEqual(parseMcpStatus(""), { state: "ready", enabled: 0, connected: 0 });
      assert.deepStrictEqual(parseMcpStatus(undefined), { state: "ready", enabled: 0, connected: 0 });
    });

    it("未知形状返回 null（整帧忽略）", () => {
      assert.strictEqual(parseMcpStatus("hello world"), null);
      assert.strictEqual(parseMcpStatus("MCP: weird"), null);
      assert.strictEqual(parseMcpStatus(42), null);
    });
  });

  describe("parsePinelMcp", () => {
    it("解析完整服务器列表（状态/scope/工具数/禁用位）", () => {
      const parsed = parsePinelMcp(
        JSON.stringify({
          v: 1,
          servers: [
            { name: "github", status: "connected", scope: "global", toolCount: 12 },
            { name: "local", status: "failed", scope: "project" },
            { name: "legacy", status: "disabled", scope: "project", disabled: true },
            { name: "mystery", status: "unknown", scope: "global" },
          ],
        }),
      );
      assert.ok(parsed);
      assert.deepStrictEqual(parsed.servers, [
        { name: "github", status: "connected", scope: "global", toolCount: 12 },
        { name: "local", status: "failed", scope: "project" },
        { name: "legacy", status: "disabled", scope: "project", disabled: true },
        { name: "mystery", status: "unknown", scope: "global" },
      ]);
    });

    it("逐行容缺：非法行丢弃，好行保留；空列表合法", () => {
      const parsed = parsePinelMcp(
        JSON.stringify({
          v: 1,
          servers: [
            { name: "ok", status: "connected", scope: "global" },
            { status: "connected", scope: "global" }, // 缺名
            { name: "", status: "connected", scope: "global" }, // 空名
            { name: "bad-status", status: "weird", scope: "global" }, // 非法状态
            { name: "bad-scope", status: "connected", scope: "local" }, // 非法 scope
            "garbage",
            null,
          ],
        }),
      );
      assert.ok(parsed);
      assert.deepStrictEqual(parsed.servers, [{ name: "ok", status: "connected", scope: "global" }]);
      const empty = parsePinelMcp(JSON.stringify({ v: 1, servers: [] }));
      assert.ok(empty);
      assert.deepStrictEqual(empty.servers, []);
    });

    it("非 JSON / 非对象 / 版本不符 / servers 缺失 → null", () => {
      assert.strictEqual(parsePinelMcp("not-json"), null);
      assert.strictEqual(parsePinelMcp(undefined), null);
      assert.strictEqual(parsePinelMcp(JSON.stringify({ v: 2, servers: [] })), null);
      assert.strictEqual(parsePinelMcp(JSON.stringify({ v: 1, servers: "x" })), null);
      assert.strictEqual(parsePinelMcp(JSON.stringify({ v: 1 })), null);
    });
  });

  describe("parsePinelPrompt", () => {
    const full = JSON.stringify({
      v: 1,
      system: { chars: 100, kind: "default", preview: "BASE" },
      files: [
        { level: "user", name: "AGENT.md", path: "/home/u/.pi/agent/AGENT.md", chars: 10, preview: "user rules" },
        { level: "project", name: "AGENTS.md", path: "/repo/AGENTS.md", chars: 20, preview: "project rules" },
      ],
      append: { chars: 5, preview: "EXTRA" },
      counts: { guidelines: 3, skills: 1, tools: 2 },
      injected: { chars: 7, preview: "INJECT!" },
      finalChars: 107,
    });

    it("全字段解析", () => {
      const parsed = parsePinelPrompt(full)!;
      assert.strictEqual(parsed.system!.kind, "default");
      assert.strictEqual(parsed.system!.chars, 100);
      assert.strictEqual(parsed.files.length, 2);
      assert.strictEqual(parsed.files[0].level, "user");
      assert.strictEqual(parsed.files[1].name, "AGENTS.md");
      assert.deepStrictEqual(parsed.counts, { guidelines: 3, skills: 1, tools: 2 });
      assert.deepStrictEqual(parsed.append, { chars: 5, preview: "EXTRA" });
      assert.deepStrictEqual(parsed.injected, { chars: 7, preview: "INJECT!" });
      assert.strictEqual(parsed.finalChars, 107);
      assert.strictEqual(parsed.injectedUnknown, undefined);
    });

    it("injectedUnknown=true（替换型）；injected 0 字符丢弃", () => {
      const unknown = parsePinelPrompt(
        JSON.stringify({
          v: 1,
          system: { chars: 1, kind: "default", preview: "B" },
          files: [],
          counts: { guidelines: 0, skills: 0, tools: 0 },
          injectedUnknown: true,
          finalChars: 99,
        }),
      )!;
      assert.strictEqual(unknown.injectedUnknown, true);
      assert.strictEqual(unknown.injected, undefined);
      const zero = parsePinelPrompt(
        JSON.stringify({
          v: 1,
          system: { chars: 1, kind: "default", preview: "B" },
          files: [],
          counts: { guidelines: 0, skills: 0, tools: 0 },
          injected: { chars: 0, preview: "" },
          finalChars: 1,
        }),
      )!;
      assert.strictEqual(zero.injected, undefined);
    });

    it("坏条目容缺：files 坏项跳过、可选段缺席容忍", () => {
      const parsed = parsePinelPrompt(
        JSON.stringify({
          v: 1,
          system: { chars: 1, kind: "custom", preview: "C" },
          files: [
            { level: "wrong", name: "x", path: "/x", chars: 1, preview: "x" },
            { level: "project", name: "ok.md", path: "/ok.md", chars: 2, preview: "ok" },
            { level: "user", name: "", path: "/n", chars: 1, preview: "n" },
          ],
          counts: { guidelines: 0, skills: 0, tools: 0 },
          finalChars: 1,
        }),
      )!;
      assert.strictEqual(parsed.files.length, 1);
      assert.strictEqual(parsed.files[0].name, "ok.md");
      assert.strictEqual(parsed.append, undefined);
    });

    it("核心字段缺失/非法 → null（整帧丢弃）", () => {
      assert.strictEqual(parsePinelPrompt("not json"), null);
      assert.strictEqual(parsePinelPrompt("[]"), null);
      assert.strictEqual(parsePinelPrompt(JSON.stringify({ v: 2, system: {} })), null);
      assert.strictEqual(
        parsePinelPrompt(
          JSON.stringify({ v: 1, system: { chars: 1, kind: "weird", preview: "x" }, counts: {}, finalChars: 1 }),
        ),
        null,
      );
      assert.strictEqual(
        parsePinelPrompt(
          JSON.stringify({ v: 1, system: { chars: -1, kind: "default", preview: "x" }, counts: {}, finalChars: 1 }),
        ),
        null,
      );
      assert.strictEqual(
        parsePinelPrompt(
          JSON.stringify({ v: 1, system: { chars: 1, kind: "default", preview: "x" }, counts: {}, finalChars: -5 }),
        ),
        null,
      );
      assert.strictEqual(parsePinelPrompt(undefined), null);
    });
  });
});
