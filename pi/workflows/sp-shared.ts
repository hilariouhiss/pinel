/**
 * 三条 superpowers 工作流共享件。
 * DIAGNOSIS_OUTCOME：systematic-debugging 无文件产物约定，其根因陈述在最后一条
 * assistant 消息里 — 用全量捕获把叙事知识落盘（rpiv-workflow「carrying knowledge」
 * 路径 3），门禁阶段再读它。pattern `/([\s\S]+)/` 匹配整段最后消息。
 */
import { transcriptPathCollector, typeboxSchema, type Outcome } from "@juicesharp/rpiv-workflow/registration";
import { Type } from "typebox";

export const VERDICT_SCHEMA = Type.Object({
	decision: Type.Union([Type.Literal("approved"), Type.Literal("revise"), Type.Literal("abort")]),
	note: Type.Optional(Type.String()),
});

export const DIAGNOSIS_OUTCOME: Outcome = {
	name: "diagnosis",
	collector: transcriptPathCollector({ pattern: /([\s\S]+)/ }),
};

export const spGateSchema = typeboxSchema(VERDICT_SCHEMA);
