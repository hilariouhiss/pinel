/**
 * pi agent 目录解析（镜像 pi config.ts getAgentDir：PI_CODING_AGENT_DIR
 * 环境变量优先，缺省 ~/.pi/agent）。三个采集器共用（prompt-composition /
 * mcp-status / auto-commit），防解析语义漂移；env 可注入供测试。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(env: { PI_CODING_AGENT_DIR?: string } = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	return configured && configured.length > 0 ? configured : join(homedir(), ".pi", "agent");
}
