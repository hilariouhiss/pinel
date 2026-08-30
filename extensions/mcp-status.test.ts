import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushMcpStatus, MCP_ADAPTER_STATUS_EVENT, registerMcpStatus } from "./mcp-status.js";
import { setPinelCtx } from "./push-target.js";

function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data));
}

function makePi() {
	const handlers = new Map<string, (data: unknown) => void>();
	const pi = {
		events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
	};
	return { pi, handlers };
}

function makeCtx() {
	const pushes: Array<{ key: string; json: string }> = [];
	return {
		pushes,
		ctx: { ui: { setStatus: (key: string, json: string) => pushes.push({ key, json }) } },
	};
}

describe("registerMcpStatus", () => {
	let agentRoot: string;
	let cwd: string;

	beforeEach(() => {
		vi.unstubAllEnvs();
		agentRoot = mkdtempSync(join(tmpdir(), "pinel-mcp-agent-"));
		cwd = mkdtempSync(join(tmpdir(), "pinel-mcp-cwd-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentRoot);
		setPinelCtx(undefined);
	});

	it("基线：全局+项目配置名与 scope（项目源同名覆盖为 project）；无 ctx 不推送，flush 后推送", () => {
		writeJson(join(agentRoot, "mcp.json"), {
			mcpServers: { globalA: {}, globalOff: { disabled: true } },
		});
		writeJson(join(cwd, ".mcp.json"), { mcpServers: { projA: {}, globalA: {} } });
		const { pi, handlers } = makePi();
		registerMcpStatus(pi, cwd);
		expect(handlers.has(MCP_ADAPTER_STATUS_EVENT)).toBe(true);

		// ctx 未就绪：flush 不推送
		const { pushes, ctx } = makeCtx();
		flushMcpStatus();
		expect(pushes.length).toBe(0);

		setPinelCtx(ctx);
		flushMcpStatus();
		expect(pushes.length).toBe(1);
		expect(pushes[0].key).toBe("pinel.mcp");
		const payload = JSON.parse(pushes[0].json);
		expect(payload.v).toBe(1);
		expect(payload.servers).toEqual([
			{ name: "globalA", status: "unknown", scope: "project" },
			{ name: "globalOff", status: "disabled", scope: "global" },
			{ name: "projA", status: "unknown", scope: "project" },
		]);
	});

	it("快照事件：状态/工具数/scope 覆盖基线；非法行丢弃、非法状态归 unknown；重复快照去重", () => {
		writeJson(join(agentRoot, "mcp.json"), { mcpServers: { globalA: {} } });
		writeJson(join(cwd, ".pi", "mcp.json"), { mcpServers: { projA: {} } });
		const { pi, handlers } = makePi();
		const { pushes, ctx } = makeCtx();
		setPinelCtx(ctx);
		registerMcpStatus(pi, cwd);
		flushMcpStatus(); // 基线推送
		expect(pushes.length).toBe(1);

		const snapshot = {
			version: 1,
			servers: [
				{ name: "globalA", status: "connected", toolCount: 12 },
				{ name: "projA", status: "failed", failedAgoSeconds: 30 },
				{ name: "ghost", status: "connected" }, // 不在任何配置 → global
				{ name: "", status: "connected" }, // 非法名：丢弃
				{ status: "connected" }, // 缺名：丢弃
				{ name: "weird", status: "frobnicated" }, // 非法状态 → unknown
			],
		};
		handlers.get(MCP_ADAPTER_STATUS_EVENT)!(snapshot);
		expect(pushes.length).toBe(2);
		const payload = JSON.parse(pushes[1].json);
		expect(payload.servers).toEqual([
			{ name: "globalA", status: "connected", scope: "global", toolCount: 12 },
			{ name: "projA", status: "failed", scope: "project" },
			{ name: "ghost", status: "connected", scope: "global" },
			{ name: "weird", status: "unknown", scope: "global" },
		]);
		// 相同快照重放：去重不重发
		handlers.get(MCP_ADAPTER_STATUS_EVENT)!(snapshot);
		expect(pushes.length).toBe(2);
	});

	it("空服务器列表快照 → 空载荷（chip 隐藏信号）；形状不符快照忽略", () => {
		writeJson(join(agentRoot, "mcp.json"), { mcpServers: { a: {} } });
		const { pi, handlers } = makePi();
		const { pushes, ctx } = makeCtx();
		setPinelCtx(ctx);
		registerMcpStatus(pi, cwd);
		flushMcpStatus();

		handlers.get(MCP_ADAPTER_STATUS_EVENT)!(null);
		expect(pushes.length).toBe(1, "非对象快照必须忽略");
		handlers.get(MCP_ADAPTER_STATUS_EVENT)!({ version: 1, servers: [] });
		expect(pushes.length).toBe(2);
		expect(JSON.parse(pushes[1].json).servers).toEqual([]);
	});

	it("坏 JSON 配置源忽略；无任何配置时基线为空", () => {
		writeFileSync(join(agentRoot, "mcp.json"), "{ not json");
		const { pi } = makePi();
		const { pushes, ctx } = makeCtx();
		setPinelCtx(ctx);
		registerMcpStatus(pi, cwd);
		flushMcpStatus();
		expect(JSON.parse(pushes[0].json).servers).toEqual([]);
	});
});
