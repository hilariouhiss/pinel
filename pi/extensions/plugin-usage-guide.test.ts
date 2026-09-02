import { describe, expect, it, vi } from "vitest";
import pluginUsageGuide, {
	appendRoutingGuidance,
	buildRoutingSection,
	SECTION_HEADER,
} from "./plugin-usage-guide.js";

describe("plugin-usage-guide 路由规则注入", () => {
	it("激活工具不在规则表时不注入", () => {
		expect(buildRoutingSection(["read"])).toBe("");
		expect(appendRoutingGuidance("base prompt", ["read"])).toBe("base prompt");
	});

	it("只注入激活工具对应的规则", () => {
		const out = appendRoutingGuidance("base prompt", ["colgrep", "web_search"]);
		expect(out).toContain(SECTION_HEADER);
		expect(out).toContain("colgrep");
		expect(out).toContain("web_search");
		expect(out).not.toContain("ask_user_question");
	});

	it("已包含 section 时幂等", () => {
		const once = appendRoutingGuidance("base prompt", ["todo"]);
		expect(appendRoutingGuidance(once, ["todo"])).toBe(once);
	});

	it("规则表覆盖全部 6 个插件", () => {
		const out = appendRoutingGuidance("x", [
			"web_search",
			"resolve-library-id",
			"ask_user_question",
			"todo",
			"codegraph_search",
			"colgrep",
		]);
		for (const term of ["web_search", "query-docs", "ask_user_question", "todo", "codegraph_", "colgrep"]) {
			expect(out).toContain(term);
		}
	});

	it("工厂注册 before_agent_start 处理器", () => {
		const pi = { on: vi.fn() };
		expect(() => pluginUsageGuide(pi as never)).not.toThrow();
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});
});
