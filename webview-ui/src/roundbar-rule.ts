/**
 * 悬浮条应显示的用户消息解析（纯几何函数，无 DOM/vscode 依赖）。
 *
 * 输入：
 * - relTops: 每条用户消息顶部相对视口顶的偏移（rect.top − 视口顶 y）。
 *   > 0 = 顶部在视口顶之下（尚未被越过）；<= 0 = 已越过（在视口顶之上）。
 *   数组按消息顺序（顶部递增）；null = 元素缺失/位置未知（扫描跳过，保守）。
 * - stickToBottom: 贴底态（视口在底部附近）→ 仅当最近一条已滚出视口
 *   （顶部越过视口顶）时钉住显示；仍在视口内（首条消息刚发送/会话尚短）→ 隐藏；
 *
 * 规则（对齐需求澄清「顶部越过即切换 + 无更多则隐藏」）：
 * - stickToBottom → 最后一条；
 * - 否则取 i = 第一个 relTop > 0 的用户消息（第一条顶部仍在视口顶之下的消息）：
 *   - 不存在（视口顶在所有消息顶部之下，位于最近回合内/之下）→ 最后一条；
 *   - i = 0（视口顶已升到最早消息顶部之上）→ 隐藏；
 *   - 否则 → i − 1（视口顶所在回合的发起消息）。
 *
 * 返回 users 列表索引（0-based）；-1 = 隐藏。
 */
export function resolveVisibleUser(relTops: Array<number | null>, stickToBottom: boolean): number {
  const n = relTops.length;
  if (n === 0) {
    return -1;
  }
  if (stickToBottom) {
    const t = relTops[n - 1];
    // 贴底仅钉住已滚出视口的最近一条；顶部仍在视口内（首条刚发送）→ 隐藏；
    // 元素缺失（null，渲染/流式瞬态）→ 保守钉住。
    return t === null || t <= 0 ? n - 1 : -1;
  }
  for (let i = 0; i < n; i++) {
    const t = relTops[i];
    if (t !== null && t > 0) {
      return i === 0 ? -1 : i - 1;
    }
  }
  return n - 1;
}
