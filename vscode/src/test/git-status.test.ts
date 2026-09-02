import * as assert from "assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseGitStatus, readGitStatus } from "../chat/git-status";

suite("parseGitStatus 防御解析", () => {
  test("干净分支：仅 ## main → 无改动、无 ahead/behind", () => {
    assert.deepStrictEqual(parseGitStatus("## main\n"), {
      branch: "main",
      ahead: 0,
      behind: 0,
      trackedChanges: false,
      untracked: false,
    });
  });

  test("已跟踪改动（M/A/D 等）→ trackedChanges=true，untracked=false", () => {
    const out = "## main\n M src/a.ts\nA  b.ts\n";
    assert.deepStrictEqual(parseGitStatus(out), {
      branch: "main",
      ahead: 0,
      behind: 0,
      trackedChanges: true,
      untracked: false,
    });
  });

  test("未跟踪（??）→ untracked=true，trackedChanges=false", () => {
    const out = "## main\n?? new.txt\n?? dir/\n";
    assert.deepStrictEqual(parseGitStatus(out), {
      branch: "main",
      ahead: 0,
      behind: 0,
      trackedChanges: false,
      untracked: true,
    });
  });

  test("混合：已跟踪 + 未跟踪 → 两者均 true", () => {
    const out = "## main\n M src/a.ts\n?? new.txt\n";
    const r = parseGitStatus(out);
    assert.strictEqual(r?.trackedChanges, true);
    assert.strictEqual(r?.untracked, true);
  });

  test("带 upstream 与 ahead/behind：剥离 ...origin 并解析计数", () => {
    const out = "## feat/x...origin/feat/x [ahead 1, behind 2]\n";
    assert.deepStrictEqual(parseGitStatus(out), {
      branch: "feat/x",
      ahead: 1,
      behind: 2,
      trackedChanges: false,
      untracked: false,
    });
  });

  test("单边 ahead（无 behind）→ behind=0", () => {
    const out = "## main...origin/main [ahead 3]\n";
    assert.deepStrictEqual(parseGitStatus(out), {
      branch: "main",
      ahead: 3,
      behind: 0,
      trackedChanges: false,
      untracked: false,
    });
  });

  test("单边 behind（无 ahead）→ ahead=0", () => {
    const out = "## main...origin/main [behind 2]\n";
    assert.deepStrictEqual(parseGitStatus(out), {
      branch: "main",
      ahead: 0,
      behind: 2,
      trackedChanges: false,
      untracked: false,
    });
  });

  test("[gone]：upstream 被删 → ahead/behind 均 0，不崩溃", () => {
    const out = "## main...origin/main [gone]\n";
    assert.deepStrictEqual(parseGitStatus(out), {
      branch: "main",
      ahead: 0,
      behind: 0,
      trackedChanges: false,
      untracked: false,
    });
  });

  test("detached HEAD：## HEAD (no branch) → branch=HEAD", () => {
    assert.deepStrictEqual(parseGitStatus("## HEAD (no branch)\n"), {
      branch: "HEAD",
      ahead: 0,
      behind: 0,
      trackedChanges: false,
      untracked: false,
    });
  });

  test("\\r\\n 行尾容忍：干净分支解析不受影响", () => {
    assert.deepStrictEqual(parseGitStatus("## main\r\n"), {
      branch: "main",
      ahead: 0,
      behind: 0,
      trackedChanges: false,
      untracked: false,
    });
  });

  test("空输出 / 无 ## 头行 → null", () => {
    assert.strictEqual(parseGitStatus(""), null);
    assert.strictEqual(parseGitStatus(" M file.txt\n"), null);
  });
});

suite("readGitStatus", () => {
  test("非 git 仓库目录 → 回 null（不抛错）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinel-git-"));
    try {
      assert.strictEqual(await readGitStatus(dir), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
