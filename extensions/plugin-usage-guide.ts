import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 工具名 → 路由规则。tool 键必须与各包 registerTool 的 name 完全一致
 * （已核实：web_search / resolve-library-id / ask_user_question / todo /
 * codegraph_search / colgrep）。
 */
const ROUTING_RULES: ReadonlyArray<{ tool: string; rule: string }> = [
	{
		tool: "resolve-library-id",
		rule: "Library/framework API questions (React, Next.js, Prisma, ...): use resolve-library-id then query-docs (Context7) BEFORE web_search — current docs beat training data. Resolve at most 3 times per question, then use the best result.",
	},
	{
		tool: "web_search",
		rule: "Use web_search for facts, recent information, and unfamiliar topics. Prefer {queries:[...]} with 2-4 varied angles over a single query. Use fetch_content when the user names a specific URL/PDF/repo/video; use source_check to verify a specific claim with citations.",
	},
	{
		tool: "codegraph_search",
		rule: "For architecture, symbol lookup, and codebase navigation, try codegraph_* tools FIRST: codegraph_explore for broad questions, codegraph_search for symbol names, codegraph_node for a known symbol, codegraph_callers/impact for flow. Only fall back to grep/read when codegraph is insufficient or the user asks for literal text.",
	},
	{
		tool: "colgrep",
		rule: "Use colgrep for intent-based code search (natural language); use grep only for exact pattern or symbol matching.",
	},
	{
		tool: "ask_user_question",
		rule: "When requirements are ambiguous or multiple valid approaches exist, ask the user via ask_user_question BEFORE implementing (up to 4 questions, 2-4 options each, grouped into one invocation).",
	},
	{
		tool: "todo",
		rule: "For work with 3+ steps or an explicit task list, plan with the todo tool first and keep statuses current as you work.",
	},
];

export const SECTION_HEADER = "## Plugin Tool Routing";

export function buildRoutingSection(selectedTools: ReadonlyArray<string>): string {
	const active = new Set(selectedTools);
	const hits = ROUTING_RULES.filter((r) => active.has(r.tool));
	if (hits.length === 0) return "";
	return `\n\n${SECTION_HEADER}\n${hits.map((r) => `- ${r.rule}`).join("\n")}\n`;
}

export function appendRoutingGuidance(
	systemPrompt: string,
	selectedTools: ReadonlyArray<string>,
): string {
	const section = buildRoutingSection(selectedTools);
	if (!section) return systemPrompt;
	if (systemPrompt.includes(SECTION_HEADER)) return systemPrompt; // 防扩展被重复加载时二次注入
	return systemPrompt + section;
}

export default function pluginUsageGuide(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		const next = appendRoutingGuidance(
			event.systemPrompt,
			event.systemPromptOptions.selectedTools ?? [],
		);
		// 无变化时不返回 systemPrompt 重写，避免破坏 prompt 前缀缓存
		if (next === event.systemPrompt) return undefined;
		return { systemPrompt: next };
	});
}
