/** Pinel 推送目标的模块级槽位：pinel.ts 在每个会话事件里写入最新 ctx，
 *  pinel-workflows.ts 的生命周期监听读它。非 Pinel 会话保持 undefined → 静默跳过。 */
let target: unknown;

export function setPinelCtx(ctx: unknown): void {
	target = ctx;
}

export function getPinelCtx(): unknown {
	return target;
}
