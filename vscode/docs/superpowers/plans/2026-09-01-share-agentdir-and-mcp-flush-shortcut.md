# 共享 agentDir + MCP 推送免重序列化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复审计问题 3/4：合并 pi 插件内三份 `agentDir()` 拷贝为一个共享模块；`flushMcpStatus()` 加对象引用短路，事件循环高频路径免重复 `JSON.stringify`。

**Architecture:** 新建 `pi/extensions/agent-dir.ts`（`agentDir(env?)`：PI_CODING_AGENT_DIR 优先 + trim，缺省 `~/.pi/agent`，env 可注入供测试），`prompt-composition.ts`/`mcp-status.ts`/`auto-commit.ts` 三处改为 import（`pinelSettingsPath` 保留签名委托）；`mcp-status.ts` 模块级加 `lastPushedRef` 引用追踪——同引用直跳（10 事件循环每事件调一次的场景零序列化），新对象同内容仍走既有 JSON 去重不重发。零行为面变化：帧形状、推送时机、去重语义全部不变。

**Tech Stack:** TypeScript（pi 包既有约定）、vitest（fake env + spy）。

**Spec:** 本会话用户需求（逐字）："编写计划，修复第三四两个问题。"——问题 3 = 审计报告第 3 项（`agentDir()` 在 prompt-composition.ts / mcp-status.ts / auto-commit.ts 三份拷贝，~8 行×3）；问题 4 = 审计报告第 4 项（`flushMcpStatus()` 被 10 个事件 handler 每个都调用，载荷未变也 `JSON.stringify`）。

## Global Constraints

- 只动 pi 仓库（`c:/source_code/Other/pinel/pi`），vscode 仓库零改动（check-plugin 作为类型验证）。
- 不新增任何 npm 依赖。
- 推送契约 v:1 零变化：`pinel.prompt` / `pinel.mcp` / `pinel.workflow(s)` 帧形状与推送时机不变（smoke 断言 pinel.prompt/pinel.mcp 帧，是本计划的端到端回归锚点）。
- 去重语义不变：同内容不重发（现有 mcp-status.test.ts「重复快照去重」用例必须保持全绿）。
- 行为修正点（有意为之，写入测试）：`PI_CODING_AGENT_DIR` 统一 trim——空白值视为缺失回落默认。此前三份拷贝中仅 auto-commit 有 trim，另两份对空白值当作字面目录。
- pi 仓库约定：相对导入 `.js` 后缀；测试与注释中文；Conventional Commits（`refactor(pi-pinel):` / `perf(pi-pinel):`）。
- 历史计划文档（`pi/docs/superpowers/plans/`）一律不改。

## File Structure

| 文件 | 职责 |
|------|------|
| `pi/extensions/agent-dir.ts`（新建） | 共享 agentDir 解析（env 优先 + trim + 默认 ~/.pi/agent，env 可注入） |
| `pi/extensions/agent-dir.test.ts`（新建） | 三断言：env 覆盖（trim）、空白回落、默认路径 |
| `pi/extensions/prompt-composition.ts`（修改） | 删本地 agentDir 与 homedir import，改 import 共享版 |
| `pi/extensions/mcp-status.ts`（修改） | 删本地 agentDir；flushMcpStatus 加 lastPushedRef 短路 |
| `pi/extensions/auto-commit.ts`（修改） | pinelSettingsPath 委托 agentDir(env)，删 os import |
| `pi/extensions/mcp-status.test.ts`（修改） | 新增「同引用免序列化」spy 用例 |

---

### Task 1: 共享 agentDir 模块 + 三处迁移

**Files:**
- Create: `pi/extensions/agent-dir.ts`、`pi/extensions/agent-dir.test.ts`
- Modify: `pi/extensions/prompt-composition.ts`、`pi/extensions/mcp-status.ts`、`pi/extensions/auto-commit.ts`

**Interfaces:**
- Consumes: 现状三份拷贝——prompt-composition.ts / mcp-status.ts 各一个私有 `agentDir()`（无 trim），auto-commit.ts 的 `pinelSettingsPath(env = process.env)` 内联同逻辑（有 trim）。
- Produces: `export function agentDir(env: { PI_CODING_AGENT_DIR?: string } = process.env): string`；`pinelSettingsPath(env: NodeJS.ProcessEnv = process.env): string` 签名不变（委托实现）。

- [ ] **Step 1: 基线验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（46/46）。

- [ ] **Step 2: 创建 agent-dir.ts**

`pi/extensions/agent-dir.ts`：

```typescript
/**
 * pi agent 目录解析（镜像 pi config.ts getAgentDir：PI_CODING_AGENT_DIR
 * 环境变量优先，缺省 ~/.pi/agent）。三个采集器共用（prompt-composition /
 * mcp-status / auto-commit），防解析语义漂移；env 可注入供测试。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(env: { PI_CODING_AGENT_DIR?: string } = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	return configured && configured.length > 0 ? configured : join(homedir(), ".pi", "agent");
}
```

- [ ] **Step 3: 创建 agent-dir.test.ts**

`pi/extensions/agent-dir.test.ts`：

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentDir } from "./agent-dir.js";

describe("agentDir", () => {
	it("env 覆盖优先（trim 后生效）", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "  /custom/agent " })).toBe("/custom/agent");
	});

	it("空白 env 视为缺失 → 回落默认 ~/.pi/agent", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "   " })).toBe(join(homedir(), ".pi", "agent"));
	});

	it("缺省 = ~/.pi/agent；无参读 process.env", () => {
		expect(agentDir({})).toBe(join(homedir(), ".pi", "agent"));
		expect(agentDir().length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 4: prompt-composition.ts 迁移**

- import 区删除 `import { homedir } from "node:os";`（`join`/`resolve` 仍被其他地方使用，保留）。
- 新增 `import { agentDir } from "./agent-dir.js";`。
- 删除本地函数（含注释行）：

```typescript
/** agentDir 解析（镜像 pi config.ts getAgentDir：env 优先，缺省 ~/.pi/agent）。 */
function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env && env.length > 0) return env;
	return join(homedir(), ".pi", "agent");
}
```

- 三处调用（`isUnderDir(filePath, agentDir())` ×2、`const agent = agentDir();`）不动——函数名相同，import 后自然解析。

- [ ] **Step 5: mcp-status.ts 迁移**

- import 区删除 `import { homedir } from "node:os";`（`join` 仍被配置路径拼接使用，保留）。
- 新增 `import { agentDir } from "./agent-dir.js";`。
- 删除本地函数（含注释行）：

```typescript
/** agentDir 解析（镜像 pi config.ts getAgentDir：env 优先，缺省 ~/.pi/agent）。 */
function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env && env.length > 0) return env;
	return join(homedir(), ".pi", "agent");
}
```

- `registerMcpStatus` 内 `join(agentDir(), "mcp.json")` 调用不动。

- [ ] **Step 6: auto-commit.ts 迁移**

- import 区删除 `import os from "node:os";`（`os` 仅被 pinelSettingsPath 使用）；新增 `import { agentDir } from "./agent-dir.js";`（`fs`/`path` 保留——`path.join` 仍被 pinelSettingsPath 使用）。
- `pinelSettingsPath` 改为委托：

```typescript
/** settings.json 路径：对齐宿主 agentSettingsPath（PI_CODING_AGENT_DIR 覆盖，默认 ~/.pi/agent）。 */
export function pinelSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(agentDir(env), "settings.json");
}
```

（签名不变，autoCommitExtension 内 `fs.readFileSync(pinelSettingsPath(), "utf8")` 不动。）

- [ ] **Step 7: 验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（49/49：新增 3 条 agent-dir + 既有 46）。

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-plugin`
Expected: 零错误（tsc 跟随 import 检查新模块）。

- [ ] **Step 8: 提交**

```bash
git -C c:/source_code/Other/pinel/pi add extensions/agent-dir.ts extensions/agent-dir.test.ts extensions/prompt-composition.ts extensions/mcp-status.ts extensions/auto-commit.ts
git -C c:/source_code/Other/pinel/pi commit -m "refactor(pi-pinel): share agentDir resolution across collectors"
```

---

### Task 2: flushMcpStatus 对象引用短路

**Files:**
- Modify: `pi/extensions/mcp-status.ts`
- Modify: `pi/extensions/mcp-status.test.ts`

**Interfaces:**
- Consumes: 现状 `latest`/`lastPushed` 模块级变量 + `flushMcpStatus()`（pinel.ts 事件循环每事件调用一次；适配器快照事件更新 latest 后调用一次）。
- Produces: 模块级新增 `lastPushedRef: Record<string, unknown> | null`；`flushMcpStatus()` 语义——同引用直跳（免序列化），新对象同内容仍去重，ctx 未就绪仍保留待推（不记引用）。

- [ ] **Step 1: mcp-status.ts 加引用追踪**

`latest`/`lastPushed` 声明处（两行）后加一行：

```typescript
/** 上次已推送的载荷对象引用：同引用（事件循环高频路径）免序列化直跳。 */
let lastPushedRef: Record<string, unknown> | null = null;
```

`flushMcpStatus()` 替换为：

```typescript
/** 补发最新载荷（pinel.ts 在每次会话事件写入 ctx 后调用；未变不重发）。
 *  同引用直跳：latest 仅在注册基线/适配器快照时重建，事件循环高频调用
 *  不触发 JSON.stringify；新对象仍走 JSON 去重（同内容不重发）。 */
export function flushMcpStatus(): void {
	if (!latest) {
		return;
	}
	const ctx = getPinelCtx() as
		| { ui?: { setStatus?: (key: string, text: string) => void } }
		| undefined;
	if (!ctx?.ui?.setStatus) {
		return; // ctx 未就绪：保留待推（不记 lastPushed，就绪后仍会补发）
	}
	if (latest === lastPushedRef) {
		return; // 同引用已推过：免序列化（事件循环高频路径）
	}
	const json = JSON.stringify(latest);
	if (json === lastPushed) {
		lastPushedRef = latest; // 同内容（新对象）：引用前进，免后续重复序列化
		return;
	}
	lastPushed = json;
	lastPushedRef = latest;
	ctx.ui.setStatus("pinel.mcp", json);
}
```

- [ ] **Step 2: mcp-status.test.ts 新增 spy 用例**

在 `describe("registerMcpStatus")` 内、既有用例之后加：

```typescript
	it("事件循环高频路径：载荷未变（同引用）时不重新序列化也不重推", () => {
		writeJson(join(agentRoot, "mcp.json"), { mcpServers: { a: {} } });
		const { pi } = makePi();
		const { pushes, ctx } = makeCtx();
		setPinelCtx(ctx);
		registerMcpStatus(pi, cwd);
		flushMcpStatus();
		expect(pushes.length).toBe(1);

		const spy = vi.spyOn(JSON, "stringify");
		flushMcpStatus(); // pinel.ts 事件循环每事件一次：同引用直跳
		flushMcpStatus();
		expect(spy).not.toHaveBeenCalled();
		expect(pushes.length).toBe(1);
		spy.mockRestore();
	});
```

既有「快照事件：…重复快照去重」用例不动（覆盖新对象同内容路径）。

- [ ] **Step 3: 验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（50/50，含新增 spy 用例；既有去重用例证明 JSON 去重语义未破坏）。

- [ ] **Step 4: 提交**

```bash
git -C c:/source_code/Other/pinel/pi add extensions/mcp-status.ts extensions/mcp-status.test.ts
git -C c:/source_code/Other/pinel/pi commit -m "perf(pi-pinel): skip reserializing unchanged MCP payload"
```

---

### Task 3: 全量回归 + 冒烟

**Files:** 无新文件。

- [ ] **Step 1: pi 全量测试**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿。

- [ ] **Step 2: vscode 类型验证**

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-plugin && npm run check-types && npm run lint`
Expected: 零错误（vscode 源码零改动，检查应为原样全绿）。

- [ ] **Step 3: 冒烟（帧通道回归锚点）**

Run: `cd c:/source_code/Other/pinel/vscode && npm run smoke:plugin`
Expected: `SMOKE OK: 插件加载 / pinel.prompt 启动帧 / pinel.mcp 基线帧全部通过`——pinel.mcp 基线帧经新 flushMcpStatus 推送（首事件 latest 非空 + 引用未记 → 正常序列化推送），端到端验证短路未破坏推送。

- [ ] **Step 4: 状态检查**

Run: `git -C c:/source_code/Other/pinel/pi status --short && git -C c:/source_code/Other/pinel/vscode status --short`
Expected: 两仓干净（本计划文件已在 vscode 仓提交）。

---

## Self-Review

- **Spec coverage:** 问题 3 → Task 1（agent-dir.ts 新建 + 三处迁移 + 单测）；问题 4 → Task 2（lastPushedRef 短路 + spy 用例）；回归 → Task 3（pi 全量 + check-plugin + 冒烟帧锚点）。审计两条建议的原表述（"合并到一个共享 util"、"先比对象引用再 stringify，一行的事"）均已按计划落实。
- **Placeholder scan:** 无 TBD/TODO；所有代码块完整；删除块给出精确旧文；`agentDir` 函数名不变使三处调用点零改动（迁移 = 删本地定义 + 加 import）。
- **Type consistency:** `agentDir(env: { PI_CODING_AGENT_DIR?: string } = process.env)` 与三处消费一致——auto-commit 传 `NodeJS.ProcessEnv` 结构化兼容；`lastPushedRef` 三个赋值点（同内容分支 / 成功推送分支）与直跳判断一致，初始 null 保证首次必推；`pinelSettingsPath` 签名不变与 autoCommitExtension 调用一致。
