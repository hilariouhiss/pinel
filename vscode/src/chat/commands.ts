import type { SlashCommand } from "../rpc/protocol";

/**
 * 防御解析 get_commands 响应数据（未文档化字段，参照 todos.ts 的防御思路）。
 *
 * 输入是 RPC 响应的 `data` 字段（unknown）。文档漂移风险：docs/rpc.md 示例
 * 写 path/location 字段，pi 0.84.x 实际返回 sourceInfo——本函数只依赖稳定的
 * name/description/source 三字段，其余忽略。
 *
 * 规则：结构不符返回 []；逐项跳过缺失/类型错误；name 须为非空字符串；
 * description/source 仅在同类型时保留（source 归一为 string，pi 未来新增
 * 来源时 webview 有兜底徽标）。
 */
export function parseCommands(data: unknown): SlashCommand[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }
  const raw = (data as { commands?: unknown }).commands;
  if (!Array.isArray(raw)) {
    return [];
  }
  const commands: SlashCommand[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const name = entry.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      continue; // 缺失/非字符串/空白名：跳过该条，不拖垮整个列表
    }
    const parsed: SlashCommand = { name };
    if (typeof entry.description === "string") {
      parsed.description = entry.description;
    }
    if (typeof entry.source === "string") {
      parsed.source = entry.source;
    }
    commands.push(parsed);
  }
  return commands;
}
