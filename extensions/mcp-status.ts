/**
 * MCP 服务器状态采集 → Pinel 面板推送（statusKey "pinel.mcp"，v:1）。
 *
 * 数据源：
 * - 实时快照：pi-mcp-adapter 经 pi.events 发布 "pi-mcp-adapter/status/v1"
 *   （McpStatusSnapshot：name/status/toolCount/disabled，纯内存读不触发连接）。
 * - scope：配置文件定位——项目源 <cwd>/.mcp.json、<cwd>/.pi/mcp.json 中定义的
 *   服务器为 "project"，其余为 "global"（镜像适配器合并优先级：项目源在全局
 *   源之后合并覆盖，故出现在任一项目源即项目级）。
 * - 基线：适配器未加载/首快照未到时，从 pi 全局与项目配置读名字列表，
 *   status "unknown"（config 里 disabled 的为 "disabled"）。
 *
 * 推送：快照/基线写入模块级 latest，pinel.ts 每次 setPinelCtx 后调
 * flushMcpStatus() 经 ctx.ui.setStatus 补发（ctx 不在 pi.events 回调参数里，
 * 复用 push-target 槽位）；JSON 去重，组成不变不重发。
 *
 * payload 契约（v:1；宿主 pinel-payload.ts 防御解析）：
 * { v: 1, servers: [{ name, status, scope, toolCount?, disabled? }] }
 * status: connected|disabled|needs-auth|failed|cached|not-connected|unknown
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPinelCtx } from "./push-target.js";

export const MCP_ADAPTER_STATUS_EVENT = "pi-mcp-adapter/status/v1";

const VALID_STATUSES = new Set([
	"connected",
	"disabled",
	"needs-auth",
	"failed",
	"cached",
	"not-connected",
	"unknown",
]);

export type McpServerStatus = string;
export type McpScope = "global" | "project";

interface ServerRow {
	name: string;
	status: string;
	scope: McpScope;
	toolCount?: number;
	disabled?: boolean;
}

/** agentDir 解析（镜像 pi config.ts getAgentDir：env 优先，缺省 ~/.pi/agent）。 */
function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env && env.length > 0) return env;
	return join(homedir(), ".pi", "agent");
}

/** 读取 mcp.json 的 mcpServers：名字 → 是否 disabled（坏 JSON/形状漂移 → 空表）。 */
function readServerDefs(path: string): Map<string, boolean> {
	const defs = new Map<string, boolean>();
	if (!existsSync(path)) {
		return defs;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const servers = parsed?.mcpServers;
		if (typeof servers !== "object" || servers === null) {
			return defs;
		}
		for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
			if (typeof name !== "string" || name.length === 0) {
				continue;
			}
			defs.set(name, (def as Record<string, unknown>)?.disabled === true);
		}
	} catch {
		// 忽略该源
	}
	return defs;
}

let latest: Record<string, unknown> | null = null;
let lastPushed: string | null = null;

/** 补发最新载荷（pinel.ts 在每次会话事件写入 ctx 后调用；未变不重发）。 */
export function flushMcpStatus(): void {
	if (!latest) {
		return;
	}
	const ctx = getPinelCtx() as
		| { ui?: { setStatus?: (key: string, text: string) => void } }
		| undefined;
	if (!ctx?.ui?.setStatus) {
		return; // ctx 未就绪：保留待推（不记 lastPushed，就绪后仍会补发）
	}
	const json = JSON.stringify(latest);
	if (json === lastPushed) {
		return;
	}
	lastPushed = json;
	ctx.ui.setStatus("pinel.mcp", json);
}

/**
 * 注册采集（pinel.ts 在 PINEL_PLUGIN=1 门内调用；cwd 可注入供测试）。
 * 订阅 pi.events 适配器快照事件 + 配置基线兜底。
 */
export function registerMcpStatus(pi: {
	events?: { on?: (name: string, handler: (data: unknown) => void) => void };
}, cwd: string = process.cwd()): void {
	lastPushed = null; // 新注册（新进程/测试隔离）：重推即使内容相同
	const projectNames = new Set<string>();
	for (const p of [join(cwd, ".mcp.json"), join(cwd, ".pi", "mcp.json")]) {
		for (const name of readServerDefs(p).keys()) {
			projectNames.add(name);
		}
	}
	const scopeOf = (name: string): McpScope => (projectNames.has(name) ? "project" : "global");

	// 基线：pi 全局 + 项目配置（适配器未加载/首快照前兜底；同名时项目源覆盖，scope 统一用 scopeOf）
	const baseline: ServerRow[] = [];
	const seen = new Set<string>();
	for (const path of [join(agentDir(), "mcp.json"), join(cwd, ".mcp.json"), join(cwd, ".pi", "mcp.json")]) {
		for (const [name, disabled] of readServerDefs(path)) {
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			baseline.push({ name, status: disabled ? "disabled" : "unknown", scope: scopeOf(name) });
		}
	}
	latest = { v: 1, servers: baseline };

	pi.events?.on?.(MCP_ADAPTER_STATUS_EVENT, (snapshot: unknown) => {
		const list = (snapshot as { servers?: unknown })?.servers;
		if (!Array.isArray(list)) {
			return;
		}
		const servers: ServerRow[] = [];
		for (const entry of list) {
			const s = entry as Record<string, unknown> | null;
			if (typeof s?.name !== "string" || s.name.length === 0) {
				continue;
			}
			const status =
				typeof s.status === "string" && VALID_STATUSES.has(s.status)
					? s.status
					: "unknown";
			const row: ServerRow = { name: s.name, status, scope: scopeOf(s.name) };
			if (typeof s.toolCount === "number") {
				row.toolCount = s.toolCount;
			}
			if (s.disabled === true) {
				row.disabled = true;
			}
			servers.push(row);
		}
		latest = { v: 1, servers };
		flushMcpStatus();
	});
}
