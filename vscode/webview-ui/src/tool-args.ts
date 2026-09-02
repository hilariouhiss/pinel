/**
 * 工具调用 args 直读化纯函数（无 React 依赖，可被 node 自检脚本直接跑）。
 * 展开显示不再贴 JSON 原文：按工具惯例字段直取命令/查询/路径+新内容，
 * 无命中才回退 pretty JSON。
 */

/** 命令类工具的 args 字段（bash / ctx_execute / shell 等）。 */
const COMMAND_FIELDS = ["command", "cmd"] as const;
/** 检索类工具的 args 字段（web_search / source_check / ctx_search 等）。 */
const QUERY_FIELDS = ["query", "queries", "question"] as const;
/** 取链类工具的 args 字段（fetch_content / read 等）。 */
const URL_FIELDS = ["url", "urls"] as const;

function firstString(o: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const f of fields) {
    const v = o[f];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

/**
 * args 原文 → 直读展示文本：
 * command → query → url → path（+ write.content / edit.edits[].newText）→ pretty JSON 回退。
 * 非 JSON 原文原样返回（流式半截 args 走此路径）。
 */
export function describeToolArgs(argsText: string): string {
  if (!argsText) {
    return "";
  }
  let obj: unknown;
  try {
    obj = JSON.parse(argsText);
  } catch {
    return argsText;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return argsText;
  }
  const o = obj as Record<string, unknown>;
  const command = firstString(o, COMMAND_FIELDS);
  if (command !== undefined) {
    return command;
  }
  const query = firstString(o, QUERY_FIELDS);
  if (query !== undefined) {
    return query;
  }
  const url = firstString(o, URL_FIELDS);
  if (url !== undefined) {
    return url;
  }
  const path = firstString(o, ["path"]);
  if (path !== undefined) {
    // 文件写入类：path + 新内容（write.content / edit.edits[].newText），展示要写什么
    const content = firstString(o, ["content"]);
    if (content !== undefined) {
      return `${path}\n\n${content}`;
    }
    if (Array.isArray(o.edits)) {
      const blocks = o.edits
        .map((e) => (e && typeof e === "object" ? firstString(e as Record<string, unknown>, ["newText"]) : undefined))
        .filter((s): s is string => s !== undefined);
      if (blocks.length > 0) {
        return `${path}\n\n${blocks.join("\n\n")}`;
      }
    }
    return path;
  }
  return JSON.stringify(obj, null, 2);
}
