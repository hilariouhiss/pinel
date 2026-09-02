# Context chip 启动即显计数 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pinel 面板一启动（pi 会话建立时，无需等首条消息）Context chip 即显示真实计数（`Context N`），不再停留 "Context –" 占位。

**Architecture:** pi 的扩展 API 在 `session_start` 时不暴露 contextFiles（spike 实证：`ctx.getSystemPromptOptions()` 返回 null；`contextFiles` 仅首轮 `before_agent_start` 的 `ev.systemPromptOptions` 携带）。因此插件在 `session_start`（rpc 模式）按 pi 契约自行扫描磁盘（全局 agentDir + cwd 逐级向上，AGENTS.override.md 优先），以同一 statusKey `pinel.prompt` 推送「启动帧」`{v:1, startup:true, files}`；首轮 agent_start 的权威全帧（现有逻辑）到达后整体覆盖（宿主 last-wins）。宿主解析器与 webview 类型对启动帧放宽 system/counts/finalChars 为可选，ContextBar 在无 system 段时只列文件并加说明脚注。

**Tech Stack:** TypeScript（pi 插件 vitest；宿主 `node --experimental-strip-types` check 脚本）、React webview。零新依赖。

**Spec:** 本会话用户需求（经澄清收敛：目标=Pinel 面板；路径按 pi 契约 `~/.pi/agent/AGENTS.md`；形态=保持计数）。无独立 spec 文档，本 plan 即规范。

## 需求明细

1. 面板打开、pi rpc 会话建立后（首条消息之前），Context chip 显示 `Context N`（N=已加载上下文文件数）。
2. 首条消息后，现有权威全帧逻辑不变，计数可能因系统提示词/追加段变化（现状语义）。
3. pi 启动前的短暂窗口（pi 进程 spawn ~1-2s）仍显示 "Context –" 占位——本计划不做宿主预扫描（范围外）。
4. 不改变：Skills/Prompts/Extensions/MCP chip、hover/弹层语义、TUI 模式插件惰性契约。

## Global Constraints

- **pi API 事实（spike 实证，本计划前提）**：`session_start`/`resources_discover` 时 `ctx.getSystemPromptOptions()` = null；`contextFiles` 仅 `before_agent_start` 的 `ev.systemPromptOptions.contextFiles` 提供。启动帧是**预估**，权威性由首轮全帧覆盖保证。
- **扫描契约对齐 pi**（usage.md + pi bundle `loadContextFileFromDir` 实证）：全局目录 = `PI_CODING_AGENT_DIR ?? ~/.pi/agent`；每目录候选顺序 `AGENTS.override.md → AGENTS.md → AGENTS.MD → CLAUDE.md → CLAUDE.MD`（命中即停）；遍历 = 全局目录 + 从 cwd 逐级向上至根（含 cwd 自身）。
- 仅在 `ctx.mode === "rpc"` 推送（TUI 惰性契约不变）；读文件失败静默跳过，绝不阻断 pi 启动。
- 计数形态保持 `Context N`；hover 名单与弹层行结构不变（启动帧无 system 段 → 弹层加说明脚注）。
- VS Code 引擎 `^1.125.0`；零新依赖；中文注释；`npm run compile` / `npm run package` / `npm test`（pi: vitest）全绿为验收底线。

## File Structure

- 修改 `pi/extensions/prompt-composition.ts` — 新增 `scanStartupContextFiles()`、`buildStartupPayload()` 与 `session_start` 监听（启动帧推送）。
- 修改 `pi/extensions/prompt-composition.test.ts` — vitest：扫描解析（override/CLAUDE 候选/向上遍历/env 覆盖/缺文件）与 payload 形状。
- 修改 `vscode/src/chat/pinel-payload.ts` — `parsePinelPrompt` 接受启动帧（`startup:true` 分支）；`PinelPromptPayload.system/counts/finalChars` 改可选 + `startup?: true`。
- 新建 `vscode/src/chat/pinel-payload.check.mjs` — 静态 + 解析断言（`node --experimental-strip-types` 直接跑 TS，沿 webview-ui `*.check.mjs` 模式）。
- 修改 `vscode/webview-ui/src/types.ts` — `PinelPrompt` 同步可选化 + `startup?: true`。
- 修改 `vscode/webview-ui/src/components/ContextBar.tsx` — 计数/悬停/弹层对可选字段防御 + 启动帧弹层分支。
- 修改 `vscode/package.json` — `check:pinel-payload` 挂入 compile/package 门。

---

### Task 1: 插件启动帧扫描与推送

**Files:**
- Modify: `pi/extensions/prompt-composition.ts`

**Interfaces:**
- Consumes: 无（`agentDir()`/`isUnderDir()`/`preview()`/`section()` 均已在同文件）
- Produces:
  - `scanStartupContextFiles(cwd: string): Array<{ level: "user" | "project"; name: string; path: string; chars: number; preview: string }>` — 读磁盘按契约扫描；任何单文件失败跳过
  - `buildStartupPayload(files): { v: 1; startup: true; files }` — 与全帧同 `files` 条目形状
  - `session_start` 监听（`ctx.mode === "rpc"` 门内）：`ctx.ui?.setStatus?.("pinel.prompt", JSON.stringify(buildStartupPayload(scanStartupContextFiles(ctx.cwd))))`

- [ ] **Step 1: 新增扫描与载荷构造（文件顶部 import 补 `existsSync`/`readFileSync`/`statSync`/`resolve`）**

在 `prompt-composition.ts` 的 `preview()` 之后插入：

```ts
/** 每目录上下文文件候选（对齐 pi loadContextFileFromDir：override 优先，大小写变体）。 */
const CONTEXT_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** 读单个目录的上下文文件（候选序命中即停；无/读失败 → null）。 */
function loadContextFromDir(dir: string): { path: string; content: string } | null {
  for (const name of CONTEXT_CANDIDATES) {
    const filePath = join(dir, name);
    try {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
      return { path: filePath, content: readFileSync(filePath, "utf8") };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 启动帧上下文文件扫描（session_start 时 pi 尚未通过 API 暴露 contextFiles，
 * 按 pi 契约自行解析；首轮权威全帧到达后覆盖，此处仅影响首条消息前的展示窗口）。
 * 遍历：全局 agentDir + cwd 逐级向上至根（含 cwd 自身）。
 */
export function scanStartupContextFiles(cwd: string): PromptCompositionFile[] {
  const files: PromptCompositionFile[] = [];
  const seen = new Set<string>();
  const push = (filePath: string, content: string) => {
    const norm = filePath.replace(/\\/g, "/");
    if (seen.has(norm)) return;
    seen.add(norm);
    files.push({
      level: isUnderDir(filePath, agentDir()) ? "user" : "project",
      name: norm.split("/").pop() ?? filePath,
      path: filePath,
      chars: content.length,
      preview: preview(content),
    });
  };
  const global = loadContextFromDir(agentDir());
  if (global) push(global.path, global.content);
  let dir = resolve(cwd);
  for (;;) {
    const found = loadContextFromDir(dir);
    if (found) push(found.path, found.content);
    const parent = join(dir, "..");
    const next = resolve(parent);
    if (next === dir) break;
    dir = next;
  }
  return files;
}

/** 启动帧（v:1；startup 标记 + files；system/counts/finalChars 缺省，宿主解析器接受）。 */
export function buildStartupPayload(files: PromptCompositionFile[]): Record<string, unknown> {
  return { v: 1, startup: true, files };
}
```

其中 `PromptCompositionFile` 是新增导出接口（供测试引用）：

```ts
export interface PromptCompositionFile {
  level: "user" | "project";
  name: string;
  path: string;
  chars: number;
  preview: string;
}
```

- [ ] **Step 2: `registerPromptComposition` 增加 session_start 监听**

在现有 `pi.on("before_agent_start", ...)` 之前插入：

```ts
  pi.on("session_start", (_ev: any, ctx: any) => {
    if (ctx?.mode !== "rpc") return;
    const cwd = typeof ctx.cwd === "string" ? ctx.cwd : "";
    if (!cwd) return;
    const files = scanStartupContextFiles(cwd);
    const json = JSON.stringify(buildStartupPayload(files));
    lastJson = json; // 占位去重：全帧与启动帧 JSON 不同，此赋值防止同内容启动帧重推
    ctx.ui?.setStatus?.("pinel.prompt", json);
  });
```

- [ ] **Step 3: 跑既有插件测试确认无回归**

Run: `cd pi && npx vitest run extensions/prompt-composition.test.ts`
Expected: 现有用例全绿（新增导出不影响旧断言）。

- [ ] **Step 4: Commit**

```bash
git -C pi add extensions/prompt-composition.ts
git -C pi commit -m "feat(prompt-composition): session_start 启动帧——按 pi 契约扫描上下文文件并推送 pinel.prompt"
```

---

### Task 2: 插件扫描/载荷测试

**Files:**
- Modify: `pi/extensions/prompt-composition.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `scanStartupContextFiles`、`buildStartupPayload`、`PromptCompositionFile`
- Produces: vitest 用例覆盖扫描契约与载荷形状

- [ ] **Step 1: 追加用例（`mkdtempSync` 临时目录 + `process.env.PI_CODING_AGENT_DIR` 覆盖）**

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStartupContextFiles, buildStartupPayload } from "./prompt-composition.js";

function tmpAgent(overrides: { agentDir?: string; repoFiles?: Record<string, string>; globalFile?: string }) {
  const base = mkdtempSync(join(tmpdir(), "pinel-ctx-"));
  const agentDir = overrides.agentDir ?? join(base, "agent");
  mkdirSync(agentDir, { recursive: true });
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(overrides.repoFiles ?? {})) {
    const p = join(repo, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  if (overrides.globalFile) writeFileSync(join(agentDir, overrides.globalFile), "GLOBAL");
  return { base, agentDir, repo };
}

describe("scanStartupContextFiles", () => {
  const ORIG_ENV = process.env.PI_CODING_AGENT_DIR;
  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = ORIG_ENV;
  });

  it("cwd 的 AGENTS.md + 全局 agentDir AGENTS.md：全局在前，level 正确", () => {
    const t = tmpAgent({ globalFile: "AGENTS.md", repoFiles: { "AGENTS.md": "PROJ" } });
    process.env.PI_CODING_AGENT_DIR = t.agentDir;
    const files = scanStartupContextFiles(t.repo);
    expect(files.map((f) => [f.level, f.name])).toEqual([
      ["user", "AGENTS.md"],
      ["project", "AGENTS.md"],
    ]);
    expect(files[0].chars).toBe(6); // "GLOBAL"
    expect(files[1].preview).toBe("PROJ");
    rmSync(t.base, { recursive: true, force: true });
  });

  it("AGENTS.override.md 优先于 AGENTS.md；CLAUDE.md 作为兜底候选", () => {
    const t = tmpAgent({ repoFiles: { "AGENTS.md": "A", "AGENTS.override.md": "OVR" } });
    process.env.PI_CODING_AGENT_DIR = t.agentDir;
    const files = scanStartupContextFiles(t.repo);
    expect(files.map((f) => f.name)).toEqual(["AGENTS.override.md"]);
    rmSync(t.base, { recursive: true, force: true });

    const t2 = tmpAgent({ repoFiles: { "CLAUDE.md": "C" } });
    process.env.PI_CODING_AGENT_DIR = t2.agentDir;
    expect(scanStartupContextFiles(t2.repo).map((f) => f.name)).toEqual(["CLAUDE.md"]);
    rmSync(t2.base, { recursive: true, force: true });
  });

  it("逐级向上：cwd 与祖先各命中一次，去重", () => {
    const t = tmpAgent({
      repoFiles: { "AGENTS.md": "PARENT", "sub/AGENTS.md": "CHILD" },
    });
    process.env.PI_CODING_AGENT_DIR = t.agentDir;
    const files = scanStartupContextFiles(join(t.repo, "sub"));
    expect(files.map((f) => f.name)).toEqual(["AGENTS.md", "AGENTS.md"]);
    expect(files[0].preview).toBe("CHILD"); // 就近在前
    rmSync(t.base, { recursive: true, force: true });
  });

  it("全缺 → 空数组；buildStartupPayload 形状 {v:1,startup:true,files}", () => {
    const t = tmpAgent({});
    process.env.PI_CODING_AGENT_DIR = t.agentDir;
    const files = scanStartupContextFiles(t.repo);
    expect(files).toEqual([]);
    expect(buildStartupPayload(files)).toEqual({ v: 1, startup: true, files: [] });
    rmSync(t.base, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 跑测试确认全绿**

Run: `cd pi && npx vitest run extensions/prompt-composition.test.ts`
Expected: 新增 4 用例 + 既有用例全部通过。

- [ ] **Step 3: Commit**

```bash
git -C pi add extensions/prompt-composition.test.ts
git -C pi commit -m "test(prompt-composition): 启动帧扫描契约与载荷形状"
```

---

### Task 3: 宿主解析器接受启动帧

**Files:**
- Modify: `vscode/src/chat/pinel-payload.ts`
- Create: `vscode/src/chat/pinel-payload.check.mjs`
- Modify: `vscode/package.json`

**Interfaces:**
- Consumes: Task 1 启动帧 JSON 形状 `{v:1, startup:true, files:[{level,name,path,chars,preview}]}`
- Produces: `PinelPromptPayload` 中 `system`/`counts`/`finalChars` 变为可选，新增 `startup?: true`；`parsePinelPrompt` 对 `startup:true` 帧走宽松分支（只校验 v/files），全帧仍走原严格分支

- [ ] **Step 1: 类型 + 解析分支**

`pinel-payload.ts`：
1. `PinelPromptPayload` 接口改为：`system: ...` → `system?: ...`；`counts: ...` → `counts?: ...`；`finalChars: number` → `finalChars?: number`；新增 `/** true = 启动帧（session_start 预估扫描，无 system/counts/finalChars；首轮全帧覆盖）。 */ startup?: true;`
2. `parsePinelPrompt` 在 `raw.v !== 1` 校验之后插入启动帧分支（复用下方 files 解析，故先把 files 解析抽成内部函数 `toFiles(raw: Record<string, unknown>): PinelPromptFile[]`，原 files 循环体移入；`toSection`/`toCount` 保持不动）：

```ts
  const files = toFiles(raw);
  if (raw.startup === true) {
    return { v: 1, startup: true, files };
  }
```

原实现中 system/counts/finalChars 校验与 payload 组装保持原样（全帧路径零改动），仅把 `files` 循环体替换为 `toFiles(raw)` 调用。

- [ ] **Step 2: check 脚本（静态 + 解析断言）**

`vscode/src/chat/pinel-payload.check.mjs`：

```js
/**
 * pinel-payload 自检：守卫 pinel.prompt 解析器——启动帧宽松分支 + 全帧严格分支。
 * 挂入 npm run compile 门：解析器被改坏时编译即红。
 */
import assert from "node:assert";
import { parsePinelPrompt } from "./pinel-payload.ts";

const FULL = {
  v: 1,
  system: { chars: 4, kind: "default", preview: "BASE" },
  files: [{ level: "project", name: "AGENTS.md", path: "/repo/AGENTS.md", chars: 5, preview: "PROJ" }],
  counts: { guidelines: 0, skills: 1, tools: 2 },
  finalChars: 10,
};

// 全帧严格分支：完整载荷通过，system/counts/finalChars 缺一即丢
assert.ok(parsePinelPrompt(JSON.stringify(FULL)), "全帧必须通过");
assert.strictEqual(parsePinelPrompt(JSON.stringify({ ...FULL, counts: undefined })), null, "全帧缺 counts 必须丢弃");
assert.strictEqual(parsePinelPrompt(JSON.stringify({ ...FULL, finalChars: undefined })), null, "全帧缺 finalChars 必须丢弃");

// 启动帧宽松分支：仅 v/files 必需
const startup = parsePinelPrompt(JSON.stringify({ v: 1, startup: true, files: FULL.files }));
assert.ok(startup, "启动帧必须通过");
assert.strictEqual(startup.startup, true);
assert.strictEqual(startup.files.length, 1);
assert.strictEqual(startup.system, undefined);
assert.strictEqual(startup.counts, undefined);
assert.strictEqual(startup.finalChars, undefined);
assert.strictEqual(parsePinelPrompt(JSON.stringify({ v: 1, startup: true })), null, "启动帧无 files 数组必须丢弃");

// 恶意/畸形帧仍拒绝
assert.strictEqual(parsePinelPrompt("{nope"), null, "畸形 JSON 必须丢弃");
assert.strictEqual(parsePinelPrompt(JSON.stringify({ v: 2 })), null, "版本不符必须丢弃");

console.log("pinel-payload check OK");
```

- [ ] **Step 3: package.json 挂门**

scripts 区新增 `"check:pinel-payload": "node --experimental-strip-types src/chat/pinel-payload.check.mjs",`；`compile` 与 `package` 链在 `check:scrollbar` 之后各插入 `npm run check:pinel-payload &&`。

- [ ] **Step 4: 跑自检 + 编译门**

Run: `cd vscode && npm run check:pinel-payload && npm run compile`
Expected: `pinel-payload check OK`；compile 全绿。
（若 `pinel-payload.ts` 存在外部 import 导致 strip-types 直跑失败：改用 `npx tsc src/chat/pinel-payload.ts --outDir .tmp-check --target es2022 --module es2022 --moduleResolution bundler` 先编译再 import `.tmp-check/pinel-payload.js`，并在报告注明；不要改生产代码。）

- [ ] **Step 5: Commit**

```bash
git -C vscode add src/chat/pinel-payload.ts src/chat/pinel-payload.check.mjs package.json
git -C vscode commit -m "feat(payload): pinel.prompt 解析器接受启动帧（system/counts/finalChars 可选）+ 自检挂门"
```

---

### Task 4: webview 类型与 ContextBar 防御渲染

**Files:**
- Modify: `vscode/webview-ui/src/types.ts`
- Modify: `vscode/webview-ui/src/components/ContextBar.tsx`

**Interfaces:**
- Consumes: Task 3 的 `PinelPromptPayload`（宿主类型）形状：`system?`/`counts?`/`finalChars?`/`startup?: true`
- Produces: webview `PinelPrompt` 同构可选化；ContextBar 在启动帧下正常渲染计数与文件弹层

- [ ] **Step 1: types.ts**

`PinelPrompt`（types.ts:333 附近）：

```ts
/** pinel.prompt 载荷（提示词组成；插件推送 → 宿主解析广播）。
 *  startup=true 为启动帧：仅 files（session_start 预估扫描），
 *  system/counts/finalChars 缺省，首轮权威全帧到达后覆盖。 */
export interface PinelPrompt {
  v: 1;
  startup?: true;
  system?: PinelPromptSection & { kind: "default" | "custom" };
  files: PinelPromptFile[];
  append?: PinelPromptSection;
  counts?: { guidelines: number; skills: number; tools: number };
  injected?: PinelPromptSection;
  injectedUnknown?: true;
  finalChars?: number;
}
```

- [ ] **Step 2: ContextBar 三处防御**

1. 计数（`:358` 附近）：

```tsx
  const contextCount = pinelPrompt
    ? pinelPrompt.files.length +
      (pinelPrompt.system?.kind === "custom" ? 1 : 0) +
      (pinelPrompt.append ? 1 : 0)
    : 0;
```

2. hover（`:362` 附近）：`pinelPrompt.system.kind` → `pinelPrompt.system?.kind`（其余不变）。

3. `renderComposition`（`:231` 附近）：在 `const p = pinelPrompt;` 之后、`p.system` 行之前加启动帧分支：

```tsx
    if (p.startup) {
      return (
        <>
          <div className="ctx-comp-row">
            <span className="ctx-comp-desc">启动帧：首条消息发出后补充系统提示词/注入段明细</span>
          </div>
          {userFiles.length > 0 && (
            <>
              <div className="ctx-comp-heading">用户级</div>
              {userFiles.map(fileRow)}
            </>
          )}
          {projectFiles.length > 0 && (
            <>
              <div className="ctx-comp-heading">项目级</div>
              {projectFiles.map(fileRow)}
            </>
          )}
          {userFiles.length === 0 && projectFiles.length === 0 && (
            <div className="ctx-comp-row">
              <span className="ctx-comp-desc">未发现上下文文件（~/.pi/agent/AGENTS.md 或项目 AGENTS.md/CLAUDE.md）</span>
            </div>
          )}
        </>
      );
    }
```

（`userFiles`/`projectFiles`/`fileRow` 定义保持在分支之前；原全帧渲染路径中 `p.system.chars`、`p.counts.skills` 等处因类型可选会报错 → 全帧路径前加 `const system = p.system;` 并 `if (!system || !p.counts || p.finalChars === undefined)` 时渲染启动帧同款降级（复用上述启动帧 JSX 抽成局部函数 `renderStartupBody()`），保证编译期类型收窄。）

- [ ] **Step 3: 类型检查 + 构建**

Run: `cd vscode && npm run check-types && node webview-ui/esbuild.js`
Expected: PASS；media/webview.js 构建成功。

- [ ] **Step 4: Commit**

```bash
git -C vscode add webview-ui/src/types.ts webview-ui/src/components/ContextBar.tsx
git -C vscode commit -m "feat(contextbar): Context chip 支持启动帧——计数/弹层对可选字段防御渲染"
```

---

### Task 5: 端到端验证（插件装入真实 pi rpc 会话 + 面板手动检查）

**Files:**
- Create（临时，验证后删除）: `.tmp-context-verify/`（rpc 会话日志）

**Interfaces:**
- Consumes: Task 1-4 全部产物
- Produces: 验证记录；无生产代码变更

- [ ] **Step 1: 构建并安装插件到本机 pi**

Run: `cd pi && npm run build 2>/dev/null || npx tsc --noEmit`（先确认 pi/package.json 的构建方式；Pinel 插件以仓库目录注册或经 `pi install` 安装——沿既有开发流程，见 pi/README.md 与 vscode 的安装逻辑 `controller.ts` runPiCommand "install"）

- [ ] **Step 2: rpc 会话抓启动帧**

在含 `AGENTS.md` 的目录（`vscode/` 即满足）启动 rpc 会话，环境带 `PINEL_PLUGIN=1`，抓 stdout 中 `extension_ui_request` 帧：

```bash
cd vscode && PINEL_PLUGIN=1 pi --mode rpc 2>/tmp/ctx-verify/pi-rpc.log &
# 通过 rpc 协议取一次 get_state（或直接观察启动日志），grep 启动帧：
grep -o '"pinel.prompt"[^}]*}' /tmp/ctx-verify/pi-rpc.log | head -2
```

Expected: 首条消息之前即有 `pinel.prompt` 帧，JSON 为 `{"v":1,"startup":true,"files":[{level:"project",name:"AGENTS.md",...}]}`（本机无全局 ~/.pi/agent/AGENTS.md，故仅项目文件）。

- [ ] **Step 3: 回归——首轮全帧覆盖**

向该 rpc 会话发一条消息，再次 grep `pinel.prompt` 帧。
Expected: 出现含 `system`/`counts`/`finalChars` 的全帧（无 `startup` 标记），证明覆盖链路完好。

- [ ] **Step 4: 面板手动检查（人类步骤，记录在案）**

`npm run package` 后 F5：
1. 打开 Pinel 面板 → pi 启动完成后、未发消息时，Context chip 显示 `Context 1`（本机 vscode 工作区）而非 "Context –"。
2. hover 显示 `AGENTS.md`；点击弹层显示文件段 + 「启动帧」说明行。
3. 发送首条消息 → 弹层出现系统提示词/注入段明细（全帧覆盖）。
4. 无 AGENTS.md 的目录 → 启动帧 files 为空，chip 显示 `Context 0`（或按产品决定继续显示占位——默认显示 `Context 0`，记录实际观感）。

- [ ] **Step 5: 清理临时目录；无代码变更则跳过 commit**

---

## Self-Review

- **Spec coverage:** 需求 1 → Task 1（启动帧）+ Task 3/4（解析与渲染）；需求 2 → Task 5 Step 3 回归验证；需求 3 → 明确范围外（plan 声明）；需求 4 → Global Constraints 与各任务不改动其他 chip。全覆盖。
- **Placeholder scan:** 无 TBD；全部步骤含可执行代码/命令。Task 4 Step 2 的「全帧路径类型收窄」给出了具体做法（抽 `renderStartupBody()` + `system`/`counts`/`finalChars` 存在性门），无歧义。
- **Type consistency:** `startup: true` 在插件（buildStartupPayload）、宿主（PinelPromptPayload）、webview（PinelPrompt）、check 脚本四处一致；`files` 条目形状 `{level,name,path,chars,preview}` 与现有全帧一致（Task 1 复用 `preview()`/`isUnderDir()`）；statusKey `"pinel.prompt"` 与宿主白名单一致。
- **风险记录:** 启动帧为预估扫描，pi 契约变更（候选/目录）时首条消息前计数可能偏差——首轮全帧自愈；已在 plan 架构段与 Global Constraints 声明。
