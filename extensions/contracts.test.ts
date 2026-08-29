import { describe, expect, it } from "vitest";
import { SP_CONTRACTS } from "./contracts.js";

describe("SP_CONTRACTS", () => {
	it("覆盖 5 个产物流技能且形状合法", () => {
		const map = new Map(SP_CONTRACTS);
		expect([...map.keys()].sort()).toEqual([
			"brainstorming", "executing-plans", "finishing-a-development-branch",
			"verification-before-completion", "writing-plans",
		]);
		for (const [name, contract] of SP_CONTRACTS) {
			expect(contract.source).toBe("declared");
			const kinds = [
				...(contract.produces ? [contract.produces.meta?.artifactKind] : []),
				...(contract.consumes ? [contract.consumes.meta?.artifactKind] : []),
			].flat();
			for (const kind of kinds) expect(["specs", "plans"]).toContain(kind);
		}
	});
	it("brainstorming 产出 specs；writing-plans 消费 specs 产出 plans；executing-plans 消费 plans", () => {
		const map = new Map(SP_CONTRACTS);
		expect(map.get("brainstorming")?.produces?.meta?.artifactKind).toBe("specs");
		expect(map.get("writing-plans")?.produces?.meta?.artifactKind).toBe("plans");
		expect(map.get("writing-plans")?.consumes?.meta?.artifactKind).toEqual(["specs"]);
		expect(map.get("executing-plans")?.consumes?.meta?.artifactKind).toEqual(["plans"]);
	});
});
