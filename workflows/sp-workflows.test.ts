import { describe, expect, it } from "vitest";
import { SP_WORKFLOWS } from "./index.js";

describe("SP_WORKFLOWS 图结构", () => {
	it("恰好三条，sp-build 在前（默认工作流候选）", () => {
		expect(SP_WORKFLOWS.map((w) => w.name)).toEqual(["sp-build", "sp-fix", "sp-review"]);
	});
	for (const wf of SP_WORKFLOWS) {
		it(`${wf.name}: start/edges 引用合法，门禁有 outputSchema 且 match 路由齐全`, () => {
			const stageNames = new Set(Object.keys(wf.stages));
			expect(stageNames.has(wf.start)).toBe(true);
			for (const [from, edge] of Object.entries(wf.edges)) {
				expect(stageNames.has(from)).toBe(true);
				if (typeof edge === "string") {
					expect(edge === "stop" || stageNames.has(edge)).toBe(true);
				} else {
					// defineRoute 产物：.targets 枚举所有可能分支
					for (const t of (edge as { targets?: string[] }).targets ?? []) {
						expect(t === "stop" || stageNames.has(t)).toBe(true);
					}
				}
			}
			for (const [name, stage] of Object.entries(wf.stages)) {
				if (name.startsWith("gate-")) {
					expect((stage as { skill?: string }).skill).toBe("sp-gate");
					expect((stage as { outputSchema?: unknown }).outputSchema).toBeDefined();
				}
			}
		});
	}
	it("sp-build 两个门禁的 match 分支：approved 前进 / revise 打回 / abort 停止", () => {
		const build = SP_WORKFLOWS[0]!;
		const gateSpec = build.edges["gate-spec"] as { targets?: string[] };
		expect(gateSpec.targets).toContain("writing-plans");
		expect(gateSpec.targets).toContain("brainstorming");
		const gatePlan = build.edges["gate-plan"] as { targets?: string[] };
		expect(gatePlan.targets).toContain("executing-plans");
		expect(gatePlan.targets).toContain("writing-plans");
	});
	it("门禁 match 方向：approved 前进 / revise 打回 / abort 停止", () => {
		const invoke = (wf: (typeof SP_WORKFLOWS)[number], edgeName: string, decision: string) => {
			const edge = (wf.edges as Record<string, (ctx: { output: { data: { decision: string } }; state: unknown }) => string>)[edgeName];
			return edge!({ output: { data: { decision } }, state: {} });
		};
		const build = SP_WORKFLOWS[0]!;
		expect(invoke(build, "gate-spec", "approved")).toBe("writing-plans");
		expect(invoke(build, "gate-spec", "revise")).toBe("brainstorming");
		expect(invoke(build, "gate-spec", "abort")).toBe("stop");
		expect(invoke(build, "gate-plan", "approved")).toBe("executing-plans");
		expect(invoke(build, "gate-plan", "revise")).toBe("writing-plans");
		expect(invoke(build, "gate-plan", "abort")).toBe("stop");
		const fix = SP_WORKFLOWS[1]!;
		expect(invoke(fix, "gate-diagnosis", "approved")).toBe("test-driven-development");
		expect(invoke(fix, "gate-diagnosis", "revise")).toBe("systematic-debugging");
		expect(invoke(fix, "gate-diagnosis", "abort")).toBe("stop");
	});
	it("每条工作流的首阶段都有 outcome（规避 FAIL_MISSING_ARTIFACT）", () => {
		for (const wf of SP_WORKFLOWS) {
			const first = wf.stages[wf.start] as { outcome?: unknown };
			expect(first.outcome).toBeDefined();
		}
	});
});
