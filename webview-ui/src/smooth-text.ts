/**
 * 流式文本平滑揭示（纯函数，无 React/DOM 依赖；node strip-types 自检覆盖）：
 * 源 delta 突发到达时以逐帧追加方式均匀揭示，视觉匀速；积压越大步长越大
 * （追赶），积压超过阈值直接落位（快照/大块到达不做长动画）。
 */
export interface RevealConfig {
  /** 积压超过该值直接落位。 */
  snapThreshold: number;
  /** 基础步长（字符/帧）。 */
  baseStep: number;
  /** 每积压 N 字符步长 +1（追赶）。 */
  catchUpEvery: number;
  /** 单帧最大步长（防追赶爆炸）。 */
  maxStep: number;
}

export const DEFAULT_REVEAL: RevealConfig = {
  snapThreshold: 600,
  baseStep: 3,
  catchUpEvery: 40,
  maxStep: 160,
};

/** 计算下一帧应揭示到的长度。目标收缩（重置/新消息）或已揭示完成时直接对齐。 */
export function revealAdvance(
  targetLen: number,
  shownLen: number,
  cfg: RevealConfig = DEFAULT_REVEAL,
): { next: number; done: boolean } {
  if (shownLen >= targetLen) {
    return { next: targetLen, done: true };
  }
  const backlog = targetLen - shownLen;
  if (backlog > cfg.snapThreshold) {
    return { next: targetLen, done: true };
  }
  const step = Math.min(
    cfg.maxStep,
    Math.max(1, cfg.baseStep + Math.floor(backlog / cfg.catchUpEvery)),
  );
  const next = Math.min(targetLen, shownLen + step);
  return { next, done: next >= targetLen };
}
