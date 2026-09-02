import { execFile } from "node:child_process";

/** 工作区 git 状态（会话信息条环境段展示；null = git 不可用/非仓库/超时）。 */
export interface GitStatus {
  /** 当前分支名；detached HEAD 时为 "HEAD"。 */
  branch: string;
  /** 领先 upstream 的提交数（无 upstream / `[gone]` 时为 0）。 */
  ahead: number;
  /** 落后 upstream 的提交数（无 upstream / `[gone]` 时为 0）。 */
  behind: number;
  /** 已跟踪文件有改动（staged/unstaged，排除 ?? 未跟踪行）。 */
  trackedChanges: boolean;
  /** 存在未跟踪文件（?? 行）。 */
  untracked: boolean;
}

/**
 * 解析 `git status --porcelain --branch` 输出。
 * 首行形如 `## main` / `## main...origin/main [ahead 1, behind 2]` /
 * `## HEAD (no branch)`；bracket 形态覆盖 `[ahead N, behind M]` / `[ahead N]`（单边）/
 * `[behind N]`（单边）/ `[gone]`（upstream 被删 → ahead/behind 均 0）。
 * 体行：`?? ` 前缀 = 未跟踪；其余非 `## ` 行 = 已跟踪改动。
 * 无 `## ` 头行（空输出/异常格式）→ null。
 */
export function parseGitStatus(output: string): GitStatus | null {
  // 容忍 \r\n（Windows git 输出）：逐行 trimEnd 后过滤空行
  const lines = output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const head = lines.find((l) => l.startsWith("## "));
  if (!head) {
    return null;
  }
  const headText = head.slice(3).trim();
  // 分离「分支」与「[bracket]」：bracket 可能为 ahead/behind 组合、单边或 gone
  const m = headText.match(/^(.*?)\s*\[(.*)\]$/);
  let branch = m ? m[1].trim() : headText;
  const bracket = m ? m[2] : "";
  // 剥离 upstream：`main...origin/main` → `main`
  branch = branch.replace(/\.\.\..*$/, "").trim();
  if (branch.startsWith("HEAD (no branch)")) {
    branch = "HEAD"; // detached HEAD
  }
  if (!branch) {
    return null;
  }
  let ahead = 0;
  let behind = 0;
  if (bracket && bracket !== "gone") {
    const am = bracket.match(/\bahead (\d+)/);
    const bm = bracket.match(/\bbehind (\d+)/);
    ahead = am ? Number(am[1]) : 0;
    behind = bm ? Number(bm[1]) : 0;
  }
  let trackedChanges = false;
  let untracked = false;
  for (const l of lines) {
    if (l.startsWith("## ")) {
      continue;
    }
    if (l.startsWith("??")) {
      untracked = true;
    } else {
      trackedChanges = true;
    }
  }
  return { branch, ahead, behind, trackedChanges, untracked };
}

/**
 * 读取工作区 git 状态（spawn `git status --porcelain --branch`）。
 * git 不可用/非仓库/超时/非零退出 → resolve(null)（调用方静默隐藏该项，不报错）。
 */
export function readGitStatus(cwd: string, timeoutMs = 5000): Promise<GitStatus | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "status", "--porcelain", "--branch"],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(parseGitStatus(stdout));
      },
    );
  });
}
