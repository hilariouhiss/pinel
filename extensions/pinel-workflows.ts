/**
 * rpiv-workflow × superpowers 接线 — 本扩展始终激活（与 Pinel 面板无关）：
 *   1. 注册 superpowers 技能契约（provider，惰性求值）
 *   2. 注册三条内置工作流（provider，惰性求值；合并层最低，项目 config 可按名覆盖）
 *   3. 生命周期监听 → Pinel 面板推送 pinel.workflow / pinel.workflows（v:1）
 */
import {
	registerBuiltIns,
	registerBuiltInsProvider,
	registerLifecycle,
	registerSkillContracts,
	registerSkillContractsProvider,
} from "@juicesharp/rpiv-workflow/startup";
import { getPinelCtx } from "./push-target.js";

const GATE_STAGE_PREFIX = "gate-";

function push(ctx: unknown, payload: Record<string, unknown>): void {
	const ui = (ctx as { ui?: { setStatus?: (k: string, v: string) => void; setWidget?: (k: string, v: string[]) => void } })?.ui;
	if (!ui?.setStatus || !ui?.setWidget) return;
	const json = JSON.stringify({ v: 1, ...payload });
	ui.setStatus("pinel.workflow", json);
	ui.setWidget("pinel.workflows", [json]);
}

export default function pinelWorkflowsExtension(_pi: unknown): void {
	registerSkillContractsProvider(async () => {
		const { SP_CONTRACTS } = await import("./contracts.js");
		registerSkillContracts(SP_CONTRACTS, "pi-pinel");
	});

	registerBuiltInsProvider(async () => {
		const { SP_WORKFLOWS } = await import("../workflows/index.js");
		registerBuiltIns(SP_WORKFLOWS);
	});

	registerLifecycle({
		onWorkflowStart: (lc) => push(getPinelCtx(), { runId: lc.runId, workflow: lc.workflow, totalStages: lc.totalStages, status: "running" }),
		onStageStart: (stage, lc) => push(getPinelCtx(), {
			runId: lc.runId, workflow: lc.workflow, totalStages: lc.totalStages,
			status: stage.name.startsWith(GATE_STAGE_PREFIX) ? "awaiting-approval" : "running",
			stage: stage.name, stageNumber: stage.stageNumber,
		}),
		onStageError: (stage, error, lc) => push(getPinelCtx(), {
			runId: lc.runId, workflow: lc.workflow, totalStages: lc.totalStages,
			status: "failed", stage: stage.name, message: String(error),
		}),
		onWorkflowEnd: (result, lc) => {
			push(getPinelCtx(), {
				runId: lc.runId, workflow: lc.workflow, totalStages: lc.totalStages,
				status: result.success ? "done" : "failed",
			});
			const ui = (getPinelCtx() as { ui?: { setWidget?: (k: string, v: string[]) => void } })?.ui;
			ui?.setWidget?.("pinel.workflows", []);
		},
	});
}
