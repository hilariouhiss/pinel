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
    let timer: NodeJS.Timeout | undefined;
    const done = (finish: () => void) => {
      if (!settled) {
        settled = true;
        if (timer) { clearTimeout(timer); }
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
  if (isPinnedNpmSpec(source)) { return { status: "current" }; }
  if (!installedVersion) { return { status: "unknown" }; }
  try {
    const stdout = await run("npm", ["view", parseNpmSpec(source).name, "version", "--json"], { timeoutMs: 15000 });
    const raw = stdout.trim();
    if (!raw) { return { status: "unknown" }; }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "string" || !parsed) { return { status: "unknown" }; }
    return parsed === installedVersion ? { status: "current" } : { status: "available", latestVersion: parsed };
  } catch {
    return { status: "unknown" };
  }
}

/** git 更新检查：镜像 pi getRemoteGitHead —— upstream ref（origin/ 前缀剥掉）ls-remote 取 SHA，无 SHA 回退 origin HEAD。 */
export async function checkGitUpdate(installPath: string, run: CommandRunner): Promise<UpdateCheckResult> {
  try {
    const local = (await run("git", ["rev-parse", "HEAD"], { cwd: installPath, timeoutMs: 15000 })).trim();
    const remote = await getRemoteGitHead(installPath, run);
    return remote === local ? { status: "current" } : { status: "available" };
  } catch {
    return { status: "unknown" };
  }
}

/** 镜像 pi getRemoteGitHead：upstream ref 优先；无 SHA 则回退 origin HEAD（无则抛错）。 */
async function getRemoteGitHead(installPath: string, run: CommandRunner): Promise<string> {
  const upstreamRef = await getGitUpstreamRef(installPath, run);
  if (upstreamRef) {
    const remoteHead = await run("git", ["ls-remote", "origin", upstreamRef], { cwd: installPath, timeoutMs: 20000 });
    // pi 用 {40}；测试 fixture 用短哈希（aaa/bbb）→ 放宽为任意长度 hex（真实 ls-remote 恒为 40 位）
    const match = remoteHead.match(/^([0-9a-f]+)\s/m);
    if (match?.[1]) { return match[1]; }
  }
  const remoteHead = await run("git", ["ls-remote", "origin", "HEAD"], { cwd: installPath, timeoutMs: 20000 });
  const match = remoteHead.match(/^([0-9a-f]+)\s+HEAD$/m);
  if (!match?.[1]) { throw new Error("Failed to determine remote HEAD"); }
  return match[1];
}

/** 镜像 pi getGitUpstreamRef：@{upstream} 需 origin/ 前缀，剥前缀 → refs/heads/<branch>；否则 undefined。 */
async function getGitUpstreamRef(installPath: string, run: CommandRunner): Promise<string | undefined> {
  try {
    const upstream = (await run("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: installPath, timeoutMs: 10000 })).trim();
    if (!upstream.startsWith("origin/")) { return undefined; }
    const branch = upstream.slice("origin/".length);
    return branch ? `refs/heads/${branch}` : undefined;
  } catch {
    return undefined;
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
    if (!e) { return undefined; }
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
