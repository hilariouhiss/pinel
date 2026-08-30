/**
 * ! / !! 终端命令前缀解析（纯逻辑，无 vscode 依赖，可单测）。
 *
 * 语义（对齐 pi 原生 bash 行为）：
 * - 以 `!!` 开头 → excludeFromContext=true：只执行，输出不进 LLM 上下文
 * - 以 `!` 开头 → excludeFromContext=false：执行后输出进入 LLM 上下文
 *   （下一条用户消息随 prompt 送达模型，不立即触发回合）
 * - 前缀后允许可选空白（`!ls` 与 `! ls` 等价）；命令为空 → null（不劫持）
 * - 非前缀开头 → null（普通消息）
 */
export interface ParsedBash {
  command: string;
  excludeFromContext: boolean;
}

export function parseBashInput(text: string): ParsedBash | null {
  const m = /^(!!|!)(\s+)?(.*)$/.exec(text.trim());
  if (!m) {
    return null;
  }
  const command = m[3].trim();
  if (!command) {
    return null;
  }
  return { command, excludeFromContext: m[1] === "!!" };
}
