import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentDir } from "./agent-dir.js";

describe("agentDir", () => {
	it("env 覆盖优先（trim 后生效）", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "  /custom/agent " })).toBe("/custom/agent");
	});

	it("空白 env 视为缺失 → 回落默认 ~/.pi/agent", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "   " })).toBe(join(homedir(), ".pi", "agent"));
	});

	it("缺省 = ~/.pi/agent；无参读 process.env", () => {
		expect(agentDir({})).toBe(join(homedir(), ".pi", "agent"));
		expect(agentDir().length).toBeGreaterThan(0);
	});
});
