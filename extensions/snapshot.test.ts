import { describe, expect, it } from "vitest";
import { buildSnapshot, buildTree } from "./snapshot.js";

/** pi 会话条目真实形状：message 条目的 role/content 嵌套在 entry.message 下。 */
function makeCtx(entries: unknown[], leafId?: string, sessionFile?: string): any {
	const sm = {
		getEntries: () => entries,
		getLeafId: () => leafId,
		getSessionFile: () => sessionFile,
	};
	return { sessionManager: sm, model: { provider: "openai", id: "gpt-x" }, thinkingLevel: "medium" };
}

const USER = { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hi" } };
const ASSISTANT = {
	type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01Z",
	message: { role: "assistant", content: [{ type: "text", text: "hey" }] },
};
const TOOL = {
	type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:02Z",
	message: { role: "toolResult", content: "ok", toolCallId: "c1" },
};

describe("buildSnapshot", () => {
	it("按 entry.message.role 计数（user/assistant/toolResult），total 为三者之和", () => {
		const entries = [
			USER,
			ASSISTANT,
			TOOL,
			{ type: "thinking_level_change", id: "x1", parentId: "t1", timestamp: "2026-01-01T00:00:03Z", thinkingLevel: "medium" },
			{ type: "model_change", id: "x2", parentId: "t1", timestamp: "2026-01-01T00:00:04Z", provider: "openai", modelId: "gpt-x" },
		];
		const snap = buildSnapshot(makeCtx(entries, "t1", "/tmp/s.jsonl"));
		expect(snap).toEqual({
			v: 1,
			messages: { user: 1, assistant: 1, toolResult: 1, total: 3 },
			model: "openai/gpt-x",
			thinkingLevel: "medium",
			leafId: "t1",
			sessionFile: "/tmp/s.jsonl",
		});
	});

	it("未知角色/缺 message 字段容缺为 0", () => {
		const snap = buildSnapshot(makeCtx([{ type: "custom", id: "c1", customType: "whatever" }]));
		expect(snap.messages).toEqual({ user: 0, assistant: 0, toolResult: 0, total: 0 });
	});
});

describe("buildTree", () => {
	it("读取 entry.message.content 生成 user/assistant 节点", () => {
		const tree = buildTree(makeCtx([USER, ASSISTANT, TOOL]));
		expect(tree.nodes).toEqual([
			{ entryId: "u1", role: "user", text: "hi", timestamp: "2026-01-01T00:00:00Z" },
			{ entryId: "a1", role: "assistant", text: "hey", timestamp: "2026-01-01T00:00:01Z" },
		]);
	});
});
