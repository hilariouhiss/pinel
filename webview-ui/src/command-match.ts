import type { SlashCommand } from "./types";

/**
 * 弹窗可见谓词：text 以 / 开头且首词尚未结束（全文无空白分隔）。
 * 与 pi 的执行判定（text.startsWith("/")）在提示层解耦：用户输入 `/fix args`
 * 后弹窗已关闭，但 pi 侧仍会把消息当作命令展开执行。
 * 空白含空格/制表/换行——多行或 Shift+Enter 后弹窗自然关闭。
 */
export function isCommandQuery(text: string): boolean {
  return /^\/[^\s]*$/.test(text);
}

/**
 * 斜杠命令候选过滤（纯函数）。
 * - 空查询（仅输入 /）返回全部命令（保持原顺序）
 * - 大小写不敏感；排序：name 前缀命中 > 裸名前缀命中（skill:）> name 子串命中 > 描述命中
 * - skill 命令对裸技能名（去掉 skill: 前缀）也视为 name 命中（用户记不住前缀）
 * - 同一档内保持原列表顺序（稳定）
 */
export function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...commands];
  }
  const scored: Array<{ command: SlashCommand; score: number; index: number }> = [];
  for (let i = 0; i < commands.length; i++) {
    const name = commands[i].name.toLowerCase();
    const bareName = name.startsWith("skill:") ? name.slice("skill:".length) : name;
    const description = (commands[i].description ?? "").toLowerCase();
    let score = -1;
    if (name.startsWith(q)) {
      score = 3;
    } else if (bareName.startsWith(q)) {
      score = 2;
    } else if (name.includes(q) || bareName.includes(q)) {
      score = 1;
    } else if (description.includes(q)) {
      score = 0;
    }
    if (score >= 0) {
      scored.push({ command: commands[i], score, index: i });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.command);
}
