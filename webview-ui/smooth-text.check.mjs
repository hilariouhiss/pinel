/**
 * smooth-text 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：reveal 节奏逻辑坏掉时编译即红。
 */
import assert from "node:assert";
import { revealAdvance, DEFAULT_REVEAL } from "./src/smooth-text.ts";

const cfg = DEFAULT_REVEAL;
// 小积压：逐步推进（baseStep 3 + floor(积压/40) 追赶 → 100 积压步长 5）
assert.deepStrictEqual(revealAdvance(100, 0, cfg), { next: 5, done: false });
// 步长封顶：积压极大时单帧不超过 maxStep
assert.strictEqual(
  revealAdvance(1000000, 0, { ...cfg, snapThreshold: Number.POSITIVE_INFINITY }).next,
  cfg.maxStep,
);
// 收尾：剩余不足一步时到点即完
assert.deepStrictEqual(revealAdvance(100, 99, cfg), { next: 100, done: true });
// 大积压：直接落位（快照/大块到达不做长动画）
assert.deepStrictEqual(revealAdvance(5000, 100, cfg), { next: 5000, done: true });
// 目标收缩（重置/新消息）：直接对齐
assert.deepStrictEqual(revealAdvance(50, 500, cfg), { next: 50, done: true });
console.log("smooth-text check OK");
