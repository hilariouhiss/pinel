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
    assert.ok(status.error?.includes("未打开文件夹"), `提示文本必须引导用户（实际：${status.error}）`);
  });
});
