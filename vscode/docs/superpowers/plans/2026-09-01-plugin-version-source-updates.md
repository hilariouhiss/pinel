# 插件管理 v2 —— 版本 / 来源 / 更新检测 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展管理弹层（All/Global/Project 视图）的每个包行显示来源徽标、已装版本、更新状态；有更新时提供行内 Update 按钮与标题栏 Update all + 手动刷新；更新动作复用官方 `pi update` CLI。

**Architecture:** 纯函数层（`extensions.ts` 增来源/路径/版本解析；新模块 `extension-updates.ts` 负责 npm/git 更新判定与 TTL 缓存，runner 注入可单测）→ Controller 薄编排（检查、更新、批量更新）→ panel 消息接线 → webview 纯合并模块 + 弹层渲染。本地散文件扩展无版本显示 `—`，不参与更新检查。

**Tech Stack:** TypeScript（VS Code 扩展宿主 + React webview）、mocha 单测、`node --experimental-strip-types` check.mjs 自检。无新增 npm 依赖。

**Spec:** 本文件即设计（用户已确认）：打开弹层自动检查 + 10 分钟缓存 + 手动刷新绕过缓存；单行更新 + Update all；来源徽标 + 版本号。

## Global Constraints

- 不新增任何 npm 依赖（semver 也不用：npm 更新判定用字符串不等，误报由幂等 `pi update` 兜底）。
- `vscode/src/chat/extensions.ts` 与 `extension-updates.ts` 保持零 vscode import（纯函数可单测）。
- pinned spec 跳过更新检查，对齐 pi `checkForAvailableUpdates`（`parsed.pinned` / npm 精确版本 → 不查）。
- inherited 行（全局包项目未覆盖）的版本/更新/升级全部作用于**全局**安装（effectiveScope = "global"）。
- 更新检测失败/离线/超时 → status "unknown"，不显示 Update 按钮，不报错弹窗。
- settings.json 读写沿用 `readSettings`/`writeSettings`（严格 JSON + 原子写），本计划不改写 settings。
- 命令 spawn 复用 `resolveSpawnSpec`（`vscode/src/rpc/client.ts`，Windows npm.cmd ComSpec 包装已处理）。
- 每任务结束 `git -C vscode commit`；提交信息英文 conventional commits，代码注释可中文（对齐现状）。
- 验证命令在 `vscode/` 目录下执行。

---

### Task 1: extensions.ts — 来源类型 / 安装路径解析 / 版本读取（纯函数）

**Files:**
- Modify: `vscode/src/chat/extensions.ts`
- Modify: `vscode/src/chat/controller.ts:1001-1013`（getExtensionList 传 opts）
- Test: `vscode/src/test/extensions.test.ts`

**Interfaces:**
- Consumes: 现有 `ExtensionItem`、`ExtensionScope`、`scanPackages`、`readSettings`。
- Produces（后续任务依赖的精确签名）:
  - `type PackageSourceKind = "npm" | "git" | "path"`
  - `packageSourceKind(source: string): PackageSourceKind`
  - `parseNpmSpec(source: string): { name: string; version?: string }`
  - `isPinnedNpmSpec(source: string): boolean`
  - `gitRef(source: string): string | undefined`
  - `gitHostPath(source: string): { host: string; path: string } | undefined`
  - `installedPackageRoot(source: string, scope: ExtensionScope, agentDir: string, projectRoot?: string): string | undefined`
  - `readPackageVersion(pkgDir: string): Promise<string | undefined>`
  - `ExtensionItem` 增可选字段 `sourceKind?: PackageSourceKind`、`version?: string`
  - `scanPackages(globalSettingsPath, projectSettingsPath?, opts?: { agentDir: string; projectRoot?: string })`（opts 必传 agentDir，富化版本）

- [ ] **Step 1: 写失败测试**

在 `vscode/src/test/extensions.test.ts` 追加（沿用现有 suite/test + tmpdir/write 辅助）：

```ts
import {
  // ...现有 imports
  installedPackageRoot,
  isPinnedNpmSpec,
  packageSourceKind,
  parseNpmSpec,
  readPackageVersion,
} from "../chat/extensions";

suite("packageSourceKind", () => {
  test("npm/git/path 三类", () => {
    assert.strictEqual(packageSourceKind("npm:pi-web-access"), "npm");
    assert.strictEqual(packageSourceKind("git:github.com/u/r"), "git");
    assert.strictEqual(packageSourceKind("https://github.com/u/r"), "git");
    assert.strictEqual(packageSourceKind("../local/pkg"), "path");
  });
});

suite("parseNpmSpec / isPinnedNpmSpec", () => {
  test("裸名 / scoped / 带版本 / 带 range", () => {
    assert.deepStrictEqual(parseNpmSpec("npm:pi-web-access"), { name: "pi-web-access" });
    assert.deepStrictEqual(parseNpmSpec("npm:@scope/pkg"), { name: "@scope/pkg" });
    assert.deepStrictEqual(parseNpmSpec("npm:@scope/pkg@2.0.0"), { name: "@scope/pkg", version: "2.0.0" });
    assert.deepStrictEqual(parseNpmSpec("npm:pkg@^1.2.3"), { name: "pkg", version: "^1.2.3" });
    assert.strictEqual(isPinnedNpmSpec("npm:pkg@1.0.0"), true);
    assert.strictEqual(isPinnedNpmSpec("npm:pkg@^1.0.0"), false);
    assert.strictEqual(isPinnedNpmSpec("npm:pkg"), false);
  });
});

suite("gitRef / gitHostPath（经 installedPackageRoot 间接验证）", () => {
  test("installedPackageRoot：全局 npm（scoped）", () => {
    assert.strictEqual(
      installedPackageRoot("npm:@scope/pkg@1.0.0", "global", "/agent"),
      path.join("/agent", "npm", "node_modules", "@scope", "pkg"),
    );
  });
  test("installedPackageRoot：项目 npm 需 projectRoot，无则 undefined", () => {
    assert.strictEqual(installedPackageRoot("npm:pkg", "project", "/agent"), undefined);
    assert.strictEqual(
      installedPackageRoot("npm:pkg", "project", "/agent", "/ws"),
      path.join("/ws", ".pi", "npm", "node_modules", "pkg"),
    );
  });
  test("installedPackageRoot：git 带/不带 ref，URL 形式", () => {
    assert.strictEqual(
      installedPackageRoot("git:github.com/obra/superpowers@v6.3.0", "global", "/agent"),
      path.join("/agent", "git", "github.com", "obra", "superpowers"),
    );
    assert.strictEqual(
      installedPackageRoot("https://github.com/u/repo", "global", "/agent"),
      path.join("/agent", "git", "github.com", "u", "repo"),
    );
  });
  test("installedPackageRoot：本地路径按 baseDir 解析", () => {
    assert.strictEqual(
      installedPackageRoot("../pkg", "global", "/agent"),
      path.resolve("/agent", "../pkg"),
    );
  });
});

suite("readPackageVersion", () => {
  test("有 version / 无 package.json / 损坏 JSON", async () => {
    const dir = await tmpdir("pinel-ver-");
    await write(path.join(dir, "package.json"), `{"name":"x","version":"1.2.3"}`);
    assert.strictEqual(await readPackageVersion(dir), "1.2.3");
    assert.strictEqual(await readPackageVersion(path.join(dir, "missing")), undefined);
    await write(path.join(dir, "bad", "package.json"), "{oops");
    assert.strictEqual(await readPackageVersion(path.join(dir, "bad")), undefined);
  });
});

suite("scanPackages 版本富化", () => {
  test("npm 包读 node_modules 版本 + sourceKind；本地散文件无版本", async () => {
    const agent = await tmpdir("pinel-scan-");
    const settings = path.join(agent, "settings.json");
    await write(settings, JSON.stringify({ packages: ["npm:foo"] }));
    await write(
      path.join(agent, "npm", "node_modules", "foo", "package.json"),
      `{"name":"foo","version":"0.9.1"}`,
    );
    const items = await scanPackages(settings, undefined, { agentDir: agent });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].sourceKind, "npm");
    assert.strictEqual(items[0].version, "0.9.1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd vscode && npx tsc -p . --noEmit 2>&1 | head -5`
Expected: 编译错误（installedPackageRoot / parseNpmSpec 等未导出）。

- [ ] **Step 3: 实现**

`vscode/src/chat/extensions.ts`：

3a. `ExtensionItem` 接口追加两个字段（放 `filtered` 之后）：

```ts
  /** 来源类型徽标（包 = npm/git/path；本地散文件扩展无）。 */
  sourceKind?: PackageSourceKind;
  /** 已装版本（安装目录 package.json 的 version；本地散文件扩展无）。 */
  version?: string;
```

类型与纯函数（放 `packageIdentity` 附近）：

```ts
/** 来源类型（行内徽标）。 */
export type PackageSourceKind = "npm" | "git" | "path";

/** 来源 spec → 类型徽标。 */
export function packageSourceKind(source: string): PackageSourceKind {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:") || /^(https?|ssh|git):\/\//.test(source)) return "git";
  return "path";
}

/** npm spec 拆解：npm:pkg / npm:pkg@1.0.0 / npm:@scope/pkg@2.0.0 → name(+version/range)。 */
export function parseNpmSpec(source: string): { name: string; version?: string } {
  const s = source.slice(4);
  const scoped = s.startsWith("@");
  const rest = scoped ? s.slice(1) : s;
  const at = rest.lastIndexOf("@");
  if (at > 0 && rest.slice(at + 1)) {
    return { name: (scoped ? "@" : "") + rest.slice(0, at), version: rest.slice(at + 1) };
  }
  return { name: s };
}

/** npm spec 是否 pinned 精确版本（无 range 修饰符）→ 更新检查跳过（对齐 pi）。 */
export function isPinnedNpmSpec(source: string): boolean {
  const { version } = parseNpmSpec(source);
  return version !== undefined && !/[\^~><*|\s]/.test(version);
}

/** git/URL spec 的 @ref（git:host/path@v1 → v1）；无 ref → undefined。 */
export function gitRef(source: string): string | undefined {
  const s = source.startsWith("git:") ? source.slice(4) : source;
  const at = s.lastIndexOf("@");
  if (at > 0 && s.indexOf("/") < at && !s.slice(at + 1).includes("/")) {
    return s.slice(at + 1) || undefined;
  }
  return undefined;
}

/** git/URL spec → host/path（去 .git、去 ref；镜像 packageIdentity 的 URL 归一）。 */
export function gitHostPath(source: string): { host: string; path: string } | undefined {
  let u: URL;
  try {
    u = source.startsWith("git:") ? new URL(`git://${source.slice(4)}`) : new URL(source);
  } catch {
    return undefined;
  }
  const p = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/@[^/]*$/, "");
  if (!u.hostname || !p) return undefined;
  return { host: u.hostname, path: p };
}

/**
 * 包安装根目录（镜像 pi package-manager 布局）：
 * npm = <base>/npm/node_modules/<name>；git = <base>/git/<host>/<path>；本地路径 = base 相对解析。
 * base：global = agentDir；project = <projectRoot>/.pi（无 projectRoot → undefined）。
 */
export function installedPackageRoot(
  source: string,
  scope: ExtensionScope,
  agentDir: string,
  projectRoot?: string,
): string | undefined {
  const base = scope === "project" ? (projectRoot ? path.join(projectRoot, ".pi") : undefined) : agentDir;
  if (!base) return undefined;
  const kind = packageSourceKind(source);
  if (kind === "npm") {
    return path.join(base, "npm", "node_modules", ...parseNpmSpec(source).name.split("/"));
  }
  if (kind === "git") {
    const hp = gitHostPath(source);
    return hp ? path.join(base, "git", hp.host, ...hp.path.split("/")) : undefined;
  }
  return path.resolve(base, source);
}

/** 读包目录 package.json 的 version；缺失/损坏 → undefined。 */
export async function readPackageVersion(pkgDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(pkgDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
```

3b. `scanPackages` 签名与富化（替换现有导出；`scanPackagesIn` 不动）：

```ts
/** 扫描 settings.json 的 packages 数组（全局 + 项目）并富化来源类型与已装版本。 */
export async function scanPackages(
  globalSettingsPath: string,
  projectSettingsPath?: string,
  opts?: { agentDir: string; projectRoot?: string },
): Promise<ExtensionItem[]> {
  const items: ExtensionItem[] = [];
  items.push(...(await scanPackagesIn(globalSettingsPath, "global")));
  if (projectSettingsPath) {
    items.push(...(await scanPackagesIn(projectSettingsPath, "project")));
  }
  const agentDir = opts?.agentDir;
  if (agentDir) {
    for (const item of items) {
      item.sourceKind = packageSourceKind(item.source);
      const root = installedPackageRoot(item.source, item.scope, agentDir, opts?.projectRoot);
      if (root) {
        item.version = await readPackageVersion(root);
      }
    }
  }
  return items;
}
```

3c. `vscode/src/chat/controller.ts` `getExtensionList` 调用点传 opts：

```ts
    const packages = await scanPackages(
      path.join(agentDir, "settings.json"),
      projectDir ? path.join(projectDir, "settings.json") : undefined,
      { agentDir, projectRoot: root ?? undefined },
    );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd vscode && npm run compile-tests && npx vscode-test --grep "packageSourceKind|parseNpmSpec|installedPackageRoot|readPackageVersion|scanPackages 版本富化"`
Expected: 全部 PASS（既有 extensions 套件不回归）。

- [ ] **Step 5: Commit**

```bash
git -C vscode add src/chat/extensions.ts src/chat/controller.ts src/test/extensions.test.ts
git -C vscode commit -m "feat(extensions): package source kind, install root resolution & installed version"
```

---

### Task 2: extension-updates.ts — 更新判定与 TTL 缓存（宿主纯模块）

**Files:**
- Create: `vscode/src/chat/extension-updates.ts`
- Test: `vscode/src/test/extension-updates.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isPinnedNpmSpec`、`parseNpmSpec`；`../rpc/client` 的 `resolveSpawnSpec`。
- Produces（Task 3 依赖）:
  - `type UpdateStatus = "available" | "current" | "unknown"`
  - `interface UpdateCheckResult { status: UpdateStatus; latestVersion?: string }`
  - `type CommandRunner = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<string>`
  - `spawnRunner: CommandRunner`（真实实现，resolveSpawnSpec + spawn 捕获 stdout）
  - `checkNpmUpdate(source: string, installedVersion: string | undefined, run: CommandRunner): Promise<UpdateCheckResult>`
  - `checkGitUpdate(installPath: string, run: CommandRunner): Promise<UpdateCheckResult>`
  - `class UpdateCheckCache`（`get(key)` / `set(key, result)` / `clear()`；`constructor(ttlMs = 600_000, now = Date.now)`）

- [ ] **Step 1: 写失败测试**

`vscode/src/test/extension-updates.test.ts`（新文件，mocha 风格对齐现有套件）：

```ts
import * as assert from "assert";
import { UpdateCheckCache, checkGitUpdate, checkNpmUpdate, type CommandRunner } from "../chat/extension-updates";

/** 脚本化假 runner：按 (cmd+args 前缀) 依次出队 {stdout} 或 Error。 */
function fakeRunner(script: Array<{ match: string; stdout?: string; error?: Error }>): CommandRunner {
  let calls = 0;
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const step = script.find((s) => key.startsWith(s.match));
    assert.ok(step, `unexpected command: ${key}`);
    calls++;
    if (step.error) return Promise.reject(step.error);
    return Promise.resolve(step.stdout ?? "");
  };
}

suite("checkNpmUpdate", () => {
  test("pinned 精确版本 → current（不 spawn）", async () => {
    const result = await checkNpmUpdate("npm:pkg@1.0.0", "1.0.0", fakeRunner([]));
    assert.deepStrictEqual(result, { status: "current" });
  });
  test("远端更新 → available + latestVersion", async () => {
    const run = fakeRunner([{ match: "npm view", stdout: `"2.0.0"\n` }]);
    assert.deepStrictEqual(await checkNpmUpdate("npm:pkg", "1.0.0", run), {
      status: "available",
      latestVersion: "2.0.0",
    });
  });
  test("版本相同 → current", async () => {
    const run = fakeRunner([{ match: "npm view", stdout: `"1.0.0"` }]);
    assert.deepStrictEqual(await checkNpmUpdate("npm:pkg", "1.0.0", run), { status: "current" });
  });
  test("runner 抛错 / 空输出 / 非 JSON → unknown", async () => {
    assert.deepStrictEqual(
      await checkNpmUpdate("npm:pkg", "1.0.0", fakeRunner([{ match: "npm view", error: new Error("offline") }])),
      { status: "unknown" },
    );
    assert.deepStrictEqual(
      await checkNpmUpdate("npm:pkg", "1.0.0", fakeRunner([{ match: "npm view", stdout: "" }])),
      { status: "unknown" },
    );
    assert.deepStrictEqual(
      await checkNpmUpdate("npm:pkg", "1.0.0", fakeRunner([{ match: "npm view", stdout: "not-json" }])),
      { status: "unknown" },
    );
  });
  test("无已装版本 → unknown", async () => {
    assert.deepStrictEqual(await checkNpmUpdate("npm:pkg", undefined, fakeRunner([])), { status: "unknown" });
  });
});

suite("checkGitUpdate", () => {
  const LOCAL = "aaa", REMOTE = "bbb";
  const revParse = (head: string) => ({ match: "git rev-parse HEAD", stdout: `${head}\n` });

  test("远端 HEAD 不同 → available", async () => {
    const run = fakeRunner([
      revParse(LOCAL),
      { match: "git rev-parse --abbrev-ref", error: new Error("no upstream") },
      { match: "git ls-remote", stdout: `${REMOTE}\tHEAD\n` },
    ]);
    assert.deepStrictEqual(await checkGitUpdate("/pkg", run), { status: "available" });
  });
  test("有 upstream：按 upstream ref ls-remote，相同 → current", async () => {
    const run = fakeRunner([
      revParse(LOCAL),
      { match: "git rev-parse --abbrev-ref", stdout: "origin/main\n" },
      { match: "git ls-remote origin origin/main", stdout: `${LOCAL}\trefs/heads/main\n` },
    ]);
    assert.deepStrictEqual(await checkGitUpdate("/pkg", run), { status: "current" });
  });
  test("失败 → unknown", async () => {
    const run = fakeRunner([revParse(LOCAL), { match: "git rev-parse --abbrev-ref", error: new Error("x") }, { match: "git ls-remote", error: new Error("net") }]);
    assert.deepStrictEqual(await checkGitUpdate("/pkg", run), { status: "unknown" });
  });
});

suite("UpdateCheckCache", () => {
  test("TTL 内命中、过期失效、clear 清空", () => {
    let now = 1000;
    const cache = new UpdateCheckCache(600_000, () => now);
    cache.set("k", { status: "current" });
    assert.deepStrictEqual(cache.get("k"), { status: "current" });
    now += 599_999;
    assert.deepStrictEqual(cache.get("k"), { status: "current" });
    now += 2;
    assert.strictEqual(cache.get("k"), undefined);
    cache.set("k2", { status: "available", latestVersion: "2.0.0" });
    cache.clear();
    assert.strictEqual(cache.get("k2"), undefined);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd vscode && npx tsc -p . --noEmit 2>&1 | head -5`
Expected: 找不到模块 `../chat/extension-updates`。

- [ ] **Step 3: 实现**

`vscode/src/chat/extension-updates.ts`（新文件）：

```ts
import { spawn } from "node:child_process";
import { resolveSpawnSpec } from "../rpc/client";
import { isPinnedNpmSpec, parseNpmSpec } from "./extensions";

/**
 * 扩展更新检测（纯逻辑 + 注入 runner，可单测；宿主编排见 controller）。
 * - npm：`npm view <name> version --json`，latest ≠ installed → available（字符串比较，
 *   不引入 semver；range spec 的「最新」歧义由幂等 `pi update` 兜底）。
 *   ponytail: 精确 pinned spec 与 pi 行为一致跳过；预发布版本差异可能误报 available。
 * - git：local HEAD vs 远端（upstream ref 优先，回退 origin/HEAD，镜像 pi gitHasAvailableUpdate）。
 * - 失败/超时/离线 → unknown（UI 不显示 Update 按钮，不报错）。
 */

/** 更新状态。 */
export type UpdateStatus = "available" | "current" | "unknown";

export interface UpdateCheckResult {
  status: UpdateStatus;
  /** npm 远端最新版（tooltip 展示用；git 不带）。 */
  latestVersion?: string;
}

/** 命令运行器：成功 resolve stdout；失败/超时 reject。测试注入替身。 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<string>;

/** 真实 runner：resolveSpawnSpec（Windows npm.cmd ComSpec 包装复用 rpc/client）+ spawn 捕获 stdout。 */
export function spawnRunner(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const spec = resolveSpawnSpec(cmd, args, opts.cwd ?? process.cwd());
    const child = spawn(spec.cmd, spec.args, spec.options);
    let out = "";
    let err = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined = setTimeout(() => {
      child.kill();
    }, opts.timeoutMs ?? 15000);
    const done = (finish: () => void) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        finish();
      }
    };
    child.stdout?.on("data", (d: Buffer | string) => (out += String(d)));
    child.stderr?.on("data", (d: Buffer | string) => (err += String(d)));
    child.on("error", (e) => done(() => reject(e)));
    // 超时 kill 后 close 以非零码到达 → 走 reject 分支；timer 里同步 reject 防御 kill 不触发 close
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      done(() => reject(new Error(`${cmd} timed out`)));
    }, opts.timeoutMs ?? 15000);
    child.on("close", (code) =>
      done(() => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited with code ${code}`)))),
    );
  });
}

/** npm 更新检查（pinned 跳过；latest ≠ installed → available）。 */
export async function checkNpmUpdate(
  source: string,
  installedVersion: string | undefined,
  run: CommandRunner,
): Promise<UpdateCheckResult> {
  if (isPinnedNpmSpec(source)) return { status: "current" };
  if (!installedVersion) return { status: "unknown" };
  try {
    const stdout = await run("npm", ["view", parseNpmSpec(source).name, "version", "--json"], { timeoutMs: 15000 });
    const raw = stdout.trim();
    if (!raw) return { status: "unknown" };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "string" || !parsed) return { status: "unknown" };
    return parsed === installedVersion ? { status: "current" } : { status: "available", latestVersion: parsed };
  } catch {
    return { status: "unknown" };
  }
}

/** git 更新检查：upstream ref 优先 ls-remote，回退 origin/HEAD。 */
export async function checkGitUpdate(installPath: string, run: CommandRunner): Promise<UpdateCheckResult> {
  try {
    const local = (await run("git", ["rev-parse", "HEAD"], { cwd: installPath, timeoutMs: 15000 })).trim();
    let upstream: string | undefined;
    try {
      upstream = (await run("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: installPath, timeoutMs: 10000 })).trim();
    } catch {
      // 无 upstream 分支：回退 origin/HEAD
    }
    const remote = await run(
      "git",
      upstream ? ["ls-remote", "origin", upstream] : ["ls-remote", "origin", "HEAD"],
      { cwd: installPath, timeoutMs: 20000 },
    );
    const m = remote.match(/^([0-9a-f]{40})\s/m);
    if (!m) return { status: "unknown" };
    return m[1] === local ? { status: "current" } : { status: "available" };
  } catch {
    return { status: "unknown" };
  }
}

/** 更新检查结果缓存（内存 Map + TTL；手动刷新 force 绕过）。now 注入便于测试。 */
export class UpdateCheckCache {
  private readonly entries = new Map<string, { result: UpdateCheckResult; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 600_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): UpdateCheckResult | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() >= e.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return e.result;
  }

  set(key: string, result: UpdateCheckResult): void {
    this.entries.set(key, { result, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}
```

注意：上面 `spawnRunner` 里第一个 `let timer = setTimeout(...)` 是笔误路径——实现时只保留**一个** setTimeout（第二个带 reject 的），删除第一个。最终成品只有一个定时器。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd vscode && npm run compile-tests && npx vscode-test --grep "checkNpmUpdate|checkGitUpdate|UpdateCheckCache"`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git -C vscode add src/chat/extension-updates.ts src/test/extension-updates.test.ts
git -C vscode commit -m "feat(updates): npm/git update check with injectable runner and TTL cache"
```

---

### Task 3: controller — 检查 / 更新 / 批量更新编排

**Files:**
- Modify: `vscode/src/chat/controller.ts`（extensions import 列表 + uninstallExtension 之后新增方法；类字段加 updateCache）

**Interfaces:**
- Consumes: Task 1 全部导出；Task 2 的 `UpdateCheckResult`、`UpdateStatus`、`UpdateCheckCache`、`spawnRunner`、`checkNpmUpdate`、`checkGitUpdate`；现有 `runPiCommand`、`resolvePiCommand`、`defaultAgentDir`、`notice`。
- Produces（Task 4 panel 依赖）:
  - `interface ExtensionUpdateEntry { id: string; kind: ExtensionKind; scope: ExtensionScope; status: UpdateStatus; latestVersion?: string }`（controller.ts 导出）
  - `checkExtensionUpdates(view: ExtensionView, force: boolean): Promise<ExtensionUpdateEntry[]>`
  - `updateExtension(id: string, kind: ExtensionKind, scope: ExtensionScope, source: string, inherited: boolean): Promise<void>`
  - `updateAllExtensions(entries: Array<{ id: string; kind: ExtensionKind; scope: ExtensionScope; source: string; inherited: boolean }>): Promise<void>`

- [ ] **Step 1: 实现（编排薄 glue，逻辑已在 Task 1/2 单测覆盖；对齐 installCatalogEntries/removePackageViaCli 现有模式）**

`vscode/src/chat/controller.ts`：

3a. import 追加：

```ts
import {
  // ...现有
  gitRef,
  installedPackageRoot,
  packageSourceKind,
  readPackageVersion,
} from "./extensions";
import {
  UpdateCheckCache,
  checkGitUpdate,
  checkNpmUpdate,
  spawnRunner,
  type UpdateCheckResult,
  type UpdateStatus,
} from "./extension-updates";
```

3b. 更新条目类型（放 ExtensionUpdate 相关导出区，controller.ts 底部导出区附近）：

```ts
/** 扩展更新检查条目（webview 按行键合并）。 */
export interface ExtensionUpdateEntry {
  id: string;
  kind: ExtensionKind;
  scope: ExtensionScope;
  status: UpdateStatus;
  latestVersion?: string;
}
```

3c. 类字段（updateCache 紧邻其他私有字段）：

```ts
  /** 更新检查结果缓存（10 分钟 TTL；手动刷新 force 绕过）。 */
  private readonly updateCache = new UpdateCheckCache();
```

3d. 方法（放 `uninstallExtension` 之后）：

```ts
  /**
   * 更新检查（扩展弹层数据）：包条目并发检查（npm view / git ls-remote），带 TTL 缓存。
   * inherited 行实际装在全局 → effectiveScope=global。失败 → unknown（不抛）。
   * ponytail: Promise.all 无并发上限——典型 N < 30，超限再加分批。
   */
  async checkExtensionUpdates(view: ExtensionView, force: boolean): Promise<ExtensionUpdateEntry[]> {
    const items = (await this.getExtensionList(view)).filter((i) => i.kind === "package");
    const agentDir = defaultAgentDir();
    const projectRoot = this.workspaceRoot ?? undefined;
    return Promise.all(
      items.map(async (item): Promise<ExtensionUpdateEntry> => {
        const effectiveScope: ExtensionScope = item.inherited ? "global" : item.scope;
        const key = `${effectiveScope}:${item.source}`;
        const cached = force ? undefined : this.updateCache.get(key);
        const result = cached ?? (await this.checkPackageUpdate(item, effectiveScope, agentDir, projectRoot));
        this.updateCache.set(key, result);
        return { id: item.id, kind: item.kind, scope: item.scope, ...result };
      }),
    );
  }

  /** 单包更新判定（安装路径 → npm/git 分支；pinned git ref / 本地路径 → current/unknown）。 */
  private async checkPackageUpdate(
    item: ExtensionItem,
    scope: ExtensionScope,
    agentDir: string,
    projectRoot?: string,
  ): Promise<UpdateCheckResult> {
    const root = installedPackageRoot(item.source, scope, agentDir, projectRoot);
    if (!root) return { status: "unknown" };
    const kind = packageSourceKind(item.source);
    if (kind === "npm") {
      return checkNpmUpdate(item.source, item.version ?? (await readPackageVersion(root)), spawnRunner);
    }
    if (kind === "git") {
      if (gitRef(item.source)) return { status: "current" }; // pinned ref 对齐 pi 跳过
      return checkGitUpdate(root, spawnRunner);
    }
    return { status: "unknown" }; // 本地路径包：无远端概念
  }

  /**
   * 单包更新：官方 `pi update <source> [-l]`（安装布局/依赖由 pi 维护）。
   * inherited 行实际装在全局 → 更新全局（不带 -l，cwd=agentDir）。
   */
  async updateExtension(
    id: string,
    kind: ExtensionKind,
    scope: ExtensionScope,
    source: string,
    inherited: boolean,
  ): Promise<void> {
    if (kind !== "package") return;
    const effectiveScope = inherited ? "global" : scope;
    try {
      const command = this.resolvePiCommand();
      const args = ["update", source, ...(effectiveScope === "project" ? ["-l"] : [])];
      const cwd = effectiveScope === "project" ? (this.workspaceRoot ?? defaultAgentDir()) : defaultAgentDir();
      await runPiCommand(command, args, cwd, 120000);
      this.updateCache.clear();
      this.notice("info", `Updated ${packageDisplayName(source)}. Restart pi to activate.`);
    } catch (err) {
      this.notice("error", `Failed to update ${packageDisplayName(source)}: ${(err as Error).message}`);
    }
  }

  /** 批量更新：串行（同一 npm prefix 并发 install 不安全），单包失败继续。 */
  async updateAllExtensions(
    entries: Array<{ id: string; kind: ExtensionKind; scope: ExtensionScope; source: string; inherited: boolean }>,
  ): Promise<void> {
    for (const e of entries) {
      await this.updateExtension(e.id, e.kind, e.scope, e.source, e.inherited);
    }
  }
```

（`packageDisplayName` 已在现有 import 列表中——若无需补。`ExtensionItem` 类型如未 import 需补 type import。）

- [ ] **Step 2: 类型检查通过**

Run: `cd vscode && npx tsc -p . --noEmit`
Expected: 无错误。

（编排 glue 与 installCatalogEntries/removePackageViaCli 同级覆盖策略：不直接单测；纯逻辑已在 Task 1/2 覆盖，集成路径经现有假 pi 测试架与手动 smoke 验证。）

- [ ] **Step 3: Commit**

```bash
git -C vscode add src/chat/controller.ts
git -C vscode commit -m "feat(controller): extension update check / update / update-all orchestration"
```

---

### Task 4: 协议镜像 + panel 消息接线

**Files:**
- Modify: `vscode/src/chat/panel.ts`（消息接口 + union + 三个 case + postExtensionUpdates）
- Modify: `vscode/webview-ui/src/types.ts`（ExtensionItem 字段 + ExtensionUpdateEntry + HostMessage 分支）

**Interfaces:**
- Consumes: Task 3 的 `checkExtensionUpdates` / `updateExtension` / `updateAllExtensions` / `ExtensionUpdateEntry`；现有 `confirmExtensionReload`、`postExtensionList`、`lastExtensionView`。
- Produces（Task 5/6 依赖）:
  - webview→host 消息：`checkExtensionUpdates { view?, force? }`、`updateExtension { id, kind, scope, source, inherited? }`、`updateAllExtensions { entries: [...] }`
  - host→webview 消息：`extensionUpdates { entries: ExtensionUpdateEntry[] }`
  - webview `ExtensionItem` 增 `sourceKind?: "npm" | "git" | "path"`、`version?: string`、`update?: "available" | "current" | "unknown"`、`latestVersion?: string`

- [ ] **Step 1: panel.ts 消息接口（放 WebviewUninstallExtensionMessage 之后）**

```ts
interface WebviewCheckExtensionUpdatesMessage {
  type: "checkExtensionUpdates";
  /** 弹层视图（默认沿用最近请求）。 */
  view?: "all" | "global" | "project";
  /** 手动刷新：绕过 TTL 缓存。 */
  force?: boolean;
}

interface WebviewUpdateExtensionMessage {
  type: "updateExtension";
  id: string;
  kind: "local" | "package";
  scope: "global" | "project";
  source: string;
  /** inherited 行实际装在全局（更新走全局）。 */
  inherited?: boolean;
}

interface WebviewUpdateAllExtensionsMessage {
  type: "updateAllExtensions";
  entries: Array<{
    id: string;
    kind: "local" | "package";
    scope: "global" | "project";
    source: string;
    inherited?: boolean;
  }>;
}
```

加入 union（`WebviewMessage = ... | WebviewCheckExtensionUpdatesMessage | WebviewUpdateExtensionMessage | WebviewUpdateAllExtensionsMessage`）。

- [ ] **Step 2: panel.ts 消息处理（onMessage switch，uninstallExtension case 之后）**

```ts
      case "checkExtensionUpdates":
        void this.postExtensionUpdates(msg.view ?? this.lastExtensionView, msg.force === true);
        break;
      case "updateExtension":
        void (async () => {
          await this.controller.updateExtension(msg.id, msg.kind, msg.scope, msg.source, msg.inherited === true);
          await this.postExtensionList();
          await this.postExtensionUpdates(this.lastExtensionView, true);
          if (await confirmExtensionReload()) {
            await this.controller.restart();
          }
        })();
        break;
      case "updateAllExtensions":
        void (async () => {
          await this.controller.updateAllExtensions(
            msg.entries.map((e) => ({ ...e, inherited: e.inherited === true })),
          );
          await this.postExtensionList();
          await this.postExtensionUpdates(this.lastExtensionView, true);
          if (await confirmExtensionReload()) {
            await this.controller.restart();
          }
        })();
        break;
```

- [ ] **Step 3: panel.ts postExtensionUpdates（postExtensionList 之后）**

```ts
  /** 更新检查结果回发（打开弹层/手动刷新/更新完成后；force 绕过缓存）。 */
  private async postExtensionUpdates(view: "all" | "global" | "project", force: boolean): Promise<void> {
    try {
      const entries = await this.controller.checkExtensionUpdates(view, force);
      this.post({ type: "extensionUpdates", entries });
    } catch {
      // 检查异常：静默（行保持 unknown/旧值，不弹 notice）
    }
  }
```

- [ ] **Step 4: webview types.ts 镜像**

4a. `ExtensionItem` 追加：

```ts
  /** 来源类型徽标（包 = npm/git/path；本地散文件扩展无）。 */
  sourceKind?: "npm" | "git" | "path";
  /** 已装版本（安装目录 package.json 的 version；本地散文件扩展无）。 */
  version?: string;
  /** 更新态（extensionUpdates 消息合并产物；缺省 = 未检查）。 */
  update?: "available" | "current" | "unknown";
  /** npm 远端最新版（update=available 时有值）。 */
  latestVersion?: string;
```

4b. 类型定义（ExtensionItem 之后）：

```ts
/** 扩展更新检查条目（宿主 extensionUpdates 消息载荷；webview 按行键合并进 items）。 */
export interface ExtensionUpdateEntry {
  id: string;
  kind: ExtensionKind;
  scope: ExtensionScope;
  status: "available" | "current" | "unknown";
  latestVersion?: string;
}
```

4c. `HostMessage` union 追加分支：

```ts
  | { type: "extensionUpdates"; entries: ExtensionUpdateEntry[] }
```

- [ ] **Step 5: 类型检查 + 编译**

Run: `cd vscode && npm run check-types`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git -C vscode add src/chat/panel.ts webview-ui/src/types.ts
git -C vscode commit -m "feat(protocol): extensionUpdates message + update/check/update-all webview messages"
```

---

### Task 5: webview 纯合并模块 + check.mjs 自检

**Files:**
- Create: `vscode/webview-ui/src/extension-updates.ts`
- Create: `vscode/webview-ui/extension-updates.check.mjs`
- Modify: `vscode/package.json`（scripts：check:extension-updates + 接入 compile/package 链）

**Interfaces:**
- Consumes: webview `types.ts` 的 `ExtensionItem`、`ExtensionUpdateEntry`（Task 4）。
- Produces（Task 6 依赖）:
  - `extensionRowKey(item: ExtensionItem): string`
  - `mergeExtensionUpdates(items: ExtensionItem[], entries: ExtensionUpdateEntry[]): ExtensionItem[]`
  - `updatableItems(items: ExtensionItem[]): ExtensionItem[]`

- [ ] **Step 1: 写失败自检**

`vscode/webview-ui/extension-updates.check.mjs`（模式对齐 at-refs.check.mjs）：

```ts
/**
 * extension-updates 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：更新态合并/行键/可升级筛选坏掉时编译即红。
 */
import assert from "node:assert";
import { extensionRowKey, mergeExtensionUpdates, updatableItems } from "./src/extension-updates.ts";

const item = (over: Record<string, unknown>) => ({
  id: "npm:foo", kind: "package", name: "foo", scope: "global", enabled: true, source: "npm:foo", ...over,
});

const base = [item({}), item({ id: "bar", source: "bar", name: "bar" })];

// 行键 = React key 同构（kind:scope:id）
assert.strictEqual(extensionRowKey(base[0]), "package:global:npm:foo");

// 合并：命中行附 update/latestVersion，未命中行不动
const merged = mergeExtensionUpdates(base, [
  { id: "npm:foo", kind: "package", scope: "global", status: "available", latestVersion: "2.0.0" },
  { id: "ghost", kind: "package", scope: "global", status: "current" },
]);
assert.strictEqual(merged[0].update, "available");
assert.strictEqual(merged[0].latestVersion, "2.0.0");
assert.strictEqual(merged[0].version, undefined); // 不伪造未下发的字段
assert.strictEqual(merged[1].update, undefined);

// 空条目 → 原样（浅拷贝）
assert.deepStrictEqual(mergeExtensionUpdates(base, []), base);

// 可升级筛选：仅 update=available
assert.deepStrictEqual(updatableItems(merged).map((i) => i.id), ["npm:foo"]);
assert.deepStrictEqual(updatableItems(base), []);

console.log("extension-updates check ok");
```

- [ ] **Step 2: 跑自检确认失败**

Run: `cd vscode && npm run check:extension-updates`
Expected: 脚本不存在/找不到模块（先加 npm script 才能跑：见 Step 3 一并加，或直接 `node --experimental-strip-types webview-ui/extension-updates.check.mjs` 确认 Cannot find module）。

- [ ] **Step 3: 实现 + 接线 npm script**

`vscode/webview-ui/src/extension-updates.ts`：

```ts
import type { ExtensionItem, ExtensionUpdateEntry } from "./types";

/**
 * 扩展更新态 webview 纯逻辑：行键（与 ExtensionPopover React key 同构）、
 * 列表合并（App 双状态 extensions + updateEntries 的 useMemo 产物）、可升级筛选。
 */

/** 行键（kind:scope:id，与 ExtensionPopover 渲染 key 一致）。 */
export function extensionRowKey(item: ExtensionItem): string {
  return `${item.kind}:${item.scope}:${item.id}`;
}

/** 合并更新态到列表（返回新数组；无匹配条目的行保持原状）。 */
export function mergeExtensionUpdates(
  items: ExtensionItem[],
  entries: ExtensionUpdateEntry[],
): ExtensionItem[] {
  const byKey = new Map(entries.map((e) => [extensionRowKey(e), e]));
  return items.map((i) => {
    const e = byKey.get(extensionRowKey(i));
    return e ? { ...i, update: e.status, latestVersion: e.latestVersion } : i;
  });
}

/** 有更新可升级的行（Update all 目标）。 */
export function updatableItems(items: ExtensionItem[]): ExtensionItem[] {
  return items.filter((i) => i.update === "available");
}
```

注意 `extensionRowKey(e)` 直接复用于 entry（字段同名 kind/scope/id）——TS 结构类型天然兼容，无需二次实现键逻辑。

`vscode/package.json` scripts：

```json
    "check:extension-updates": "node --experimental-strip-types webview-ui/extension-updates.check.mjs",
```

并把 `npm run check:extension-updates` 追加进 `compile` 与 `package` 两条链（`check:pinel-payload` 之后）。

- [ ] **Step 4: 跑自检确认通过**

Run: `cd vscode && npm run check:extension-updates`
Expected: `extension-updates check ok`。

- [ ] **Step 5: Commit**

```bash
git -C vscode add webview-ui/src/extension-updates.ts webview-ui/extension-updates.check.mjs package.json
git -C vscode commit -m "feat(webview): update-state merge pure module + compile-gate check"
```

---

### Task 6: webview UI — 版本/徽标/更新按钮/Update all/手动刷新

**Files:**
- Modify: `vscode/webview-ui/src/components/ExtensionPopover.tsx`
- Modify: `vscode/webview-ui/src/App.tsx`
- Modify: `vscode/webview-ui/src/styles.css`

**Interfaces:**
- Consumes: Task 4 的消息协议与 ExtensionItem 字段；Task 5 的 `extensionRowKey`/`updatableItems`/`mergeExtensionUpdates`；现有 `ExtensionItem`、`ExtensionView`。
- Produces: 完整 UI（无后续任务依赖）。

- [ ] **Step 1: App.tsx 状态与消息接线**

1a. import 追加：

```ts
import { extensionRowKey, mergeExtensionUpdates, updatableItems } from "./extension-updates";
import type { ExtensionUpdateEntry } from "./types"; // 并入现有 types import
import { useMemo } from "react"; // 并入现有 react import
```

1b. 状态（extensionView 状态旁）：

```ts
  /** 更新检查条目（extensionUpdates 消息填充；与 extensions 经 useMemo 合并渲染）。 */
  const [updateEntries, setUpdateEntries] = useState<ExtensionUpdateEntry[]>([]);
  /** 更新中的行键（乐观置忙；extensionList/extensionUpdates 到达即清）。 */
  const [updatingKeys, setUpdatingKeys] = useState<Set<string>>(new Set());
  /** 合并更新态的列表（ExtensionPopover 渲染源）。 */
  const mergedExtensions = useMemo(
    () => mergeExtensionUpdates(extensions, updateEntries),
    [extensions, updateEntries],
  );
```

1c. 消息 case（`case "extensionList"` 内追加一行；新增 case 放其后）：

```ts
      case "extensionList":
        // ...现有 setExtensions/setExtensionProjectAvailable 保持
        setUpdatingKeys(new Set()); // 更新流程后列表重发 = 清乐观忙态
        break;
      case "extensionUpdates":
        setUpdateEntries(msg.entries);
        setUpdatingKeys(new Set());
        break;
```

1d. 动作（openExtensions/changeExtensionView 附近）：

```ts
  // 更新检查：弹层打开/视图切换自动（force=false）；标题栏刷新按钮 force=true 绕过缓存
  const checkExtensionUpdates = (force: boolean) => {
    vscode.postMessage({
      type: "checkExtensionUpdates",
      view: extensionView === "catalog" ? "all" : extensionView,
      force,
    });
  };

  // 单行 / 批量更新：乐观置忙，结果经 extensionList + extensionUpdates 回流清除
  const updateExtensionItem = (item: ExtensionItem) => {
    setUpdatingKeys((prev) => new Set(prev).add(extensionRowKey(item)));
    vscode.postMessage({
      type: "updateExtension",
      id: item.id, kind: item.kind, scope: item.scope, source: item.source,
      inherited: item.inherited === true,
    });
  };

  const updateAllExtensionItems = (targets: ExtensionItem[]) => {
    setUpdatingKeys((prev) => {
      const next = new Set(prev);
      for (const i of targets) next.add(extensionRowKey(i));
      return next;
    });
    vscode.postMessage({
      type: "updateAllExtensions",
      entries: targets.map((i) => ({
        id: i.id, kind: i.kind, scope: i.scope, source: i.source, inherited: i.inherited === true,
      })),
    });
  };
```

`openExtensions` 与 `changeExtensionView`（非 catalog 分支）各追加：

```ts
    vscode.postMessage({ type: "checkExtensionUpdates", view: /* 同 getExtensionList 的 view */, force: false });
```

1e. `<ExtensionPopover ...>` props 改为 `items={mergedExtensions}` 并追加 `updating={updatingKeys}`、`onCheckUpdates={checkExtensionUpdates}`、`onUpdate={updateExtensionItem}`、`onUpdateAll={updateAllExtensionItems}`。

- [ ] **Step 2: ExtensionPopover.tsx 渲染**

2a. import 与 Props 追加：

```ts
import { extensionRowKey, updatableItems } from "../extension-updates";
import refreshIcon from "lucide-static/icons/refresh-cw.svg";
```

```ts
  /** 更新中的行键（按钮置忙防重复点击）。 */
  updating: Set<string>;
  /** 手动刷新更新检查（force 绕过缓存）。 */
  onCheckUpdates: (force: boolean) => void;
  /** 单行更新（官方 pi update 路径）。 */
  onUpdate: (item: ExtensionItem) => void;
  /** 全部更新（targets = updatableItems）。 */
  onUpdateAll: (targets: ExtensionItem[]) => void;
```

2b. `renderRow` 行主体（`extension-item-main` 内，scope 徽标前加来源徽标、name 后加版本与更新按钮——按钮放 main 区尾部，toggle/delete 保持在外）：

```tsx
  const renderRow = (item: ExtensionItem) => {
    const busy = updating.has(extensionRowKey(item));
    return (
      <div key={`${item.kind}:${item.scope}:${item.id}`} className={`extension-item${item.inherited ? " inherited" : ""}`}>
        <div className="extension-item-main">
          <span className="extension-item-name" title={item.source}>
            {item.name}
          </span>
          {item.sourceKind && (
            <span className="extension-item-badge kind">{item.sourceKind}</span>
          )}
          <span className="extension-item-badge">{item.inherited ? "inherited" : item.scope}</span>
          {item.filtered && <span className="extension-item-tag">filtered</span>}
          <span className="extension-item-version">{item.version ?? "—"}</span>
          {item.update === "available" && (
            <button
              className="extension-item-update-btn"
              disabled={busy}
              title={
                item.latestVersion
                  ? `Installed ${item.version ?? "?"} → latest ${item.latestVersion}`
                  : "Update available"
              }
              onClick={() => onUpdate(item)}
            >
              {busy ? "Updating…" : "Update"}
            </button>
          )}
        </div>
        {/* 现有 toggle / delete 按钮保持不动 */}
      </div>
    );
  };
```

（inherited 行同样显示 Update——更新作用于全局安装，title 不变。）

2c. 标题栏（`popover-titlebar` 内，close 按钮前；管理视图才显示 Update all）：

```tsx
  const updatable = view !== "catalog" ? updatableItems(items) : [];
  const updateAllBusy = updatable.some((i) => updating.has(extensionRowKey(i)));
  // ...titlebar JSX：
        {updatable.length > 0 && (
          <button
            className="extension-update-all"
            disabled={updateAllBusy}
            title={`pi update ${updatable.length} package${updatable.length === 1 ? "" : "s"}`}
            onClick={() => onUpdateAll(updatable)}
          >
            {updateAllBusy ? "Updating…" : `Update all (${updatable.length})`}
          </button>
        )}
        <button
          className="popover-refresh"
          aria-label="Check for updates"
          title="Check for updates"
          onClick={() => onCheckUpdates(true)}
          dangerouslySetInnerHTML={{ __html: refreshIcon }}
        />
```

（refresh 按钮在 catalog 视图也保留——切回管理视图即用最新缓存；catalog 自身无更新行。）

- [ ] **Step 3: styles.css（追加到 extension 系列样式区）**

```css
/* 来源徽标（npm/git/path）：弱化底色区分于 scope 徽标 */
.extension-item-badge.kind {
  background: transparent;
  border: 1px solid var(--vscode-input-border);
  color: var(--vscode-descriptionForeground);
}

/* 已装版本（暗色小字；无版本 = —） */
.extension-item-version {
  flex: none;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}

/* 行内更新按钮（有更新才渲染） */
.extension-item-update-btn {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 10px;
  cursor: pointer;
}

.extension-item-update-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 标题栏 Update all */
.extension-update-all {
  flex: none;
  margin-right: 6px;
  padding: 1px 8px;
  border: none;
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 11px;
  cursor: pointer;
}

.extension-update-all:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 标题栏手动刷新（对齐 popover-close 尺寸；内联 SVG stroke=currentColor） */
.popover-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  margin-left: 4px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
}

.popover-refresh:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}

.popover-refresh svg {
  width: 12px;
  height: 12px;
}
```

确认 `.popover-titlebar` 有 `display:flex; align-items:center;`（若无则补），title 加 `margin-right: auto` 让按钮靠右。

- [ ] **Step 4: 全量编译门**

Run: `cd vscode && npm run compile`
Expected: check-types / 全部 check:* （含新 extension-updates）/ lint / esbuild（宿主 + webview）全绿。

- [ ] **Step 5: 手动 smoke（可选但推荐）**

F5 启动扩展开发宿主 → 打开 Pinel 面板 → 信息条 Extensions chip：
- 包行显示 `[npm] [global] 1.2.3` 样徽标与版本
- 有过时包（如降低 node_modules 内某包版本字段）→ 数秒后行尾出现 Update
- 点 Update → Updating… → 完成后 reload 提示 → 重启后版本更新
- 标题栏 refresh 强制重查；Update all (N) 批量串行

- [ ] **Step 6: 跑测试套件**

Run: `cd vscode && npm test`
Expected: 全部通过（含 Task 1/2 新增用例；既有套件无回归）。

- [ ] **Step 7: Commit**

```bash
git -C vscode add webview-ui/src/components/ExtensionPopover.tsx webview-ui/src/App.tsx webview-ui/src/styles.css
git -C vscode commit -m "feat(webview): version/source badges, per-row update, update-all & manual refresh in extensions popover"
```

---

## Self-Review 结论

- **Spec 覆盖**：项目/全局生效控制、ON/OFF、卸载 → 既有功能（66a1c65/838b219），无回归改动；当前版本（Task 1 + Task 6 显示）、来源（Task 1 sourceKind + Task 6 徽标）、是否需要更新（Task 2 检测 + Task 5 合并 + Task 6 指示）、一键更新（Task 3/6）、手动刷新（Task 4 force + Task 6 按钮）全覆盖。
- **占位符扫描**：无 TBD/TODO；Task 2 Step 3 中标注了一处实现期笔误修正（单 timer），已显式说明。
- **类型一致性**：`ExtensionUpdateEntry` 字段在 controller（Task 3）、panel（Task 4）、webview types（Task 4）、check.mjs（Task 5）四处一致（id/kind/scope/status/latestVersion）；行键 `${kind}:${scope}:${id}` 与 React key 同构，entry 复用 `extensionRowKey`。
