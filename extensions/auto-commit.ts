import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Auto commit（Pinel 设置「Auto commit」开关）——开启时向 agent 注入简短提示词：
 * 完成一个可工作单元后自行 git 提交；关闭时不注入。
 *
 * 开关载体：pi 全局 settings.json 的 pinel.autoCommit（布尔）。宿主
 * （Pinel VS Code 扩展 setAutoCommit）写入；本扩展每次 before_agent_start
 * 现读（fs 直读 + 防御解析），无需重启 pi 即可生效。读失败静默跳过注入
 * （注入是增强项，不得因 settings 损坏阻断会话）。
 */

export const AUTO_COMMIT_HEADER = "## Auto Commit (Pinel)";

const AUTO_COMMIT_SECTION = `${AUTO_COMMIT_HEADER}

After finishing a working unit of change, commit it with git: stage the relevant files and write a short commit message describing the change. Skip committing while work is incomplete or tests fail, and do not commit changes the user has staged or is actively editing.
`;

/** 防御解析 settings.json：pinel.autoCommit 严格 === true 才开启（其余形状视为关）。 */
export function readAutoCommitEnabled(settingsJson: unknown): boolean {
	if (typeof settingsJson !== "object" || settingsJson === null || Array.isArray(settingsJson)) {
		return false;
	}
	const pinel = (settingsJson as Record<string, unknown>).pinel;
	if (typeof pinel !== "object" || pinel === null || Array.isArray(pinel)) {
		return false;
	}
	return (pinel as Record<string, unknown>).autoCommit === true;
}

/** settings.json 路径：对齐宿主 agentSettingsPath（PI_CODING_AGENT_DIR 覆盖，默认 ~/.pi/agent）。 */
export function pinelSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "settings.json");
}

/** 开启且未注入过时追加提示词；否则原样返回（不返回重写 → 不破坏 prompt 前缀缓存）。 */
export function appendAutoCommitGuidance(systemPrompt: string, enabled: boolean): string {
	if (!enabled || systemPrompt.includes(AUTO_COMMIT_HEADER)) {
		return systemPrompt;
	}
	return systemPrompt + "\n\n" + AUTO_COMMIT_SECTION;
}

export default function autoCommitExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		let enabled = false;
		try {
			const raw = fs.readFileSync(pinelSettingsPath(), "utf8");
			enabled = readAutoCommitEnabled(JSON.parse(raw));
		} catch {
			return undefined; // 无文件/坏 JSON：不开注入
		}
		const next = appendAutoCommitGuidance(event.systemPrompt, enabled);
		if (next === event.systemPrompt) {
			return undefined;
		}
		return { systemPrompt: next };
	});
}
