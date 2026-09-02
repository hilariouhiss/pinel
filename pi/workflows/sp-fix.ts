import { acts, defineWorkflow, match, produces, terminal } from "@juicesharp/rpiv-workflow/registration";
import { spGateOutcome } from "../extensions/collectors.js";
import { DIAGNOSIS_OUTCOME, spGateSchema } from "./sp-shared.js";

/**
 * 调试流程：systematic-debugging → 诊断批准 → test-driven-development → 验证 → 收尾。
 * DIAGNOSIS_OUTCOME 发布名 diagnosis ⇒ 门禁用 reads: ["diagnosis"] 读取根因陈述；
 * 门禁键名 gate-diagnosis 用 skill: "sp-gate" 覆盖，spGateOutcome 无 name ⇒ 按记录键发布。
 * 打回（revise）只跳 systematic-debugging 一步，最坏 1 跳，低于 MAX_BACKWARD_JUMPS = 3。
 */
export const spFix = defineWorkflow({
	name: "sp-fix",
	description: "superpowers 调试流程：根因定位 → 诊断批准 → TDD 修复 → 验证 → 收尾",
	start: "systematic-debugging",
	stages: {
		"systematic-debugging": produces({ outcome: DIAGNOSIS_OUTCOME }),
		"gate-diagnosis": produces({ skill: "sp-gate", outcome: spGateOutcome, reads: ["diagnosis"], outputSchema: spGateSchema }),
		"test-driven-development": acts({ reads: ["diagnosis"] }),
		"verification-before-completion": acts(),
		"finishing-a-development-branch": terminal(),
	},
	edges: {
		"systematic-debugging": "gate-diagnosis",
		"gate-diagnosis": match("decision",
			{ "test-driven-development": "approved", "systematic-debugging": "revise", stop: "abort" },
			{ fallback: "stop" }),
		"test-driven-development": "verification-before-completion",
		"verification-before-completion": "finishing-a-development-branch",
		"finishing-a-development-branch": "stop",
	},
});
