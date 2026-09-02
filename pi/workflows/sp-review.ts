import { acts, defineWorkflow, produces, transcriptPathCollector } from "@juicesharp/rpiv-workflow/registration";

/**
 * 评审流程：requesting-code-review → receiving-code-review → 验证。全 acts 链会被
 *  FAIL_MISSING_ARTIFACT 停机，故首阶段配全量转写产物（评审请求摘要），命名槽 review-request。
 */
const REVIEW_REQUEST_OUTCOME = {
	name: "review-request",
	collector: transcriptPathCollector({ pattern: /([\s\S]+)/ }),
};

export const spReview = defineWorkflow({
	name: "sp-review",
	description: "superpowers 评审流程：请求评审 → 吸收反馈 → 验证（全程由 reviewer 通过停靠提问交互）",
	start: "requesting-code-review",
	stages: {
		"requesting-code-review": produces({ outcome: REVIEW_REQUEST_OUTCOME }),
		"receiving-code-review": acts({ reads: ["review-request"] }),
		"verification-before-completion": acts(),
	},
	edges: {
		"requesting-code-review": "receiving-code-review",
		"receiving-code-review": "verification-before-completion",
		"verification-before-completion": "stop",
	},
});
