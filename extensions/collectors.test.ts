import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	spArtifactOutcome, spBucketCollector, spFrontmatterParser, spGateOutcome,
} from "./collectors.js";
import type { BranchEntry } from "@juicesharp/rpiv-workflow/registration";

function assistantEntry(text: string): BranchEntry {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

const TMP = join(process.cwd(), ".tmp-collectors");

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("spBucketCollector", () => {
	it("收集转写里宣告的 docs/superpowers/plans 路径", async () => {
		const branch = [
			assistantEntry("计划已写入 docs/superpowers/plans/2026-08-29-demo.md，请审核。"),
		];
		const result = await spBucketCollector("plans").collect({ cwd: TMP, branch, branchOffset: 0, skill: "writing-plans" });
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.artifacts[0]?.handle).toEqual({ kind: "fs", path: "docs/superpowers/plans/2026-08-29-demo.md" });
		}
	});

	it("完整路径扫描失败时，磁盘佐证的 basename 回退生效", async () => {
		const dir = join(TMP, "docs", "superpowers", "plans");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "2026-08-29-fallback.md"), "# plan\n");
		const branch = [assistantEntry("产物见 2026-08-29-fallback.md")]; // 目录前缀被模型说丢
		const result = await spBucketCollector("plans").collect({ cwd: TMP, branch, branchOffset: 0, skill: "writing-plans" });
		expect(result.kind).toBe("ok");
	});

	it("错误 bucket 的路径被拒绝", async () => {
		const branch = [assistantEntry("见 docs/superpowers/specs/2026-08-29-x.md")];
		const result = await spBucketCollector("plans").collect({ cwd: TMP, branch, branchOffset: 0, skill: "writing-plans" });
		expect(result.kind).toBe("fatal");
	});
});

describe("spGateVerdictCollector", () => {
	it("收集 .rpiv/artifacts/gates 判决路径", async () => {
		const branch = [assistantEntry("判决：.rpiv/artifacts/gates/2026-08-29-1022-gate-plan.md")];
		const result = await spGateOutcome.collector.collect({ cwd: TMP, branch, branchOffset: 0, skill: "sp-gate" });
		expect(result.kind).toBe("ok");
	});
});

describe("spFrontmatterParser", () => {
	it("解析 frontmatter；malformed YAML 降级为 {}", async () => {
		const dir = join(TMP, ".rpiv", "artifacts", "gates");
		mkdirSync(dir, { recursive: true });
		const good = join(dir, "g.md");
		writeFileSync(good, "---\ndecision: approved\nnote: ok\n---\nbody");
		const ok = await spFrontmatterParser.parse({ cwd: TMP, skill: "sp-gate", artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/gates/g.md" }, role: "primary" }] });
		expect(ok.kind).toBe("ok");
		if (ok.kind === "ok") expect(ok.payload.data.decision).toBe("approved");

		const bad = join(dir, "b.md");
		writeFileSync(bad, "---\ntarget: foo (lane UI: L0–L2)\n---\nbody");
		const deg = await spFrontmatterParser.parse({ cwd: TMP, skill: "sp-gate", artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/gates/b.md" }, role: "primary" }] });
		expect(deg.kind).toBe("ok");
		if (deg.kind === "ok") expect(deg.payload.data).toEqual({});
	});
});
