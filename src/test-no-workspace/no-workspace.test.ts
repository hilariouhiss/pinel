import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PinelTestApi } from "../extension";

/**
 * 空窗口实例套件（.vscode-test.mjs 第二配置，不传 workspaceFolder）。
 *
 * 验证「未打开文件夹」场景：面板不得显示「pi 进程异常」，而应进入
 * no-workspace 友好状态并给出引导文本。
 */
suite("未打开文件夹：友好状态（空窗口实例）", () => {
  test("面板显示 no-workspace 友好提示而非进程异常", async () => {
    const ext = vscode.extensions.getExtension<PinelTestApi>("hilariouhiss.pinel");
    assert.ok(ext, "扩展 hilariouhiss.pinel 必须存在");
    const api = await ext.activate();

    await api.openPanel();

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && api.getStatus().processState !== "no-workspace") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const status = api.getStatus();
    assert.strictEqual(status.processState, "no-workspace", "空窗口必须进入 no-workspace 状态");
    assert.notStrictEqual(status.processState, "error", "未打开文件夹不得伪装成进程异常");
    assert.ok(status.error?.includes("No folder open"), `提示文本必须引导用户（实际：${status.error}）`);
  });

  test("会话历史视图空态：无工作区时列表为空且不崩溃", async () => {
    const ext = vscode.extensions.getExtension<PinelTestApi>("hilariouhiss.pinel");
    assert.ok(ext, "扩展 hilariouhiss.pinel 必须存在");
    const api = await ext.activate();

    await vscode.commands.executeCommand("pinel.sessionHistory.focus");
    // 给 provider 扫描留出时间（空窗口 cwd 为 undefined → 空列表）
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepStrictEqual(api.getSessionList(), [], "空窗口下历史列表必须为空");
    assert.strictEqual(api.getStatus().processState, "no-workspace", "历史视图打开不得改变 no-workspace 状态");
  });

  test("无工作区新建会话：前置 return 必须广播 switching:false（复位回归）", async () => {
    const ext = vscode.extensions.getExtension<PinelTestApi>("hilariouhiss.pinel");
    assert.ok(ext, "扩展 hilariouhiss.pinel 必须存在");
    const api = await ext.activate();

    // 空窗口：newSession 走 !workspaceRoot 前置 return 路径。修复前该路径
    // 不发 sessionSwitching:false——HistoryApp 本地乐观置位后永久卡「切换中」
    //（真实缺陷回归：修复前此处 lastSessionSwitching 为 undefined → 断言失败）
    await api.newSession();
    assert.strictEqual(
      api.getTestEventLog().lastSessionSwitching,
      false,
      "无工作区新建会话必须广播 switching:false（HistoryApp 复位依赖）",
    );
    assert.ok(
      api.getTestEventLog().notices.some((n) => n.text.includes("Open a folder first")),
      "必须弹出引导 notice",
    );
  });

  test("扩展列表：空窗口 all 仅全局条目，project 视图全部为继承行（不崩溃）", async () => {
    const ext = vscode.extensions.getExtension<PinelTestApi>("hilariouhiss.pinel");
    assert.ok(ext, "扩展 hilariouhiss.pinel 必须存在");
    const api = await ext.activate();

    // 隔离 agentDir：避免依赖/读取用户真实 ~/.pi/agent 配置
    const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "pinel-no-ws-agent-"));
    const prevEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpAgent;
    fs.mkdirSync(path.join(tmpAgent, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(tmpAgent, "extensions", "foo.ts"), "export default () => {}");
    fs.writeFileSync(
      path.join(tmpAgent, "settings.json"),
      JSON.stringify({ packages: ["npm:a"] }),
    );
    try {
      const all = await api.getExtensionList();
      assert.strictEqual(all.length, 2, `all 应含本地扩展+包，实际 ${JSON.stringify(all.map((i) => i.name))}`);
      for (const i of all) {
        assert.strictEqual(i.scope, "global", "无 workspace 时 all 视图不得有项目条目");
      }
      const proj = await api.getExtensionList("project");
      assert.strictEqual(proj.length, 1, "project 视图应含继承全局包（无项目条目）");
      assert.strictEqual(proj[0].name, "a");
      assert.strictEqual(proj[0].scope, "project", "继承行 scope 重写为 project");
      assert.strictEqual(proj[0].inherited, true);
      const glob = await api.getExtensionList("global");
      assert.strictEqual(glob.length, 2);
      for (const i of glob) {
        assert.strictEqual(i.scope, "global");
      }
    } finally {
      if (prevEnv === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = prevEnv;
      }
      fs.rmSync(tmpAgent, { recursive: true, force: true });
    }
  });
});
