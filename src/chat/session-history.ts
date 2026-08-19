import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 会话历史纯函数模块（无 vscode 依赖，可单测）。
 *
 * 数据源说明：pi RPC 协议无"列出会话"命令，会话列表由宿主直接扫描
 * 会话存储目录获得。目录布局（对齐 pi 的 session-manager.js）：
 * - 默认布局：`<sessionsRoot>/--<encodeCwd(cwd)>--/<timestamp>_<uuid>.jsonl`
 * - 自定义布局（--session-dir 指定时 pi 不建 cwd 子目录）：`<sessionsRoot>/<file>.jsonl`
 *
 * 文件格式（对齐 pi 的 session-format.md）：
 * - 首行 header：{"type":"session","version":3,"id","timestamp","cwd"}
 * - session_info 条目携带显示名（取最新一条，含显式清除）
 * - message 条目的 message.content 为字符串或 [{type:"text",text}] 数组形态
 *
 * 性能取舍：只解析文件前 MAX_SCAN_LINES 行（header + 名称 + 首条 user 消息
 * 在绝大多数会话中位于文件前部）；超长文件标记 truncated 降级显示；
 * modified 用文件 mtime（近似最后活动时间，免全扫）。
 */

/** 每文件最多解析的行数（超过则 truncated）。 */
export const MAX_SCAN_LINES = 200;
/** 首条 user 消息预览最大字符数。 */
export const MAX_PREVIEW_CHARS = 120;

/** 会话列表项（webview 协议镜像；时间用 epoch ms 便于 JSON 序列化）。 */
export interface SessionListItem {
  path: string;
  id: string;
  created?: number;
  modified: number;
  name?: string;
  preview?: string;
  truncated: boolean;
}

/**
 * 会话存储目录解析（provider 与 controller 共用，防布局判断漂移）。
 * - 自定义目录（pinel.sessionDir / --session-dir）：pi 不建 cwd 子目录（custom 布局）
 * - 默认：`~/.pi/agent/sessions` + cwd 子目录（default 布局）
 */
export function resolveSessionsRoot(
  cwd: string | undefined,
  configuredRoot?: string,
): { root: string; layout: SessionLayout } {
  if (configuredRoot) {
    return { root: configuredRoot, layout: "custom" };
  }
  return { root: path.join(os.homedir(), ".pi", "agent", "sessions"), layout: "default" };
}

/** SessionMeta → SessionListItem（时间戳 epoch ms）。 */
export function toItem(m: SessionMeta): SessionListItem {
  return {
    path: m.path,
    id: m.id,
    created: m.created?.getTime(),
    modified: m.modified.getTime(),
    name: m.name,
    preview: m.preview,
    truncated: m.truncated,
  };
}

/** 会话目录布局。 */
export type SessionLayout = "default" | "custom";

/** 列表项元信息。 */
export interface SessionMeta {
  /** 会话文件绝对路径（switch_session 的 sessionPath 即此值）。 */
  path: string;
  /** header.id（uuid）。 */
  id: string;
  /** header.timestamp（无效时缺省）。 */
  created?: Date;
  /** 文件 mtime（排序键，近似最后活动时间）。 */
  modified: Date;
  /** 前 MAX_SCAN_LINES 行内最新 session_info.name。 */
  name?: string;
  /** 首条 user 消息文本预览（截断）。 */
  preview?: string;
  /** 文件行数超过 MAX_SCAN_LINES（name/preview 可能不完整）。 */
  truncated: boolean;
}

/** parseSessionMeta 的解析产物。 */
export interface ParsedSessionMeta {
  id: string;
  created?: Date;
  name?: string;
  preview?: string;
  truncated: boolean;
}

/**
 * 会话目录名编码（对齐 pi：dist/core/session-manager.js 的
 * `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`）。
 * 例：`/home/user/foo` → `--home-user-foo--`；`C:\a\b` → `--C-a-b--`。
 */
export function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * 防御解析单个会话文件内容（前 MAX_SCAN_LINES 行）。
 * - 首行必须是合法 JSON 且 type==="session"（否则整文件视为损坏，返回 null）
 * - session_info 名称取最新一条（含显式清除语义）
 * - 首条 user 消息提取文本预览（content 兼容字符串/数组两种形态）
 * - 坏 JSON 行跳过
 */
export function parseSessionMeta(content: string): ParsedSessionMeta | null {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return null;
  }
  let header: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(lines[0]);
    if (parsed !== null && typeof parsed === "object") {
      header = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  if (!header || header.type !== "session") {
    return null;
  }
  const id = typeof header.id === "string" ? header.id : "";
  if (!id) {
    return null;
  }
  let name: string | undefined;
  let preview: string | undefined;
  const scanCount = Math.min(lines.length - 1, MAX_SCAN_LINES);
  for (let i = 1; i <= scanCount; i++) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") {
        entry = parsed as Record<string, unknown>;
      }
    } catch {
      continue; // 坏行跳过
    }
    if (!entry) {
      continue;
    }
    if (entry.type === "session_info") {
      // 最新一条生效（pi 语义：包括显式清除——name 为空时置 undefined）
      const n = typeof entry.name === "string" ? entry.name.trim() : "";
      name = n || undefined;
      continue;
    }
    if (entry.type !== "message" || preview !== undefined) {
      continue;
    }
    const msg = entry.message as { role?: unknown; content?: unknown } | null | undefined;
    if (!msg || msg.role !== "user") {
      continue;
    }
    const text = extractText(msg.content);
    if (text) {
      preview = normalizePreview(text);
    }
  }
  return {
    id,
    created: parseDate(header.timestamp),
    name,
    preview,
    truncated: lines.length - 1 > MAX_SCAN_LINES,
  };
}

/**
 * 扫描会话目录，返回按修改时间（mtime）倒序的会话列表。
 * - 默认布局：读取 `--<encodeCwd(cwd)>--` 子目录（Windows 上精确目录缺失时
 *   大小写不敏感兜底，实测 `--C--…`/`--c--…` 可能同时存在）；cwd 为空
 *   （no-workspace）时返回空列表
 * - 自定义布局：直接读取根目录下 *.jsonl（pi 对 --session-dir 不建 cwd 子目录）
 * - 损坏文件跳过（parseSessionMeta 返回 null / IO 错误）
 * - 并发解析上限 10（对齐 pi 的 MAX_CONCURRENT_SESSION_INFO_LOADS）
 */
export async function scanSessions(
  sessionsRoot: string,
  cwd: string | undefined,
  layout: SessionLayout = "default",
): Promise<SessionMeta[]> {
  if (!sessionsRoot) {
    return [];
  }
  let dir: string;
  if (layout === "default") {
    if (!cwd) {
      return [];
    }
    const encoded = encodeCwd(cwd);
    const exact = await dirExists(path.join(sessionsRoot, encoded));
    if (exact) {
      dir = exact;
    } else {
      const loose = await resolveDirCaseInsensitive(sessionsRoot, encoded);
      if (!loose) {
        return [];
      }
      dir = loose;
    }
  } else {
    dir = sessionsRoot;
  }

  let files: string[];
  try {
    const names = await fs.readdir(dir);
    files = names.filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
  if (files.length === 0) {
    return [];
  }

  const results: (SessionMeta | null)[] = new Array(files.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const i = next++;
      results[i] = await loadSessionMeta(files[i]);
    }
  };
  const workers = Array.from({ length: Math.min(10, files.length) }, () => worker());
  await Promise.all(workers);

  return results
    .filter((m): m is SessionMeta => m !== null)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function loadSessionMeta(file: string): Promise<SessionMeta | null> {
  try {
    const [stat, content] = await Promise.all([fs.stat(file), fs.readFile(file, "utf8")]);
    const parsed = parseSessionMeta(content);
    if (!parsed) {
      return null;
    }
    return {
      path: file,
      id: parsed.id,
      created: parsed.created,
      modified: stat.mtime,
      name: parsed.name,
      preview: parsed.preview,
      truncated: parsed.truncated,
    };
  } catch {
    return null;
  }
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 提取消息文本：content 为字符串或 [{type:"text",text}] 数组形态（实测真实文件为数组且可能超大）。 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          b !== null &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** 预览规范化：多行压成单行 + 超长截断。 */
function normalizePreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_PREVIEW_CHARS ? `${oneLine.slice(0, MAX_PREVIEW_CHARS)}…` : oneLine;
}

/** 目录存在则返回其路径（规范化大小写），否则 undefined。 */
async function dirExists(dir: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** 大小写不敏感查找子目录（Windows 盘符/路径大小写随传入 cwd 而定）。 */
async function resolveDirCaseInsensitive(root: string, dirName: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const target = dirName.toLowerCase();
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === target);
    return hit ? path.join(root, hit.name) : undefined;
  } catch {
    return undefined;
  }
}
