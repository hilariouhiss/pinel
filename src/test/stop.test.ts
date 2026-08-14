import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "../rpc/client";

/** 解析 long-running.js 夹具路径（tsc 不复制 fixture 到 out/，从仓库源码目录解析）。 */
function fixturePath(): string {
  return path.resolve(__dirname, "..", "..", "src", "test", "fixtures", "long-running.js");
}

/** 启动夹具并等待 pid 文件写出（进程真正就绪）。 */
async function startFixture(env: NodeJS.ProcessEnv): Promise<{ client: RpcClient; pid: number }> {
  const pidFile = path.join(os.tmpdir(), `pinel-stop-${process.pid}-${Date.now()}.pid`);
  const fixture = fixturePath();
  const client = new RpcClient();
  await client.start(`"${process.execPath}" "${fixture}" "${pidFile}"`, os.tmpdir(), env);
  assert.ok(client.isRunning, "子进程必须已启动");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(fs.existsSync(pidFile), "fixture 必须写出 pid 文件");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  return { client, pid };
}

suite("RpcClient.stop() 等待真实退出", () => {
  test("stop() resolve 时 exit 事件已派发、子进程已死", async () => {
    const { client, pid } = await startFixture(process.env);

    try {
      let exitSeen = false;
      client.on("exit", () => {
        exitSeen = true;
      });

      await client.stop();

      // 核心断言：stop() resolve 时子进程已真实退出且 exit 事件已派发
      //（restart 竞态的根因就是 stop 返回后旧 exit 事件才迟到）
      assert.strictEqual(exitSeen, true, "stop() resolve 前 exit 事件必须已派发");
      try {
        process.kill(pid, 0);
        // 仍存活：Windows 上 taskkill /T /F 应已杀整树，存活即失败；
        // POSIX shell 模式下负 pid 组 kill 不生效，兜底清理孙进程
        if (process.platform === "win32") {
          assert.fail(`stop() 后子进程（pid=${pid}）仍存活`);
        } else {
          process.kill(pid, "SIGKILL");
        }
      } catch (err) {
        // ESRCH：进程已死，符合预期
        assert.ok(true, `子进程已死（${(err as Error).message}）`);
      }
    } finally {
      try {
        await client.stop();
      } catch {
        // 忽略：清理路径
      }
    }
  });

  test("优雅退出路径：stdin EOF 后子进程自行退出（exit code 0）", async () => {
    const { client, pid } = await startFixture(process.env);

    try {
      let exitSeen = false;
      let exitCode: number | null | undefined;
      client.on("exit", (code) => {
        exitSeen = true;
        exitCode = code;
      });

      await client.stop();

      // 夹具在 stdin EOF 时 process.exit(0)：应走优雅期而非硬杀
      assert.strictEqual(exitSeen, true, "stop() resolve 前 exit 事件必须已派发");
      assert.strictEqual(exitCode, 0, `EOF 优雅退出的 exit code 应为 0（实际 ${exitCode}）`);
      try {
        process.kill(pid, 0);
        assert.fail(`优雅退出后子进程（pid=${pid}）不应存活`);
      } catch {
        // ESRCH：已死，符合预期
      }
    } finally {
      try {
        await client.stop();
      } catch {
        // 忽略：清理路径
      }
    }
  });

  test("兜底硬杀路径：EOF 后拒不退出 → 强制终止并等待真实退出", async () => {
    // PINEL_LONG_NO_EOF=1：夹具忽略 stdin EOF 保持常驻，迫使 stop() 走硬杀兜底
    const env = { ...process.env, PINEL_LONG_NO_EOF: "1" };
    const { client, pid } = await startFixture(env);

    try {
      let exitSeen = false;
      let exitCode: number | null | undefined;
      let exitSignal: string | null | undefined;
      client.on("exit", (code, signal) => {
        exitSeen = true;
        exitCode = code;
        exitSignal = signal;
      });

      await client.stop();

      assert.strictEqual(exitSeen, true, "stop() resolve 前 exit 事件必须已派发");
      // 硬杀路径：非正常退出（Windows taskkill → code 1；POSIX 信号 → signal 非空）
      assert.ok(
        exitCode !== 0 || exitSignal !== null,
        `硬杀兜底应为非正常退出（code=${exitCode}, signal=${exitSignal}）`,
      );
      try {
        process.kill(pid, 0);
        if (process.platform === "win32") {
          assert.fail(`硬杀后子进程（pid=${pid}）仍存活`);
        }
        process.kill(pid, "SIGKILL");
      } catch {
        // ESRCH：已死，符合预期
      }
    } finally {
      try {
        await client.stop();
      } catch {
        // 忽略：清理路径
      }
    }
  });
});
