# rpiv-workflow × superpowers 集成（pi-pinel）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 pi-pinel 成为 rpiv-workflow 与 superpowers 的结合点：注册三条内置 `/wf` 工作流编排 superpowers 技能，人工批准门以停靠提问实现，契约/产物在 `docs/superpowers/` 与 `.rpiv/artifacts/` 间桥接，工作流运行状态推送到 Pinel VS Code 面板。

**Architecture:** pi-pinel 新增一个始终激活的扩展文件 `extensions/pinel-workflows.ts`，通过 `@juicesharp/rpiv-workflow/startup` 的注册器注入技能契约（`registerSkillContractsProvider`）、三条内置工作流（`registerBuiltInsProvider`）和生命周期监听（`registerLifecycle`，用于 Pinel 面板推送）。detached 执行宿主来自新增依赖 `@juicesharp/rpiv-pi`（其扩展自注册 `SdkWorkflowHost` 与 lane dock，pi-pinel 不 import 其内部模块）。superpowers 技能按名引用（不捆绑）；其产物路径 `docs/superpowers/{specs,plans}/` 由 pi-pinel 自研 collector 收集；批准门由 pi-pinel 自带技能 `sp-gate` 用 `ask_user_question` 停靠提问，判决写入 `.rpiv/artifacts/gates/` 并以 `match()` 路由 approved / revise / abort。

**Tech Stack:** TypeScript + vitest（node 环境）、typebox、@juicesharp/rpiv-workflow@2.7.1（只从 `/registration` 与 `/startup` 入口导入）、@juicesharp/rpiv-pi@2.7.1（仅依赖）、superpowers 技能（用户已安装，按名引用）。

**Spec:** 无独立 spec 文档——本计划的「设计决策」节即已确认的规格（对应 4 个问卷答案 + 4 个研究补充决策）。

---

## 设计决策（已确认，实现以本节为准）

- **D1 交付形态（用户确认，全选）：** ① 内置 `/wf` 工作流；② 契约与产物桥接（collector + `registerSkillContracts`）；③ Pinel 面板联动（`registerLifecycle` → `ctx.ui.setStatus/setWidget` 推送）。
- **D2 编排范围（用户确认，三条流程）：** 构建流程 `sp-build`（默认工作流）、调试流程 `sp-fix`、评审流程 `sp-review`。
- **D3 批准门（用户确认）：停靠提问。** 门禁阶段运行 `sp-gate` 技能：模型读产物 → 调 `ask_user_question` → 问题停靠在 lane 上，用户在 dock 按 `⏎` 内联回答 → 模型写判决文件。detached 会话中 `ask_user_question` 由 rpiv-pi 的 lane 系统自动停靠（rpiv-pi 既有机制，无需 pi-pinel 实现）。
- **D4 执行宿主（用户确认）：依赖 rpiv-pi。** 新增 `@juicesharp/rpiv-pi@^2.7.1`。其 29 技能/15 子代理/4 工作流会一并安装——接受。
- **D5 superpowers 不捆绑（研究补充）：** npm 上的 `superpowers` 是被抢注的旧包（0.0.2, 2022），obra/superpowers（本地 v6.3.0）未发布。工作流按已安装技能名引用（`brainstorming`、`writing-plans`…）；README 记录安装命令 `pi install git:github.com/obra/superpowers@v6.3.0`。技能缺失时 rpiv-workflow 加载器给出 load issue 提示，README 排障节覆盖。
- **D6 产物双轨（研究补充）：** superpowers 技能照常写 `docs/superpowers/{specs,plans}/`（不改上游）；pi-pinel 的 collector 从转写+磁盘收集这些路径；门禁判决是工作流内部产物，放 `.rpiv/artifacts/gates/`。
- **D7 执行阶段用 `executing-plans`（研究补充）：** 交互检查点由 lane 停靠兜底；想换成 `subagent-driven-development` 的用户在项目 `config.ts` 里写 `skillAliases: { "executing-plans": "subagent-driven-development" }` 一行切换（rpiv-workflow 内建能力，pi-pinel 不实现）。
- **D8 Pinel 面板范围（研究补充）：** pi-pinel 侧只负责 payload 推送与契约（`pinel.workflow` / `pinel.workflows`，v:1）；面板侧渲染在 Pinel VS Code 扩展宿主，不在本仓库。非 Pinel 会话中推送目标缺失 → 静默跳过。

## Global Constraints

- Node ≥ 22；无构建步骤；TypeScript 经 vitest 直接运行。
- 只从 `@juicesharp/rpiv-workflow/registration` 和 `@juicesharp/rpiv-workflow/startup` 两个入口导入；deep import（`…/api.js` 等）跨包边界不受支持。
- **不得** import `@juicesharp/rpiv-pi` 的任何模块——它只是被依赖，让它的扩展自己注册执行宿主与 lanes。
- `@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui` 保持 peerDependencies，不得写入 dependencies。
- 默认工作流名 `sp-build` 由本项目 config 层注册时声明（rpiv-pi 已注册过默认工作流的默认值——本项目 config 是更高合并层，覆盖它）。
- 测试框架 vitest 4.x，无 fixture 框架；每个非平凡模块一个 `*.test.ts`。
- 命名：pi-pinel 自带的东西一律 `sp-` 前缀（技能 `sp-gate`、工作流 `sp-build`/`sp-fix`/`sp-review`），避免与 rpiv-pi 的 29 技能撞名。

## 文件结构

```
pi-pinel/
├── package.json                    # 修改：+rpiv-pi 依赖、pi 清单拆分、devDeps
├── pinel.ts                        # 修改：拆分共享快照工具；仍守 PINEL_PLUGIN 惰性门
├── vitest.config.ts                # 新建：vitest node 环境（仿 rpiv-mono，去掉 coverage 门槛）
├── extensions/
│   ├── push-target.ts              # 新建：Pinel 推送 ctx 的模块级槽位（set/get）
│   ├── collectors.ts               # 新建：docs/superpowers 与 gates 的 collector/parser/outcome
│   ├── collectors.test.ts          # 新建：合成转写驱动的单测
│   ├── contracts.ts                # 新建：superpowers 技能的 rpiv 契约（导出 SP_CONTRACTS）
│   ├── contracts.test.ts           # 新建：契约形状断言
│   ├── pinel-workflows.ts          # 新建：注册契约+工作流+生命周期→Pinel 推送
│   ├── pinel-workflows.test.ts     # 新建：扩展工厂冒烟（stub pi）
│   └── snapshot.ts                 # 新建：buildSnapshot/buildTree/extractText（自 pinel.ts 迁出）
├── workflows/
│   ├── sp-shared.ts                # 新建：VERDICT_SCHEMA、diagnosis/transcript outcome 等共享件
│   ├── sp-build.ts                 # 新建：构建流程（默认工作流）
│   ├── sp-fix.ts                   # 新建：调试流程
│   ├── sp-review.ts                # 新建：评审流程
│   ├── index.ts                    # 新建：SP_WORKFLOWS 汇总导出
│   └── sp-workflows.test.ts        # 新建：三条工作流的图结构断言
├── skills/
│   └── sp-gate/
│       ├── SKILL.md                # 新建：批准门技能（含 contract frontmatter）
│       └── sp-gate.test.ts         # 新建：SKILL.md 结构断言
├── README.md                       # 新建：安装/用法/排障/契约文档
└── docs/superpowers/plans/         # 本计划所在
```

依赖关系：`collectors.ts` ← `sp-shared.ts` ← 工作流文件 ← `pinel-workflows.ts`；`contracts.ts` ← `pinel-workflows.ts`；`push-target.ts` ← `pinel.ts` + `pinel-workflows.ts`；`snapshot.ts` ← `pinel.ts`。

---

### Task 1: 工程骨架与产物收集器

**Files:**
- Modify: `pi-pinel/package.json`
- Create: `pi-pinel/vitest.config.ts`
- Create: `pi-pinel/extensions/collectors.ts`
- Create: `pi-pinel/extensions/collectors.test.ts`

**Interfaces:**
- Consumes: `@juicesharp/rpiv-workflow/registration` 的 `defineCollector` / `defineParser` / `fs` / `transcriptPathCollector`；`parseFrontmatter` 来自 `@earendil-works/pi-coding-agent`（peer dep）。
- Produces（后续任务依赖的确切名字）：
  - `spBucketCollector(bucket: "specs" | "plans"): ArtifactCollector` — 只收 `docs/superpowers/<bucket>/<file>.md`
  - `spGateVerdictCollector: ArtifactCollector` — 只收 `.rpiv/artifacts/gates/<file>.md`
  - `spFrontmatterParser: ArtifactParser` — YAML frontmatter → `Record<string, unknown>`，malformed YAML 降级 `{}`，文件不存在 fatal
  - `spArtifactOutcome(bucket): Outcome` — `{ name: bucket, collector: spBucketCollector(bucket), parser: spFrontmatterParser }`（同 bucket 多阶段收敛到同一命名槽）
  - `spGateOutcome: Outcome` — `{ collector: spGateVerdictCollector, parser: spFrontmatterParser }`（不带 name，各门禁按 stage 记录键发布）

- [ ] **Step 1: 修改 package.json**

```json
{
  "dependencies": {
    "@juicesharp/rpiv-pi": "^2.7.1",
    "@juicesharp/rpiv-workflow": "^2.7.1"
  },
  "devDependencies": {
    "@types/node": "22.20.1",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  },
  "pi": {
    "extensions": ["./pinel.ts", "./extensions/*.ts"],
    "skills": ["./skills"]
  }
}
```

说明：现有 deps 全部保留；只新增 rpiv-pi 与 devDeps、改写 `pi` 清单（其余 `@juicesharp/*` 依赖不动）。

- [ ] **Step 2: 创建 vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["extensions/**/*.test.ts", "workflows/**/*.test.ts", "skills/**/*.test.ts"],
		testTimeout: 15_000,
		passWithNoTests: true,
	},
});
```

- [ ] **Step 3: 写失败测试 extensions/collectors.test.ts**

```ts
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	spArtifactOutcome, spBucketCollector, spFrontmatterParser, spGateOutcome,
} from "./collectors.js";
import type { BranchEntry } from "@juicesharp/rpiv-workflow/registration";

function assistantEntry(text: string): BranchEntry {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

const TMP = join(process.cwd(), ".tmp-collectors");

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("spBucketCollector", () => {
	it("收集转写里宣告的 docs/superpowers/plans 路径", async () => {
		const branch = [
			assistantEntry("计划已写入 docs/superpowers/plans/2026-08-29-demo.md，请审核。"),
		];
		const result = await spBucketCollector("plans").collect({ cwd: TMP, branch, branchOffset: 0, skill: "writing-plans" });
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.artifacts[0]?.handle).toEqual({ kind: "fs", path: "docs/superpowers/plans/2026-08-29-demo.md" });
		}
	});

	it("完整路径扫描失败时，磁盘佐证的 basename 回退生效", async () => {
		const dir = join(TMP, "docs", "superpowers", "plans");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "2026-08-29-fallback.md"), "# plan\n");
		const branch = [assistantEntry("产物见 2026-08-29-fallback.md")]; // 目录前缀被模型说丢
		const result = await spBucketCollector("plans").collect({ cwd: TMP, branch, branchOffset: 0, skill: "writing-plans" });
		expect(result.kind).toBe("ok");
	});

	it("错误 bucket 的路径被拒绝", async () => {
		const branch = [assistantEntry("见 docs/superpowers/specs/2026-08-29-x.md")];
		const result = await spBucketCollector("plans").collect({ cwd: TMP, branch, branchOffset: 0, skill: "writing-plans" });
		expect(result.kind).toBe("fatal");
	});
});

describe("spGateVerdictCollector", () => {
	it("收集 .rpiv/artifacts/gates 判决路径", async () => {
		const branch = [assistantEntry("判决：.rpiv/artifacts/gates/2026-08-29-1022-gate-plan.md")];
		const result = await spGateOutcome.collector.collect({ cwd: TMP, branch, branchOffset: 0, skill: "sp-gate" });
		expect(result.kind).toBe("ok");
	});
});

describe("spFrontmatterParser", () => {
	it("解析 frontmatter；malformed YAML 降级为 {}", async () => {
		const dir = join(TMP, ".rpiv", "artifacts", "gates");
		mkdirSync(dir, { recursive: true });
		const good = join(dir, "g.md");
		writeFileSync(good, "---\ndecision: approved\nnote: ok\n---\nbody");
		const ok = await spFrontmatterParser.parse({ cwd: TMP, skill: "sp-gate", artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/gates/g.md" }, role: "primary" }] });
		expect(ok.kind).toBe("ok");
		if (ok.kind === "ok") expect(ok.payload.data.decision).toBe("approved");

		const bad = join(dir, "b.md");
		writeFileSync(bad, "---\ntarget: foo (lane UI: L0–L2)\n---\nbody");
		const deg = await spFrontmatterParser.parse({ cwd: TMP, skill: "sp-gate", artifacts: [{ handle: { kind: "fs", path: ".rpiv/artifacts/gates/b.md" }, role: "primary" }] });
		expect(deg.kind).toBe("ok");
		if (deg.kind === "ok") expect(deg.payload.data).toEqual({});
	});
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `cd pi-pinel && npm install && npx vitest run extensions/collectors.test.ts`
Expected: FAIL — `Cannot find module './collectors.js'`

- [ ] **Step 5: 实现 extensions/collectors.ts**

```ts
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

export function spArtifactOutcome(bucket: "specs" | "plans"): Outcome<undefined, "artifact-md", Record<string, unknown>> {
	return { name: bucket, collector: spBucketCollector(bucket), parser: spFrontmatterParser };
}

export const spGateOutcome: Outcome<undefined, "artifact-md", Record<string, unknown>> = {
	collector: spGateVerdictCollector,
	parser: spFrontmatterParser,
};
```

注：`ParseContext` 的 `artifacts` 元素形状（`{handle, role}`）与 `fsHandle` 的返回（`{kind:"fs", path}`）以 rpiv-pi artifact-collector.ts 为参照；若 `@juicesharp/rpiv-workflow/registration` 类型名有出入，以 tsc/vitest 编译报错为准对齐（这是本步骤的验证机制）。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run extensions/collectors.test.ts`
Expected: PASS（4 个测试全绿）

- [ ] **Step 7: Commit**

```bash
git add package.json vitest.config.ts extensions/collectors.ts extensions/collectors.test.ts
git commit -m "feat(pi-pinel): superpowers/gates artifact collectors with disk-corroborated fallback"
```

---

### Task 2: superpowers 技能契约

**Files:**
- Create: `pi-pinel/extensions/contracts.ts`
- Create: `pi-pinel/extensions/contracts.test.ts`

**Interfaces:**
- Consumes: `registerSkillContracts`（Task 5 用，本任务只产出数据）。
- Produces: `SP_CONTRACTS: ReadonlyArray<readonly [string, SkillContract]>` — 键为技能安装名，`source: "declared"`；Task 5 的 provider 将其注册，owner `"pi-pinel"`。

- [ ] **Step 1: 写失败测试 extensions/contracts.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { SP_CONTRACTS } from "./contracts.js";

describe("SP_CONTRACTS", () => {
	it("覆盖 5 个产物流技能且形状合法", () => {
		const map = new Map(SP_CONTRACTS);
		expect([...map.keys()].sort()).toEqual([
			"brainstorming", "executing-plans", "finishing-a-development-branch",
			"verification-before-completion", "writing-plans",
		]);
		for (const [name, contract] of SP_CONTRACTS) {
			expect(contract.source).toBe("declared");
			const kinds = [
				...(contract.produces ? [contract.produces.meta?.artifactKind] : []),
				...(contract.consumes ? [contract.consumes.meta?.artifactKind] : []),
			].flat();
			for (const kind of kinds) expect(["specs", "plans"]).toContain(kind);
		}
	});
	it("brainstorming 产出 specs；writing-plans 消费 specs 产出 plans；executing-plans 消费 plans", () => {
		const map = new Map(SP_CONTRACTS);
		expect(map.get("brainstorming")?.produces?.meta?.artifactKind).toBe("specs");
		expect(map.get("writing-plans")?.produces?.meta?.artifactKind).toBe("plans");
		expect(map.get("writing-plans")?.consumes?.meta?.artifactKind).toEqual(["specs"]);
		expect(map.get("executing-plans")?.consumes?.meta?.artifactKind).toEqual(["plans"]);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extensions/contracts.test.ts`
Expected: FAIL — `Cannot find module './contracts.js'`

- [ ] **Step 3: 实现 extensions/contracts.ts**

```ts
/**
 * superpowers 技能的 rpiv 契约 — 只声明产物流的 artifactKind 通道（specs/plans），
 * 不声明 data schema：组合检查是保守的（缺 schema ⇒ ok），数据校验由工作流各
 * stage 自己的 outcome/outputSchema 承担，这里不重复声明。
 * 调试/评审流技能（systematic-debugging 等）无文件产物约定，不注册契约。
 */
import type { SkillContract } from "@juicesharp/rpiv-workflow/registration";

export const SP_CONTRACTS: ReadonlyArray<readonly [string, SkillContract]> = [
	["brainstorming", {
		source: "declared",
		produces: { kind: "produces", meta: { artifactKind: "specs" } },
	}],
	["writing-plans", {
		source: "declared",
		consumes: { meta: { artifactKind: ["specs"] } },
		produces: { kind: "produces", meta: { artifactKind: "plans" } },
	}],
	["executing-plans", {
		source: "declared",
		consumes: { meta: { artifactKind: ["plans"] } },
	}],
	["verification-before-completion", {
		source: "declared",
		consumes: { meta: { artifactKind: ["plans"] } },
	}],
	["finishing-a-development-branch", {
		source: "declared",
		consumes: { meta: { artifactKind: ["plans"] } },
	}],
];
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run extensions/contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extensions/contracts.ts extensions/contracts.test.ts
git commit -m "feat(pi-pinel): rpiv skill contracts for superpowers artifact flow"
```

---

### Task 3: 批准门技能 sp-gate

**Files:**
- Create: `pi-pinel/skills/sp-gate/SKILL.md`
- Create: `pi-pinel/skills/sp-gate/sp-gate.test.ts`

**Interfaces:**
- Consumes: 作为 `/skill:sp-gate` 被 runner 派发；输入（labelled-flag 形式）含上游命名通道的产物路径；可调用 `ask_user_question` 工具（rpiv-ask-user-question，已在 pi-pinel deps）。
- Produces: 判决文件 `.rpiv/artifacts/gates/<YYYY-MM-DD-HHmm>-<gate>.md`，frontmatter `decision: approved|revise|abort`、`note`、`artifact`；最终消息宣告该路径（spGateVerdictCollector 收集；outputSchema 校验 `decision`）。契约 frontmatter `contract.produces`：`artifactKind: gates` + data schema（见下），供 `match("decision", …)` 路由。

- [ ] **Step 1: 写失败测试 skills/sp-gate/sp-gate.test.ts**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const raw = readFileSync(join(process.cwd(), "skills", "sp-gate", "SKILL.md"), "utf-8");
const { frontmatter, content } = parseFrontmatter(raw) as { frontmatter: any; content: string };

describe("sp-gate SKILL.md", () => {
	it("frontmatter 具备工作流所需的全部字段", () => {
		expect(frontmatter.name).toBe("sp-gate");
		expect(frontmatter["disable-model-invocation"]).toBe(true);
		expect(frontmatter.contract.produces.meta.artifactKind).toBe("gates");
		const decision = frontmatter.contract.produces.data.properties.decision;
		expect(decision.enum).toEqual(["approved", "revise", "abort"]);
	});
	it("正文包含三要素：读产物、ask_user_question、写判决文件", () => {
		expect(content).toMatch(/ask_user_question/);
		expect(content).toMatch(/\.rpiv\/artifacts\/gates\//);
		expect(content).toMatch(/decision:\s*(approved|revise|abort)/);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run skills/sp-gate/sp-gate.test.ts`
Expected: FAIL — ENOENT（文件不存在）

- [ ] **Step 3: 实现 skills/sp-gate/SKILL.md**

```markdown
---
name: sp-gate
description: Workflow-only approval gate — reads the upstream superpowers artifact, asks the user approve/revise/abort via ask_user_question, writes the verdict to .rpiv/artifacts/gates/ and announces its path. Used by pi-pinel's sp-build / sp-fix workflows.
argument-hint: "[artifact path from upstream stage]"
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: gates
    data:
      type: object
      properties:
        decision:
          enum: [approved, revise, abort]
        note:
          type: string
      required: [decision]
---

# sp-gate — 批准门

你是 pi-pinel 工作流的批准门。上游阶段已产出一份 superpowers 产物，你负责让用户批准、要求修改或中止。

## Steps

1. **读产物。** 输入里带 `--<channel>` 标签的路径（如 `--specs` / `--plans` / `--diagnosis`）是待批准产物。用 Read 工具**完整**读取每个文件（不用 limit/offset）。
2. **写摘要。** 3-5 条要点：产物是什么、关键决策、风险点、下一步。
3. **提问。** 调 `ask_user_question` 工具，单问：

   - question: "产物 `<path>` 是否批准进入下一阶段？"
   - options（2-3 项，第一项为推荐）:
     - "批准 (Recommended)" — 进入下一阶段
     - "要求修改" — 打回上游阶段重做，你的补充要求将附在判决里
     - "中止" — 结束本次运行
   - 等待用户回答（detached 会话中问题停靠在 lane，用户按 ⏎ 回答）。

4. **写判决文件** `.rpiv/artifacts/gates/<当前UTC时间 YYYY-MM-DD-HHmm>-<门名>.md`：

   ```markdown
   ---
   decision: approved  # 或 revise / abort，与用户选择严格一致
   note: <用户补充要求；无则写 "-">
   artifact: <被批准的产物 repo 相对路径>
   ---

   ## 摘要

   <第 2 步的要点>
   ```

   门名取输入标签对应的渠道（specs → gate-spec，plans → gate-plan，diagnosis → gate-diagnosis）。目录不存在就创建。

5. **宣告。** 最终消息只输出判决路径原文，一行：`.rpiv/artifacts/gates/<file>.md`。不要省略目录前缀、不要加代码围栏。
```

（正文 `---` frontmatter 里的 `decision:` 枚举与 data schema 保持一致；这是 `match()` 路由的字段来源。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run skills/sp-gate/sp-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/sp-gate/
git commit -m "feat(pi-pinel): sp-gate approval-gate skill (parked ask_user_question + verdict file)"
```

---

### Task 4: 三条内置工作流

**Files:**
- Create: `pi-pinel/workflows/sp-shared.ts`
- Create: `pi-pinel/workflows/sp-build.ts`
- Create: `pi-pinel/workflows/sp-fix.ts`
- Create: `pi-pinel/workflows/sp-review.ts`
- Create: `pi-pinel/workflows/index.ts`
- Create: `pi-pinel/workflows/sp-workflows.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `spArtifactOutcome` / `spGateOutcome`；`transcriptPathCollector`、`typeboxSchema`、`Type`。
- Produces:
  - `VERDICT_SCHEMA`（sp-shared）：`Type.Object({ decision: Type.Union([Type.Literal("approved"), Type.Literal("revise"), Type.Literal("abort")]) })`
  - `DIAGNOSIS_OUTCOME: Outcome` — `{ name: "diagnosis", collector: transcriptPathCollector({ pattern: /([\s\S]+)/ }) }`，捕获 systematic-debugging 最后一条 assistant 消息全文（含根因陈述）
  - `spBuild` / `spFix` / `spReview: Workflow`；`SP_WORKFLOWS: readonly Workflow[]`（index.ts，顺序 sp-build、sp-fix、sp-review；sp-build 声明为默认工作流候选）

设计要点（写进代码注释）：
- 发布名解析：`stage.publishes ?? outcome.name ?? record-key`。`spArtifactOutcome("specs")` 带 `name: "specs"` ⇒ 门禁阶段用 `reads: ["specs"]` 读取。门禁阶段用 `spGateOutcome`（无 name）⇒ 按记录键发布，互不覆盖。
- 向后跳转（revise 打回）合法但有上限 `MAX_BACKWARD_JUMPS = 3`——sp-build 两个门各一次打回，最坏 2 跳，安全。
- 全 `acts()` 且无 `produces()` 的流程会让第二个非 terminal 阶段以 `FAIL_MISSING_ARTIFACT` 停机（rpiv-workflow 规则）⇒ 每条工作流的首阶段必须是 `produces` 或有产物，sp-review 的 requesting-code-review 因而配 `transcriptPathCollector` 产物（review 请求摘要）。
- 阶段键名 = 技能安装名（`brainstorming` 等），门禁阶段键名 `gate-*` 用 `skill: "sp-gate"` 覆盖。

- [ ] **Step 1: 写失败测试 workflows/sp-workflows.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { SP_WORKFLOWS } from "./index.js";

describe("SP_WORKFLOWS 图结构", () => {
	it("恰好三条，sp-build 在前（默认工作流候选）", () => {
		expect(SP_WORKFLOWS.map((w) => w.name)).toEqual(["sp-build", "sp-fix", "sp-review"]);
	});
	for (const wf of SP_WORKFLOWS) {
		it(`${wf.name}: start/edges 引用合法，门禁有 outputSchema 且 match 路由齐全`, () => {
			const stageNames = new Set(Object.keys(wf.stages));
			expect(stageNames.has(wf.start)).toBe(true);
			for (const [from, edge] of Object.entries(wf.edges)) {
				expect(stageNames.has(from)).toBe(true);
				if (typeof edge === "string") {
					expect(edge === "stop" || stageNames.has(edge)).toBe(true);
				} else {
					// defineRoute 产物：.targets 枚举所有可能分支
					for (const t of (edge as { targets?: string[] }).targets ?? []) {
						expect(t === "stop" || stageNames.has(t)).toBe(true);
					}
				}
			}
			for (const [name, stage] of Object.entries(wf.stages)) {
				if (name.startsWith("gate-")) {
					expect((stage as { skill?: string }).skill).toBe("sp-gate");
					expect((stage as { outputSchema?: unknown }).outputSchema).toBeDefined();
				}
			}
		});
	}
	it("sp-build 两个门禁的 match 分支：approved 前进 / revise 打回 / abort 停止", () => {
		const build = SP_WORKFLOWS[0]!;
		const gateSpec = build.edges["gate-spec"] as { targets?: string[] };
		expect(gateSpec.targets).toContain("writing-plans");
		expect(gateSpec.targets).toContain("brainstorming");
		const gatePlan = build.edges["gate-plan"] as { targets?: string[] };
		expect(gatePlan.targets).toContain("executing-plans");
		expect(gatePlan.targets).toContain("writing-plans");
	});
	it("每条工作流的首阶段都有 outcome（规避 FAIL_MISSING_ARTIFACT）", () => {
		for (const wf of SP_WORKFLOWS) {
			const first = wf.stages[wf.start] as { outcome?: unknown };
			expect(first.outcome).toBeDefined();
		}
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run workflows/sp-workflows.test.ts`
Expected: FAIL — `Cannot find module './index.js'`

- [ ] **Step 3: 实现 workflows/sp-shared.ts**

```ts
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
```

- [ ] **Step 4: 实现 workflows/sp-build.ts**

```ts
import { acts, defineWorkflow, match, produces, terminal } from "@juicesharp/rpiv-workflow/registration";
import { spArtifactOutcome, spGateOutcome } from "../extensions/collectors.js";
import { spGateSchema } from "./sp-shared.js";

/** 构建流程（默认工作流）：brainstorming → 设计批准 → writing-plans → 计划批准 → executing-plans → 验证 → 收尾。 */
export const spBuild = defineWorkflow({
	name: "sp-build",
	description: "superpowers 构建流程：构思 → 设计批准 → 写计划 → 计划批准 → 执行 → 验证 → 收尾（revise 打回上一阶段，abort 停止）",
	start: "brainstorming",
	stages: {
		brainstorming: produces({ outcome: spArtifactOutcome("specs") }),
		"gate-spec": produces({ skill: "sp-gate", outcome: spGateOutcome, reads: ["specs"], outputSchema: spGateSchema }),
		"writing-plans": produces({ outcome: spArtifactOutcome("plans"), reads: ["specs"] }),
		"gate-plan": produces({ skill: "sp-gate", outcome: spGateOutcome, reads: ["plans"], outputSchema: spGateSchema }),
		"executing-plans": acts({ reads: ["plans"] }),
		"verification-before-completion": acts({ reads: ["plans"] }),
		"finishing-a-development-branch": terminal(),
	},
	edges: {
		brainstorming: "gate-spec",
		"gate-spec": match("decision",
			{ "writing-plans": "approved", brainstorming: "revise", stop: "abort" },
			{ fallback: "stop" }),
		"writing-plans": "gate-plan",
		"gate-plan": match("decision",
			{ "executing-plans": "approved", "writing-plans": "revise", stop: "abort" },
			{ fallback: "stop" }),
		"executing-plans": "verification-before-completion",
		"verification-before-completion": "finishing-a-development-branch",
		"finishing-a-development-branch": "stop",
	},
});
```

- [ ] **Step 5: 实现 workflows/sp-fix.ts**

```ts
import { acts, defineWorkflow, match, produces, terminal } from "@juicesharp/rpiv-workflow/registration";
import { spGateOutcome } from "../extensions/collectors.js";
import { DIAGNOSIS_OUTCOME, spGateSchema } from "./sp-shared.js";

/** 调试流程：systematic-debugging → 诊断批准 → test-driven-development → 验证 → 收尾。 */
export const spFix = defineWorkflow({
	name: "sp-fix",
	description: "superpowers 调试流程：根因定位 → 诊断批准 → TDD 修复 → 验证 → 收尾",
	start: "systematic-debugging",
	stages: {
		"systematic-debugging": produces({ outcome: DIAGNOSIS_OUTCOME }),
		"gate-diagnosis": produces({ skill: "sp-gate", outcome: spGateOutcome, reads: ["diagnosis"], outputSchema: spGateSchema }),
		"test-driven-development": acts({ reads: ["diagnosis"] }),
		"verification-before-completion": acts(),
		"finishing-a-development-branch": terminal(),
	},
	edges: {
		"systematic-debugging": "gate-diagnosis",
		"gate-diagnosis": match("decision",
			{ "test-driven-development": "approved", "systematic-debugging": "revise", stop: "abort" },
			{ fallback: "stop" }),
		"test-driven-development": "verification-before-completion",
		"verification-before-completion": "finishing-a-development-branch",
		"finishing-a-development-branch": "stop",
	},
});
```

- [ ] **Step 6: 实现 workflows/sp-review.ts**

```ts
import { acts, defineWorkflow, produces } from "@juicesharp/rpiv-workflow/registration";
import { transcriptPathCollector } from "@juicesharp/rpiv-workflow/registration";
import { DIAGNOSIS_OUTCOME } from "./sp-shared.js";

/** 评审流程：requesting-code-review → receiving-code-review → 验证。全 acts 链会被
 *  FAIL_MISSING_ARTIFACT 停机，故首阶段配全量转写产物（评审请求摘要），命名槽 review-request。 */
const REVIEW_REQUEST_OUTCOME = {
	name: "review-request",
	collector: transcriptPathCollector({ pattern: /([\s\S]+)/ }),
};

export const spReview = defineWorkflow({
	name: "sp-review",
	description: "superpowers 评审流程：请求评审 → 吸收反馈 → 验证（全程由 reviewer 通过停靠提问交互）",
	start: "requesting-code-review",
	stages: {
		"requesting-code-review": produces({ outcome: REVIEW_REQUEST_OUTCOME }),
		"receiving-code-review": acts({ reads: ["review-request"] }),
		"verification-before-completion": acts(),
	},
	edges: {
		"requesting-code-review": "receiving-code-review",
		"receiving-code-review": "verification-before-completion",
		"verification-before-completion": "stop",
	},
});
```

- [ ] **Step 7: 实现 workflows/index.ts**

```ts
import { spBuild } from "./sp-build.js";
import { spFix } from "./sp-fix.js";
import { spReview } from "./sp-review.js";

export const SP_WORKFLOWS = [spBuild, spFix, spReview] as const;
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run workflows/sp-workflows.test.ts`
Expected: PASS（若 DSL 类型/运行时报错——如 `transcriptPathCollector` 参数形状、`match` targets 元数据缺失——按编译错误对齐 rpiv-workflow/registration 的实际签名后再跑绿）

- [ ] **Step 9: Commit**

```bash
git add workflows/
git commit -m "feat(pi-pinel): sp-build/sp-fix/sp-review built-in workflows chaining superpowers skills"
```

---

### Task 5: 扩展接线与 Pinel 面板推送

**Files:**
- Create: `pi-pinel/extensions/push-target.ts`
- Create: `pi-pinel/extensions/snapshot.ts`（自 pinel.ts 迁出 `buildSnapshot`/`buildTree`/`extractText`，原文不动）
- Create: `pi-pinel/extensions/pinel-workflows.ts`
- Create: `pi-pinel/extensions/pinel-workflows.test.ts`
- Modify: `pi-pinel/pinel.ts`

**Interfaces:**
- Consumes: `registerBuiltInsProvider` / `registerSkillContractsProvider` / `registerLifecycle` / `registerBuiltIns` / `registerSkillContracts`（全部来自 `@juicesharp/rpiv-workflow/startup`）；Task 2 `SP_CONTRACTS`；Task 4 `SP_WORKFLOWS`；`getPinelCtx`。
- Produces:
  - `setPinelCtx(ctx)` / `getPinelCtx(): unknown`（push-target.ts，模块级槽位）
  - Pinel payload 契约 v:1（推送 `ctx.ui.setStatus("pinel.workflow", JSON)` 与 `ctx.ui.setWidget("pinel.workflows", [JSON])`）：
    - `{ v: 1, runId, workflow, totalStages, status: "running"|"awaiting-approval"|"done"|"failed", stage?, stageNumber?, message? }`
    - `status: "awaiting-approval"`：当前阶段名以 `gate-` 开头（onStageStart 时判定）
    - `onWorkflowEnd`：`status: result.ok ? "done" : "failed"`，随后 `setWidget("pinel.workflows", [])` 清空
    - 无 Pinel ctx（非 Pinel 会话）时静默跳过全部推送

- [ ] **Step 1: 写失败测试 extensions/pinel-workflows.test.ts**

```ts
import { describe, expect, it, vi } from "vitest";
import pinelWorkflowsExtension from "./pinel-workflows.js";

// /startup 注册器是 Symbol.for 全局槽——stub 掉注册调用，冒烟验证工厂接线即可。
vi.mock("@juicesharp/rpiv-workflow/startup", () => {
	const fn = () => {};
	return {
		registerBuiltInsProvider: vi.fn(),
		registerSkillContractsProvider: vi.fn(),
		registerLifecycle: vi.fn((l: unknown) => l),
		registerBuiltIns: vi.fn(),
		registerSkillContracts: vi.fn(),
	};
});

describe("pinel-workflows 扩展工厂", () => {
	it("无 PINEL_PLUGIN 也注册工作流/契约/生命周期（不抛错）", async () => {
		delete process.env.PINEL_PLUGIN;
		const pi = { on: vi.fn(), registerCommand: vi.fn() };
		expect(() => pinelWorkflowsExtension(pi as never)).not.toThrow();
		const startup = await import("@juicesharp/rpiv-workflow/startup");
		expect(startup.registerBuiltInsProvider).toHaveBeenCalled();
		expect(startup.registerSkillContractsProvider).toHaveBeenCalled();
		expect(startup.registerLifecycle).toHaveBeenCalled();
	});

	it("provider 求值后注册 3 条工作流与 5 份契约", async () => {
		const startup = await import("@juicesharp/rpiv-workflow/startup");
		const providers = (startup.registerBuiltInsProvider as unknown as ReturnType<typeof vi.fn>).mock.calls.flat();
		const contracts = (startup.registerSkillContractsProvider as unknown as ReturnType<typeof vi.fn>).mock.calls.flat();
		await providers[0]();
		await contracts[0]();
		expect(startup.registerBuiltIns).toHaveBeenCalled();
		const wfs = (startup.registerBuiltIns as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(wfs.map((w: { name: string }) => w.name)).toEqual(["sp-build", "sp-fix", "sp-review"]);
		expect(startup.registerSkillContracts).toHaveBeenCalled();
		const pairs = (startup.registerSkillContracts as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(pairs).toHaveLength(5);
		expect((startup.registerSkillContracts as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe("pi-pinel");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run extensions/pinel-workflows.test.ts`
Expected: FAIL — `Cannot find module './pinel-workflows.js'`

- [ ] **Step 3: 实现 extensions/push-target.ts**

```ts
/** Pinel 推送目标的模块级槽位：pinel.ts 在每个会话事件里写入最新 ctx，
 *  pinel-workflows.ts 的生命周期监听读它。非 Pinel 会话保持 undefined → 静默跳过。 */
let target: unknown;

export function setPinelCtx(ctx: unknown): void {
	target = ctx;
}

export function getPinelCtx(): unknown {
	return target;
}
```

- [ ] **Step 4: 迁移 snapshot.ts 并修改 pinel.ts**

`extensions/snapshot.ts` = 原 `pinel.ts` 的 `buildSnapshot` / `buildTree` / `extractText` 三个函数原样迁入并 `export`。`pinel.ts` 改为：

```ts
import { buildSnapshot, buildTree } from "./extensions/snapshot.js";
import { setPinelCtx } from "./extensions/push-target.js";

const VERSION = "0.1.0";

export default function (pi: any) {
  if (process.env.PINEL_PLUGIN !== "1") {
    return; // 非 Pinel 面板会话：完全惰性
  }

  const PUSH_EVENTS = [ /* 原列表不动 */ ];

  function pushState(ctx: any) {
    ctx.ui.setStatus("pinel.state", JSON.stringify(buildSnapshot(ctx)));
    ctx.ui.setWidget("pinel.tree", [JSON.stringify(buildTree(ctx))]);
  }

  for (const name of PUSH_EVENTS) {
    pi.on(name, (_ev: any, ctx: any) => {
      if (ctx?.mode !== "rpc") return;
      setPinelCtx(ctx); // ← 新增：供 pinel-workflows 生命周期推送复用
      pushState(ctx);
    });
  }

  /* pinel-state / pinel-tree 命令注册原样不动（handler 内同样先 setPinelCtx(ctx)） */
}
```

- [ ] **Step 5: 实现 extensions/pinel-workflows.ts**

```ts
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
				status: result.ok ? "done" : "failed",
			});
			const ui = (getPinelCtx() as { ui?: { setWidget?: (k: string, v: string[]) => void } })?.ui;
			ui?.setWidget?.("pinel.workflows", []);
		},
	});
}
```

注：生命周期回调的参数次序/`LifecycleContext` 字段名以 `@juicesharp/rpiv-workflow/startup` 类型为准（Task 1 的 TypeScript 检查机制同样适用）；若 `result` 无 `ok` 字段，改用 runner 文档化字段（`RunWorkflowResult`），以编译错误为对齐信号。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run extensions/pinel-workflows.test.ts`
Expected: PASS（`vi.mock` 使真实 provider 与生命周期签名暂不参与——真实签名在 Task 6 的端到端验收中验证）

- [ ] **Step 7: Commit**

```bash
git add extensions/ pinel.ts
git commit -m "feat(pi-pinel): register sp workflows/contracts always-on; push run state to Pinel panel"
```

---

### Task 6: README 与端到端验收

**Files:**
- Create: `pi-pinel/README.md`
- （无代码变更；端到端为手工验收清单）

**Interfaces:** 无新接口。本任务交付文档与验收记录。

- [ ] **Step 1: 编写 README.md**（内容要点，全量写入文件）

```markdown
# @hilariouhiss/pinel — Pinel 桥 + superpowers×rpiv-workflow 集成包

## 它是什么

两部分：
1. Pinel VS Code 面板桥（原有）：PINEL_PLUGIN=1 的 rpc 会话里推送会话状态/消息树。
2. superpowers × rpiv-workflow 集成（新增）：三条内置 /wf 工作流，把 superpowers
   技能编排成可停靠、可恢复的多阶段流水线；运行状态推送到 Pinel 面板。

## 安装

pi install <本包路径或 npm 源>
pi install git:github.com/obra/superpowers@v6.3.0   # 工作流按名引用这些技能
# rpiv-pi / rpiv-workflow / rpiv-ask-user-question 等随本包依赖自动安装
# 重启 pi

## 用法

/wf sp-build "给 export 命令加 --json 标志"   # 构建流程（默认工作流）
/wf sp-fix  "<bug 症状描述>"                    # 调试流程
/wf sp-review "<评审上下文>"                    # 评审流程

### 批准门（停靠提问）

gate-* 阶段会读上游产物（docs/superpowers/specs|plans/ 或诊断捕获），然后调
ask_user_question 提问。detached 运行中问题停靠在 lane 上——ctrl+q 打开 lane dock，
⏎ 内联回答：批准 / 要求修改（打回上游阶段重做）/ 中止。

### 产物布局

- superpowers 技能照常写 docs/superpowers/specs/ 与 docs/superpowers/plans/
- 门禁判决写 .rpiv/artifacts/gates/（frontmatter decision: approved|revise|abort）
- 运行轨迹 .rpiv/workflows/runs/<run-id>.jsonl；/wf @<run-id> 随时恢复

### 自定义

- 换执行方式（subagent-driven-development 需已装 pi-subagents）：
  项目 .rpiv/workflows/config.ts 里 skillAliases: { "executing-plans": "subagent-driven-development" }
- 覆盖内置工作流：项目 config.ts 里同名 defineWorkflow（合并层高于内置层）

### Pinel 面板 payload 契约（v:1）

pinel.workflow 状态行 / pinel.workflows 挂件，JSON：
{ v:1, runId, workflow, totalStages, status: running|awaiting-approval|done|failed, stage?, stageNumber?, message? }

### 排障

- /wf 报技能缺失：superpowers 未装或版本无该技能 → 装 git:github.com/obra/superpowers@v6.3.0
- 阶段卡在停靠提问没人答：ctrl+q 打开 lane dock 按 ⏎
- 门禁产物收集失败：模型宣告路径不含 docs/superpowers 前缀或文件没写盘 → 看 run JSONL 与 stage 转写
```

- [ ] **Step 2: 手工端到端验收清单**（逐项勾选，全部通过才算完成）

1. `pi install` 本包（本地路径）+ `pi install git:github.com/obra/superpowers@v6.3.0`，重启。
2. `/wf` 无参数：预览列表含 sp-build、sp-fix、sp-review，sp-build 为默认。
3. `/wf sp-build "给 <本仓库某个真实小工具> 加 --verbose 标志" --name e2e-build`：run 分离，prompt 立即返回。
4. gate-spec 阶段：lane 出现停靠问题；⏎ 回答「批准」；`docs/superpowers/specs/` 出现 design 文档，`.rpiv/artifacts/gates/` 出现判决文件。
5. gate-plan 阶段：先「要求修改」——验证打回 writing-plans 重跑；再「批准」。
6. 全程在 Pinel 面板会话（PINEL_PLUGIN=1）再跑一次 `/wf sp-fix "<构造一个已知小 bug>"`：面板收到 pinel.workflow 状态（含 awaiting-approval 于 gate-diagnosis）。
7. `/wf @e2e-build` 恢复语义正常（已完成 run 直接回放完毕）。
8. `npx vitest run` 全绿。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(pi-pinel): usage, gate flow, artifact layout, Pinel payload contract, troubleshooting"
```

---

## 自检记录（写计划时已跑）

1. **Spec coverage：** D1→Task 4/5/6；D2→Task 4（三条）；D3→Task 3 + Task 6 验收；D4→Task 1（package.json）；D5/D6/D7/D8→Task 6 README + Task 1 collector 设计。全覆盖。
2. **Placeholder scan：** 无 TBD/TODO；每步含实际代码或命令。
3. **Type consistency：** `spBucketCollector` / `spArtifactOutcome` / `spGateOutcome`（Task 1）在 Task 4 的引用一致；`VERDICT_SCHEMA`（Task 4 定义）与 sp-gate frontmatter 的 decision 枚举一致（approved/revise/abort）；`SP_CONTRACTS` 5 份（Task 2）与 Task 5 测试断言一致；发布名解析（outcome.name = bucket）与 `reads: ["specs"/"plans"/"diagnosis"/"review-request"]` 一致。
4. **已知风险（计划内已兜底）：** ① `@juicesharp/rpiv-workflow/registration` 与 `/startup` 的具体类型名/回调参数序可能与本计划代码有出入 → 每个 Task 的 vitest 运行就是校验器，按编译错误对齐（已在 Task 1 Step 5、Task 5 Step 5 标注）；② `transcriptPathCollector({ pattern: /([\s\S]+)/ })` 的匹配语义（整段最后消息）需在 Task 4 测试跑绿时确认；③ 生命周期 `result.ok` 字段名若不存在，按 `RunWorkflowResult` 实际字段对齐（Task 5 标注）。

## 执行交接

计划已保存至 `pi-pinel/docs/superpowers/plans/2026-08-29-rpiv-superpowers-integration.md`。经用户确认后，两种执行方式：

**1. Subagent-Driven（推荐）** — 每个 Task 派发新子代理，任务间两阶段审查（superpowers:subagent-driven-development）
**2. Inline Execution** — 本会话内按批执行，检查点审查（superpowers:executing-plans）
