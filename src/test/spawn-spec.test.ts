import * as assert from "assert";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSpawnSpec } from "../rpc/client";

/**
 * resolveSpawnSpec 单元测试。
 *
 * 背景（实测踩坑记录，防止回归）：
 * 1. Windows PATH 中同时存在无扩展名 `pi`（sh 脚本）与 `pi.cmd` 时，
 *    裸名 spawn 会命中前者而 ENOENT —— 需要 where.exe 解析并优先 .cmd；
 * 2. cmd.exe 包装必须用 windowsVerbatimArguments（Node 默认用反斜杠转义
 *    参数中的引号，cmd.exe 不解析该转义，整个命令串会被当作命令名）；
 * 3. cmd 路径要用 ComSpec（反斜杠形式），正斜杠路径会破坏 cmd 参数解析。
 */
suite("resolveSpawnSpec 单元测试", () => {
  const isWin = process.platform === "win32";

  test("不存在的路径式字符串 → shell 命令模式（测试钩子场景）", () => {
    const spec = resolveSpawnSpec('node "/path/to/fake-pi.js"', ["--mode", "rpc"], process.cwd());
    assert.strictEqual(spec.cmd, 'node "/path/to/fake-pi.js"');
    assert.deepStrictEqual(spec.args, []);
    assert.strictEqual(spec.options.shell, true);
    assert.strictEqual(spec.options.windowsHide, true);
  });

  test("存在的普通文件路径 → 直接 spawn", () => {
    const fake = path.join(os.tmpdir(), `pinel-spec-${process.pid}.js`);
    try {
      require("node:fs").writeFileSync(fake, "// fake");
      const spec = resolveSpawnSpec(fake, ["--mode", "rpc"], process.cwd());
      assert.strictEqual(spec.cmd, fake);
      assert.deepStrictEqual(spec.args, ["--mode", "rpc"]);
      assert.notStrictEqual(spec.options.shell, true);
    } finally {
      require("node:fs").unlinkSync(fake);
    }
  });

  if (isWin) {
    test("Windows：存在的 .cmd 路径 → cmd.exe 包装 + verbatim 参数", () => {
      const fakeCmd = path.join(os.tmpdir(), `pinel-spec-${process.pid}.cmd`);
      try {
        require("node:fs").writeFileSync(fakeCmd, "@echo off");
        const spec = resolveSpawnSpec(fakeCmd, ["--mode", "rpc"], process.cwd());
        assert.strictEqual(spec.cmd, process.env.ComSpec ?? "cmd.exe");
        assert.deepStrictEqual(spec.args, ["/d", "/s", "/c", `""${fakeCmd}" --mode rpc"`]);
        assert.strictEqual(spec.options.windowsVerbatimArguments, true);
        assert.strictEqual(spec.options.shell, undefined);
      } finally {
        require("node:fs").unlinkSync(fakeCmd);
      }
    });

    test("Windows：裸命令名 → where.exe 优先 .cmd（本机有 pi 时验证解析路径）", () => {
      const spec = resolveSpawnSpec("pi", ["--mode", "rpc"], process.cwd());
      // 无论 pi 是否安装，都不应走 shell 模式；未安装时回退裸名直接 spawn（ENOENT 由上层呈现）
      assert.notStrictEqual(spec.options.shell, true);
      if (spec.options.windowsVerbatimArguments === true) {
        // 解析到 .cmd shim → cmd.exe 包装
        assert.strictEqual(spec.cmd, process.env.ComSpec ?? "cmd.exe");
        assert.deepStrictEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
        assert.ok(/\.cmd" --mode rpc"$/.test(spec.args[3]), `命令串应为 .cmd 路径 + 参数：${spec.args[3]}`);
      } else {
        assert.deepStrictEqual(spec.args, ["--mode", "rpc"]);
      }
    });
  } else {
    test("POSIX：裸命令名 → 直接 spawn", () => {
      const spec = resolveSpawnSpec("pi", ["--mode", "rpc"], process.cwd());
      assert.strictEqual(spec.cmd, "pi");
      assert.deepStrictEqual(spec.args, ["--mode", "rpc"]);
      assert.notStrictEqual(spec.options.shell, true);
    });
  }
});
