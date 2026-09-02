/**
 * superpowers 技能的 rpiv 契约 — 只声明产物流的 artifactKind 通道（specs/plans），
 * 不声明 data schema：组合检查是保守的（缺 schema ⇒ ok），数据校验由工作流各
 * stage 自己的 outcome/outputSchema 承担，这里不重复声明。
 * 调试/评审流技能（systematic-debugging 等）无文件产物约定，不注册契约。
 */
import type { SkillContract } from "@juicesharp/rpiv-workflow/registration";

export const SP_CONTRACTS: ReadonlyArray<readonly [string, SkillContract]> = [
	["brainstorming", {
		source: "declared",
		produces: { kind: "produces", meta: { artifactKind: "specs" } },
	}],
	["writing-plans", {
		source: "declared",
		consumes: { meta: { artifactKind: ["specs"] } },
		produces: { kind: "produces", meta: { artifactKind: "plans" } },
	}],
	["executing-plans", {
		source: "declared",
		consumes: { meta: { artifactKind: ["plans"] } },
	}],
	["verification-before-completion", {
		source: "declared",
		consumes: { meta: { artifactKind: ["plans"] } },
	}],
	["finishing-a-development-branch", {
		source: "declared",
		consumes: { meta: { artifactKind: ["plans"] } },
	}],
];
