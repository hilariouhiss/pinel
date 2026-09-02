/**
 * Pinel 插件真实 pi 冒烟（opt-in，不进 CI；用法：npm run smoke:plugin）。
 *
 * 流程（不触碰用户全局配置——临时项目 + pi install -l）：
 * 1. 临时项目目录内 `pi install -l <repo>/pi`（项目级 settings）
 * 2. spawn `pi --mode rpc`（env PINEL_PLUGIN=1，cwd=临时项目）→ 项目包自动加载
 * 3. session_start 后断言 pinel.prompt 启动帧与 pinel.mcp 基线帧
 *    （插件加载 + 帧通道 + 两个采集器存活；pinel.state/tree 推送链已整体删除）
 * 4. 清理临时目录与子进程
 *
 * 覆盖：插件包 manifest 正确性（零资源加载会在此暴露）、守卫 env、帧通道。失败时非零退出并打印诊断。
 */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 插件包在仓库根的 sibling 目录 pi/（vscode/ 与 pi/ 平级）
const PLUGIN_DIR = path.join(ROOT, "..", "pi");

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

/** Windows：where.exe 优先 .cmd；spawn 用 shell:true（.cmd shim 需 cmd.exe 包装）。 */
function resolvePi() {
  try {
    const lines = execSync("where pi", { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    const picked = lines.find((l) => /\.cmd$/i.test(l.trim())) ?? lines[0];
    return { command: picked?.trim() || "pi", shell: true };
  } catch {
    return { command: "pi", shell: false };
  }
}

function run(command, args, cwd, { shell }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
  });
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "pinel-smoke-"));
const pi = resolvePi();
let rpcChild = null;

try {
  // 1. 本地路径安装（项目级 -l，写临时项目 .pi/settings.json）
  await run(pi.command, ["install", "-l", PLUGIN_DIR], tmp, pi);
  const settingsDir = path.join(tmp, ".pi");
  if (!readdirSync(settingsDir).includes("settings.json")) {
    fail("pi install -l 未写入 .pi/settings.json");
  }

  // 2. spawn pi --mode rpc（项目包自动加载）
  rpcChild = spawn(pi.command, ["--mode", "rpc"], {
    cwd: tmp,
    shell: pi.shell,
    env: { ...process.env, PINEL_PLUGIN: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  rpcChild.stdout.on("data", (d) => {
    out += d;
  });
  const frames = () =>
    out
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  await new Promise((r) => setTimeout(r, 4000)); // 等 session_start 推送

  // 3. session_start 后断言采集器帧（插件被自动加载且帧通道正常）
  const seen = frames();
  const promptFrames = seen.filter(
    (f) => f.type === "extension_ui_request" && f.method === "setStatus" && f.statusKey === "pinel.prompt",
  );
  const mcpFrames = seen.filter(
    (f) => f.type === "extension_ui_request" && f.method === "setStatus" && f.statusKey === "pinel.mcp",
  );
  if (promptFrames.length === 0) fail("未收到 pinel.prompt 启动帧（插件未加载或通道失效）");
  if (mcpFrames.length === 0) fail("未收到 pinel.mcp 基线帧（MCP 采集器失效）");

  console.log("SMOKE OK: 插件加载 / pinel.prompt 启动帧 / pinel.mcp 基线帧全部通过");
} catch (err) {
  fail(err.message);
} finally {
  // 优雅退出：关 stdin → 超时后 taskkill /T /F 进程树（仓库 Windows 规范）
  try {
    rpcChild?.stdin.end();
  } catch {
    // 已关闭
  }
  await new Promise((r) => setTimeout(r, 2000));
  if (rpcChild && rpcChild.exitCode === null) {
    try {
      execSync(`taskkill /T /F /PID ${rpcChild.pid}`, { stdio: "ignore" });
    } catch {
      // taskkill 失败（非 Windows / 进程已退出）：忽略
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
