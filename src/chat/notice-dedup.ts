/**
 * 相同通知去重（纯逻辑，无 vscode 依赖，可单测）。
 *
 * 背景：pi 会话变更（switch/new/fork）时 session_start 被双重 emit
 * （RPC handler 与 finishSessionReplacement 各 bind 一次），扩展对同一
 * 事件 notify 多次（实测间隔 ~80ms），面板按窗口合并为一条 toast。
 */

export const NOTICE_DEDUP_WINDOW_MS = 300;

/** 与上一条展示过的通知同 level 同文本且落在窗口内 → 判为重复。 */
export function isDuplicateNotice(
  last: { level: string; text: string; at: number } | null,
  level: string,
  text: string,
  nowMs: number,
  windowMs: number = NOTICE_DEDUP_WINDOW_MS,
): boolean {
  return (
    last !== null &&
    last.level === level &&
    last.text === text &&
    nowMs - last.at < windowMs
  );
}
