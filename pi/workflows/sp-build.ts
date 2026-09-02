import { acts, defineWorkflow, match, produces, terminal } from "@juicesharp/rpiv-workflow/registration";
import { spArtifactOutcome, spGateOutcome } from "../extensions/collectors.js";
import { spGateSchema } from "./sp-shared.js";

/**
 * 构建流程（默认工作流）：brainstorming → 设计批准 → writing-plans → 计划批准 → executing-plans → 验证 → 收尾。
 * 发布名解析：spArtifactOutcome("specs")/("plans") 带 name ⇒ 门禁阶段用 reads: ["specs"]/["plans"] 读取；
 * spGateOutcome 无 name ⇒ 门禁按记录键发布（gate-spec / gate-plan），互不覆盖。
 * 向后跳转（revise 打回）合法但有上限 MAX_BACKWARD_JUMPS = 3 —— 两个门各一次打回，最坏 2 跳，安全。
 * 门禁阶段键名 gate-* 用 skill: "sp-gate" 覆盖（键名 ≠ 技能名）。
 */
export const spBuild = defineWorkflow({
	name: "sp-build",
	description: "superpowers 构建流程：构思 → 设计批准 → 写计划 → 计划批准 → 执行 → 验证 → 收尾（revise 打回上一阶段，abort 停止）",
	start: "brainstorming",
	stages: {
		brainstorming: produces({ outcome: spArtifactOutcome("specs") }),
		"gate-spec": produces({ skill: "sp-gate", outcome: spGateOutcome, reads: ["specs"], outputSchema: spGateSchema }),
		"writing-plans": produces({ outcome: spArtifactOutcome("plans"), reads: ["specs"] }),
		"gate-plan": produces({ skill: "sp-gate", outcome: spGateOutcome, reads: ["plans"], outputSchema: spGateSchema }),
		"executing-plans": acts({ reads: ["plans"] }),
		"verification-before-completion": acts({ reads: ["plans"] }),
		"finishing-a-development-branch": terminal(),
	},
	edges: {
		brainstorming: "gate-spec",
		"gate-spec": match("decision",
			{ "writing-plans": "approved", brainstorming: "revise", stop: "abort" },
			{ fallback: "stop" }),
		"writing-plans": "gate-plan",
		"gate-plan": match("decision",
			{ "executing-plans": "approved", "writing-plans": "revise", stop: "abort" },
			{ fallback: "stop" }),
		"executing-plans": "verification-before-completion",
		"verification-before-completion": "finishing-a-development-branch",
		"finishing-a-development-branch": "stop",
	},
});
