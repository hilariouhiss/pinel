/**
 * superpowers 产物收集器 — docs/superpowers/{specs,plans}/ 与 .rpiv/artifacts/gates/
 * 的转写扫描 + 磁盘佐证回退。模式镜像 rpiv-pi 的 artifact-collector.ts（同一套
 * TEMPERED_SEGMENT 防御与「宣告驱动、磁盘佐证」原则），路径约定换成 superpowers 的。
 */
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	defineCollector,
	defineParser,
	fs as fsHandle,
	transcriptPathCollector,
	type ArtifactCollector,
	type ArtifactParser,
	type BranchEntry,
	type Outcome,
	type ParseContext,
} from "@juicesharp/rpiv-workflow/registration";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const TEMPERED_SEGMENT = String.raw`(?:(?!\.\.)[\w.-])+`;
const BASENAME_PATTERN = new RegExp(String.raw`${TEMPERED_SEGMENT}\.md`, "g");

function basenameCandidates(branch: BranchEntry[], offsetStart?: number): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const start = Math.max(offsetStart ?? 0, 0);
	for (let i = branch.length - 1; i >= start; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j]!;
			if (part.type !== "text" || typeof part.text !== "string") continue;
			const matches = part.text.match(BASENAME_PATTERN) ?? [];
			for (let k = matches.length - 1; k >= 0; k--) {
				const m = matches[k]!;
				if (!seen.has(m)) { seen.add(m); out.push(m); }
			}
		}
	}
	return out;
}

/** 磁盘佐证：唯一的 repo 相对路径命中才接受，歧义/无命中维持原 fatal。 */
function withDiskFallback(primary: ArtifactCollector, under: string): ArtifactCollector {
	return defineCollector({
		collect: async (ctx) => {
			const scanned = await primary.collect(ctx);
			if (scanned.kind === "ok") return scanned;
			for (const basename of basenameCandidates(ctx.branch, ctx.branchOffset)) {
				const root = join(ctx.cwd, under);
				if (!existsSync(root)) continue;
				const hits = readdirSync(root)
					.filter((f) => f === basename && existsSync(join(root, f)));
				if (hits.length === 1) {
					return { kind: "ok", artifacts: [{ handle: fsHandle(join(under, hits[0]!)), role: "primary" }] };
				}
			}
			return scanned;
		},
	});
}

export function spBucketCollector(bucket: "specs" | "plans"): ArtifactCollector {
	const pattern = new RegExp(String.raw`docs/superpowers/${bucket}/${TEMPERED_SEGMENT}\.md`, "g");
	return withDiskFallback(transcriptPathCollector({ pattern }), `docs/superpowers/${bucket}`);
}

export const spGateVerdictCollector: ArtifactCollector = withDiskFallback(
	transcriptPathCollector({ pattern: new RegExp(String.raw`\.rpiv/artifacts/gates/${TEMPERED_SEGMENT}\.md`, "g") }),
	".rpiv/artifacts/gates",
);

export const spFrontmatterParser: ArtifactParser<undefined, "artifact-md", Record<string, unknown>> = defineParser({
	parse(ctx: ParseContext<undefined>) {
		const primary = ctx.artifacts[0];
		if (primary?.handle.kind !== "fs") {
			return { kind: "fatal", message: `${ctx.skill}: spFrontmatterParser requires an fs artifact` };
		}
		const abs = isAbsolute(primary.handle.path) ? primary.handle.path : join(ctx.cwd, primary.handle.path);
		if (!existsSync(abs)) {
			return { kind: "fatal", message: `agent announced ${primary.handle.path} but file does not exist on disk` };
		}
		const content = readFileSync(abs, "utf-8");
		let frontmatter: unknown;
		try {
			({ frontmatter } = parseFrontmatter(content));
		} catch {
			frontmatter = undefined; // malformed YAML → 降级 no-frontmatter，不杀链路
		}
		return {
			kind: "ok",
			payload: {
				kind: "artifact-md",
				data: frontmatter && typeof frontmatter === "object" ? (frontmatter as Record<string, unknown>) : {},
			},
		};
	},
});

export function spArtifactOutcome(bucket: "specs" | "plans"): Outcome<unknown, "artifact-md", Record<string, unknown>> {
	return { name: bucket, collector: spBucketCollector(bucket), parser: spFrontmatterParser };
}

export const spGateOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
	collector: spGateVerdictCollector,
	parser: spFrontmatterParser,
};
