/**
 * 提示词组成采集 → Pinel 面板推送（statusKey "pinel.prompt"，v:1）。
 *
 * 数据源（pi 0.84 扩展 API 实证）：
 * - before_agent_start 事件自带 systemPromptOptions（基础组成：customPrompt、
 *   contextFiles、appendSystemPrompt、promptGuidelines、skills、selectedTools）
 *   与 systemPrompt（链上已注入前辈扩展后的当前值）；
 * - agent_start 时 ctx.getSystemPrompt() = 最终系统提示词（全部插件注入完成、
 *   agent.state.systemPrompt 已被赋最终值）。
 *
 * 差分语义：injected = final 去掉 base 前缀。base 取本扩展 before_agent_start
 * 位置所见（每轮新鲜、含工具表重建后的新 base）；若本扩展不在链尾，链上先于
 * 本扩展注入的部分计入 base 而非 injected（低计，不虚高）。插件是「替换」而非
 * 「追加」时差分失败 → injectedUnknown:true。
 *
 * payload 契约（v:1；宿主 pinel-payload.ts 防御解析）：
 * {
 *   v: 1,
 *   system:   {chars, kind:"default"|"custom", preview},        // 基础提示词整体
 *   files:    [{level:"user"|"project", name, path, chars, preview}], // contextFiles
 *   append?:  {chars, preview},                                  // settings appendSystemPrompt
 *   counts:   {guidelines, skills, tools},
 *   injected?:       {chars, preview},                           // 前缀差分成功（可为 0）
 *   injectedUnknown?: true,                                      // 替换型注入，不可差分
 *   finalChars: number,
 * }
 * 预览统一截断 PREVIEW_CHARS；推送按 JSON 去重（组成不变不重发）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentDir } from "./agent-dir.js";

const PREVIEW_CHARS = 2000;


/** 路径归一比较前缀（大小写不敏感 + 分隔符统一；Windows 路径兼容）。 */
function isUnderDir(filePath: string, dir: string): boolean {
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const f = norm(filePath);
	const d = norm(dir);
	return f === d || f.startsWith(`${d}/`);
}

function preview(text: string): string {
	return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

export interface PromptCompositionFile {
  level: "user" | "project";
  name: string;
  path: string;
  chars: number;
  preview: string;
}

/** 每目录上下文文件候选（对齐 pi loadContextFileFromDir：override 优先，大小写变体）。 */
const CONTEXT_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** 读单个目录的上下文文件（候选序命中即停；无/读失败 → null）。 */
function loadContextFromDir(dir: string): { path: string; content: string } | null {
  for (const name of CONTEXT_CANDIDATES) {
    const filePath = join(dir, name);
    try {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
      return { path: filePath, content: readFileSync(filePath, "utf8") };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 启动帧上下文文件扫描（session_start 时 pi 尚未通过 API 暴露 contextFiles，
 * 按 pi 契约自行解析；首轮权威全帧到达后覆盖，此处仅影响首条消息前的展示窗口）。
 * 遍历：全局 agentDir + cwd 逐级向上至根（含 cwd 自身）。
 */
export function scanStartupContextFiles(cwd: string): PromptCompositionFile[] {
  const files: PromptCompositionFile[] = [];
  const seen = new Set<string>();
  const push = (filePath: string, content: string) => {
    const norm = filePath.replace(/\\/g, "/");
    if (seen.has(norm)) return;
    seen.add(norm);
    files.push({
      level: isUnderDir(filePath, agentDir()) ? "user" : "project",
      name: norm.split("/").pop() ?? filePath,
      path: filePath,
      chars: content.length,
      preview: preview(content),
    });
  };
  const global = loadContextFromDir(agentDir());
  if (global) push(global.path, global.content);
  let dir = resolve(cwd);
  for (;;) {
    const found = loadContextFromDir(dir);
    if (found) push(found.path, found.content);
    const parent = join(dir, "..");
    const next = resolve(parent);
    if (next === dir) break;
    dir = next;
  }
  return files;
}

/** 启动帧（v:1；startup 标记 + files；system/counts/finalChars 缺省，宿主解析器接受）。 */
export function buildStartupPayload(files: PromptCompositionFile[]): Record<string, unknown> {
  return { v: 1, startup: true, files };
}

interface Section {
	chars: number;
	preview: string;
}

function section(text: string): Section {
	return { chars: text.length, preview: preview(text) };
}

export interface PromptCompositionOptions {
	customPrompt?: unknown;
	contextFiles?: unknown;
	appendSystemPrompt?: unknown;
	promptGuidelines?: unknown;
	skills?: unknown;
	selectedTools?: unknown;
	[key: string]: unknown;
}

/**
 * 纯构造：基础组成 + 基线文本 + 最终文本 → payload。
 * options/baseText 缺失（首轮回合前无 before_agent_start）→ null（不推送）。
 */
export function buildPromptPayload(
	options: PromptCompositionOptions | null | undefined,
	baseText: string | undefined,
	finalText: string,
): Record<string, unknown> | null {
	if (!options || typeof baseText !== "string") {
		return null;
	}
	const custom = typeof options.customPrompt === "string" ? options.customPrompt : "";
	const files: Array<Record<string, unknown>> = [];
	const agent = agentDir();
	if (Array.isArray(options.contextFiles)) {
		for (const f of options.contextFiles) {
			if (typeof f !== "object" || f === null) continue;
			const { path: p, content } = f as { path?: unknown; content?: unknown };
			if (typeof p !== "string" || typeof content !== "string") continue;
			files.push({
				level: isUnderDir(p, agent) ? "user" : "project",
				name: p.replace(/\\/g, "/").split("/").pop() ?? p,
				path: p,
				chars: content.length,
				preview: preview(content),
			});
		}
	}
	const payload: Record<string, unknown> = {
		v: 1,
		system: {
			chars: baseText.length,
			kind: custom.length > 0 ? "custom" : "default",
			preview: preview(custom.length > 0 ? custom : baseText),
		},
		files,
		counts: {
			guidelines: Array.isArray(options.promptGuidelines) ? options.promptGuidelines.length : 0,
			skills: Array.isArray(options.skills) ? options.skills.length : 0,
			tools: Array.isArray(options.selectedTools) ? options.selectedTools.length : 0,
		},
		finalChars: finalText.length,
	};
	if (typeof options.appendSystemPrompt === "string" && options.appendSystemPrompt.length > 0) {
		payload.append = section(options.appendSystemPrompt);
	}
	if (finalText.startsWith(baseText)) {
		const injected = finalText.slice(baseText.length);
		if (injected.length > 0) {
			payload.injected = section(injected);
		}
	} else {
		payload.injectedUnknown = true;
	}
	return payload;
}

export interface PromptCompositionPi {
	on: (event: string, handler: (ev: any, ctx: any) => void) => void;
}

/** 注册采集与推送（pinel.ts 在 PINEL_PLUGIN=1 门内调用）。 */
export function registerPromptComposition(pi: PromptCompositionPi): void {
	let options: PromptCompositionOptions | null = null;
	let baseText: string | undefined;
	let lastJson: string | null = null;

	pi.on("session_start", (_ev: any, ctx: any) => {
		if (ctx?.mode !== "rpc") return;
		const cwd = typeof ctx.cwd === "string" ? ctx.cwd : "";
		if (!cwd) return;
		const files = scanStartupContextFiles(cwd);
		const json = JSON.stringify(buildStartupPayload(files));
		lastJson = json; // 占位去重：全帧与启动帧 JSON 不同
		ctx.ui?.setStatus?.("pinel.prompt", json);
	});

	pi.on("before_agent_start", (ev: any, ctx: any) => {
		if (ctx?.mode !== "rpc") return;
		options = (ev?.systemPromptOptions as PromptCompositionOptions) ?? null;
		baseText = typeof ev?.systemPrompt === "string" ? ev.systemPrompt : undefined;
	});

	pi.on("agent_start", (_ev: any, ctx: any) => {
		if (ctx?.mode !== "rpc") return;
		const finalText = typeof ctx.getSystemPrompt === "function" ? String(ctx.getSystemPrompt() ?? "") : "";
		if (finalText.length === 0) return;
		const payload = buildPromptPayload(options, baseText, finalText);
		if (!payload) return;
		const json = JSON.stringify(payload);
		if (json === lastJson) return; // 组成未变不重发
		lastJson = json;
		ctx.ui?.setStatus?.("pinel.prompt", json);
	});
}
