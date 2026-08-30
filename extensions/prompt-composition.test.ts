import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPromptPayload, registerPromptComposition } from "./prompt-composition.js";

/** 构造 systemPromptOptions（pi BuildSystemPromptOptions 形状）。 */
function options(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		cwd: "/repo",
		selectedTools: ["read", "bash"],
		promptGuidelines: ["g1", "g2", "g3"],
		skills: [{ name: "s1" }],
		contextFiles: [],
		...overrides,
	};
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";

describe("buildPromptPayload", () => {
	it("基础组成：system/counts/files（默认 kind=default）", () => {
		const payload = buildPromptPayload(options(), "BASE", "BASE") as any;
		expect(payload.v).toBe(1);
		expect(payload.system).toEqual({ chars: 4, kind: "default", preview: "BASE" });
		expect(payload.counts).toEqual({ guidelines: 3, skills: 1, tools: 2 });
		expect(payload.files).toEqual([]);
		expect(payload.finalChars).toBe(4);
		expect(payload.injected).toBeUndefined();
		expect(payload.injectedUnknown).toBeUndefined();
	});

	it("customPrompt 存在 → kind=custom，preview 取自定义文本", () => {
		const payload = buildPromptPayload(options({ customPrompt: "CUSTOM" }), "BASE+CUSTOM", "BASE+CUSTOM") as any;
		expect(payload.system.kind).toBe("custom");
		expect(payload.system.preview).toBe("CUSTOM");
	});

	it("contextFiles 按 agentDir 归类 user / project（分隔符与大小写兼容）", () => {
		const agent = process.env.PI_CODING_AGENT_DIR ?? `${HOME}/.pi/agent`.replace(/\\/g, "/");
		const payload = buildPromptPayload(
			options({
				contextFiles: [
					{ path: `${agent}/AGENT.md`.replace(/\\/g, "/"), content: "user rules" },
					{ path: "/repo/AGENTS.md", content: "project rules" },
					{ path: "/repo/../repo/CLAUDE.md", content: "claude" },
				],
			}),
			"B",
			"B",
		) as any;
		expect(payload.files).toEqual([
			{ level: "user", name: "AGENT.md", path: `${agent}/AGENT.md`.replace(/\\/g, "/"), chars: 10, preview: "user rules" },
			{ level: "project", name: "AGENTS.md", path: "/repo/AGENTS.md", chars: 13, preview: "project rules" },
			{ level: "project", name: "CLAUDE.md", path: "/repo/../repo/CLAUDE.md", chars: 6, preview: "claude" },
		]);
	});

	it("appendSystemPrompt → append 段；缺省则无该字段", () => {
		const withAppend = buildPromptPayload(options({ appendSystemPrompt: "EXTRA" }), "B", "B") as any;
		expect(withAppend.append).toEqual({ chars: 5, preview: "EXTRA" });
		const without = buildPromptPayload(options(), "B", "B") as any;
		expect(without.append).toBeUndefined();
	});

	it("前缀追加 → injected 段；无注入（相等）→ 无 injected 字段", () => {
		const injected = buildPromptPayload(options(), "BASE", "BASE\n\nPONYTAIL MODE ON") as any;
		expect(injected.injected).toEqual({
			chars: "\n\nPONYTAIL MODE ON".length,
			preview: "\n\nPONYTAIL MODE ON",
		});
		const equal = buildPromptPayload(options(), "BASE", "BASE") as any;
		expect(equal.injected).toBeUndefined();
		expect(equal.injectedUnknown).toBeUndefined();
	});

	it("替换型（final 不以 base 开头）→ injectedUnknown", () => {
		const payload = buildPromptPayload(options(), "BASE", "TOTALLY DIFFERENT") as any;
		expect(payload.injected).toBeUndefined();
		expect(payload.injectedUnknown).toBe(true);
		expect(payload.finalChars).toBe("TOTALLY DIFFERENT".length);
	});

	it("预览截断 2000 字符（省略号尾）", () => {
		const long = "x".repeat(2500);
		const payload = buildPromptPayload(options({ appendSystemPrompt: long }), "B", "B") as any;
		expect(payload.append.preview.length).toBe(2001);
		expect(payload.append.preview.endsWith("…")).toBe(true);
		expect(payload.append.chars).toBe(2500);
	});

	it("options/baseText 缺失 → null（首轮回合前不推送）", () => {
		expect(buildPromptPayload(null, "B", "B")).toBeNull();
		expect(buildPromptPayload(options(), undefined, "B")).toBeNull();
	});
});

describe("registerPromptComposition", () => {
	function makePi() {
		const handlers = new Map<string, (ev: any, ctx: any) => void>();
		const pushes: Array<{ key: string; json: string }> = [];
		const pi = {
			on: (name: string, handler: (ev: any, ctx: any) => void) => handlers.set(name, handler),
		};
		const ctx = {
			mode: "rpc",
			getSystemPrompt: () => "BASE + INJECTED",
			ui: { setStatus: (key: string, json: string) => pushes.push({ key, json }) },
		};
		return { pi, handlers, pushes, ctx };
	}

	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	it("before_agent_start 捕获 → agent_start 构造并推送 pinel.prompt；重复推送去重", () => {
		const { pi, handlers, pushes, ctx } = makePi();
		registerPromptComposition(pi as any);
		handlers.get("before_agent_start")!(
			{ systemPrompt: "BASE", systemPromptOptions: options() },
			ctx,
		);
		handlers.get("agent_start")!({}, ctx);
		expect(pushes.length).toBe(1);
		expect(pushes[0].key).toBe("pinel.prompt");
		const payload = JSON.parse(pushes[0].json);
		expect(payload.injected.preview).toBe(" + INJECTED");
		// 同组成第二轮：不重发
		handlers.get("before_agent_start")!({ systemPrompt: "BASE", systemPromptOptions: options() }, ctx);
		handlers.get("agent_start")!({}, ctx);
		expect(pushes.length).toBe(1);
		// 组成变化（注入增长）：重发
		ctx.getSystemPrompt = () => "BASE + INJECTED + MORE";
		handlers.get("agent_start")!({}, ctx);
		expect(pushes.length).toBe(2);
	});

	it("首轮前（无 before_agent_start）agent_start 不推送", () => {
		const { pi, handlers, pushes, ctx } = makePi();
		registerPromptComposition(pi as any);
		handlers.get("agent_start")!({}, ctx);
		expect(pushes.length).toBe(0);
	});

	it("非 rpc 模式事件忽略", () => {
		const { pi, handlers, pushes, ctx } = makePi();
		registerPromptComposition(pi as any);
		handlers.get("before_agent_start")!({ systemPrompt: "BASE", systemPromptOptions: options() }, { ...ctx, mode: "tui" });
		handlers.get("agent_start")!({}, { ...ctx, mode: "tui" });
		expect(pushes.length).toBe(0);
	});
});
