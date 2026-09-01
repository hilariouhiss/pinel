import * as assert from "assert";
import { UpdateCheckCache, checkGitUpdate, checkNpmUpdate, type CommandRunner } from "../chat/extension-updates";

/** 脚本化假 runner：按 (cmd+args 前缀) 依次出队 {stdout} 或 Error。 */
function fakeRunner(script: Array<{ match: string; stdout?: string; error?: Error }>): CommandRunner {
  return (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const step = script.find((s) => key.startsWith(s.match));
    assert.ok(step, `unexpected command: ${key}`);
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
  test("有 upstream：按 fully-qualified ref ls-remote，相同 → current", async () => {
    const run = fakeRunner([
      revParse(LOCAL),
      { match: "git rev-parse --abbrev-ref", stdout: "origin/main\n" },
      { match: "git ls-remote origin refs/heads/main", stdout: `${LOCAL}\trefs/heads/main\n` },
    ]);
    assert.deepStrictEqual(await checkGitUpdate("/pkg", run), { status: "current" });
  });
  test("upstream ls-remote 无 SHA → 回退 origin HEAD", async () => {
    const run = fakeRunner([
      revParse(LOCAL),
      { match: "git rev-parse --abbrev-ref", stdout: "origin/main\n" },
      { match: "git ls-remote origin refs/heads/main", stdout: "" },
      { match: "git ls-remote origin HEAD", stdout: `${LOCAL}\tHEAD\n` },
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
