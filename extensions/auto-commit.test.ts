import { describe, expect, it, vi } from "vitest";
import autoCommitExtension, {
	appendAutoCommitGuidance,
	AUTO_COMMIT_HEADER,
	readAutoCommitEnabled,
} from "./auto-commit.js";

describe("auto-commit 提示词注入", () => {
	it("pinel.autoCommit 严格 true 才开启（其余形状视为关）", () => {
		expect(readAutoCommitEnabled({ pinel: { autoCommit: true } })).toBe(true);
		expect(readAutoCommitEnabled({ pinel: { autoCommit: false } })).toBe(false);
		expect(readAutoCommitEnabled({ pinel: {} })).toBe(false);
		expect(readAutoCommitEnabled({ pinel: "x" })).toBe(false);
		expect(readAutoCommitEnabled({})).toBe(false);
		expect(readAutoCommitEnabled(null)).toBe(false);
		expect(readAutoCommitEnabled("garbage")).toBe(false);
	});

	it("开启时追加简短提示词；关闭时原样返回", () => {
		const on = appendAutoCommitGuidance("base prompt", true);
		expect(on).toContain(AUTO_COMMIT_HEADER);
		expect(on).toContain("commit it with git");
		expect(on.startsWith("base prompt")).toBe(true);
		expect(appendAutoCommitGuidance("base prompt", false)).toBe("base prompt");
	});

	it("已包含 section 时幂等（防重复加载二次注入）", () => {
		const once = appendAutoCommitGuidance("base prompt", true);
		expect(appendAutoCommitGuidance(once, true)).toBe(once);
	});

	it("工厂注册 before_agent_start 处理器", () => {
		const pi = { on: vi.fn() };
		expect(() => autoCommitExtension(pi as never)).not.toThrow();
		expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});
});
