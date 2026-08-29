import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const raw = readFileSync(join(process.cwd(), "skills", "sp-gate", "SKILL.md"), "utf-8");
const { frontmatter, body } = parseFrontmatter(raw) as { frontmatter: any; body: string };

describe("sp-gate SKILL.md", () => {
	it("frontmatter 具备工作流所需的全部字段", () => {
		expect(frontmatter.name).toBe("sp-gate");
		expect(frontmatter["disable-model-invocation"]).toBe(true);
		expect(frontmatter.contract.produces.meta.artifactKind).toBe("gates");
		const decision = frontmatter.contract.produces.data.properties.decision;
		expect(decision.enum).toEqual(["approved", "revise", "abort"]);
	});
	it("正文包含三要素：读产物、ask_user_question、写判决文件", () => {
		expect(body).toMatch(/ask_user_question/);
		expect(body).toMatch(/\.rpiv\/artifacts\/gates\//);
		expect(body).toMatch(/decision:\s*(approved|revise|abort)/);
	});
});
