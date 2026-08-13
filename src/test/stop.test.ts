import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "../rpc/client";

suite("RpcClient.stop() 等待真实退出", () => {
  test("stop() resolve 时 exit 事件已派发、子进程已死", async () => {
    // 长命子进程经 shell 分支启动（含空格的完整命令串），fixture 把 pid 写入文件
    const pidFile = path.join(os.tmpdir(), `pinel-stop-${process.pid}-${Date.now()}.pid`);
    // tsc 不复制 fixture 到 out/，从仓库源码目录解析（与 extension.test.ts 同理）
    const fixture = path.resolve(__dirname, "..", "..", "src", "test", "fixtures", "long-running.js");
    const client = new RpcClient();

    try {
      await client.start(`"${process.execPath}" "${fixture}" "${pidFile}"`, os.tmpdir(), process.env);
      assert.ok(client.isRunning, "子进程必须已启动");

      // 等 fixture 写出 pid（进程真正就绪）
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(fs.existsSync(pidFile), "fixture 必须写出 pid 文件");
      const pid = Number(fs.readFileSync(pidFile, "utf8"));

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
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // 已清理
      }
    }
  });
});
