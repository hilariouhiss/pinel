import * as assert from "assert";
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
    const ext = vscode.extensions.getExtension<PinelTestApi>("hiss.pinel");
    assert.ok(ext, "扩展 hiss.pinel 必须存在");
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
    const ext = vscode.extensions.getExtension<PinelTestApi>("hiss.pinel");
    assert.ok(ext, "扩展 hiss.pinel 必须存在");
    const api = await ext.activate();

    await vscode.commands.executeCommand("pinel.sessionHistory.focus");
    // 给 provider 扫描留出时间（空窗口 cwd 为 undefined → 空列表）
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepStrictEqual(api.getSessionList(), [], "空窗口下历史列表必须为空");
    assert.strictEqual(api.getStatus().processState, "no-workspace", "历史视图打开不得改变 no-workspace 状态");
  });

  test("无工作区新建会话：前置 return 必须广播 switching:false（复位回归）", async () => {
    const ext = vscode.extensions.getExtension<PinelTestApi>("hiss.pinel");
    assert.ok(ext, "扩展 hiss.pinel 必须存在");
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
});
