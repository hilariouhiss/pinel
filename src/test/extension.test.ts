import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PinelTestApi } from "../extension";

/** 读取假 pi 日志中的所有记录。 */
function readFakePiLog(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const lines = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const records: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 忽略损坏行
    }
  }
  return records;
}

function logRecordsWith(records: Array<Record<string, unknown>>, dir: string, type: string): unknown[] {
  return records.filter((r) => {
    const rec = r.record as { dir?: string; record?: { type?: string } } | undefined;
    return rec?.dir === dir && rec?.record?.type === type;
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
}

suite("Pinel 集成测试（假 pi）", () => {
  let api: PinelTestApi;
  const logPath = path.join(os.tmpdir(), "pinel-fake-pi.log");

  suiteSetup(async function () {
    this.timeout(120000);

    // 假 pi 路径：测试进程的工作区即扩展仓库根
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, "测试工作区必须存在");
    const fakePi = path.join(root, "src", "test", "fixtures", "fake-pi.js");
    assert.ok(fs.existsSync(fakePi), `假 pi 不存在: ${fakePi}`);

    // 假 pi 日志路径通过环境变量传递（扩展 spawn 时继承 process.env）
    process.env.PINEL_FAKE_PI_LOG = logPath;
    try {
      fs.unlinkSync(logPath);
    } catch {
      // 不存在即可
    }

    // 配置扩展使用假 pi（shell 命令形式，覆盖 Windows/POSIX）
    const config = vscode.workspace.getConfiguration("pinel");
    await config.update("piPath", `node "${fakePi}"`, vscode.ConfigurationTarget.Global);

    // 显式激活扩展并获取测试钩子
    const ext = vscode.extensions.getExtension<PinelTestApi>("hiss.pinel");
    assert.ok(ext, "扩展 hiss.pinel 必须存在");
    api = await ext.activate();

    // 打开面板（触发 resolveWebviewView）
    await api.openPanel();

    // 等待 pi 进程启动完成（running + model 已同步）
    await waitFor(
      () => api.getStatus().processState === "running" && api.getStatus().model !== null,
      20000,
      "pi 进程启动",
    );
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration("pinel");
    await config.update("piPath", "", vscode.ConfigurationTarget.Global);
  });

  test("状态同步：模型与思考等级来自 get_state", () => {
    const status = api.getStatus();
    assert.strictEqual(status.model?.name, "Fake Model");
    assert.strictEqual(status.thinkingLevel, "high");
  });

  test("端到端流式响应：多块装配、工具卡片、消息落盘", async () => {
    const marker = `hello-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await api.waitForSettled(30000, baseline);

    // 助手文本消息（权威 message_end 内容）
    const messages = api.getMessages();
    const assistant = messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "必须存在助手消息");
    const text = (assistant.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    assert.strictEqual(text, "你好，世界");

    // 工具卡片完成且输出正确
    const tool = api.getTools().get("call_1");
    assert.ok(tool, "必须存在工具卡片 call_1");
    assert.strictEqual(tool.status, "done");
    assert.strictEqual(tool.output, "README content");

    // toolResult 消息落盘
    assert.ok(messages.some((m) => m.role === "toolResult"), "必须存在 toolResult 消息");
  });

  test("流式中 abort 中断", async () => {
    const marker = `ABORTME-${Date.now()}`;
    const baseline = api.getSettledCount();
    const sendPromise = api.sendPrompt(marker);

    // 等待流式开始（部分消息出现）
    await waitFor(() => api.getStatus().isStreaming, 10000, "流式开始");
    await new Promise((resolve) => setTimeout(resolve, 500));

    await api.abort();
    await sendPromise;
    await api.waitForSettled(30000, baseline);

    // 假 pi 收到 abort 命令
    const records = readFakePiLog(logPath);
    const aborts = logRecordsWith(records, "in", "abort");
    assert.ok(aborts.length >= 1, `假 pi 日志中必须出现 abort 命令（实际 ${aborts.length} 条）`);
  });

  test("extension_ui_request 对话框被自动取消（防阻塞）", async () => {
    const marker = `UIREQUEST-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await api.waitForSettled(30000, baseline);

    // 假 pi 记录收到的 extension_ui_response（应为 cancelled: true）
    const records = readFakePiLog(logPath);
    const responses = records.filter((r) => (r.record as { dir?: string })?.dir === "ui-response");
    assert.ok(responses.length >= 1, "假 pi 必须收到 extension_ui_response");
    const last = (responses[responses.length - 1].record as { response?: { cancelled?: boolean } }).response;
    assert.strictEqual(last?.cancelled, true, "回复必须为 cancelled: true");

    // 流式仍然正常完成（说明对话框没有阻塞 agent）
    const assistant = api.getMessages().find((m) => m.role === "assistant");
    assert.ok(assistant, "UI 请求后流式必须正常完成");
  });

  test("连续消息：第二条流式块不串入第一条的旧块（contentIndex 装配跨消息重置）", async () => {
    const marker = `TWOMSG-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);

    // 等待假 pi 标记"第二条消息的 delta 已发送"（此后 2.5s 内流式状态稳定）
    await waitFor(
      () =>
        readFakePiLog(logPath).some(
          (r) =>
            (r.record as { dir?: string; message?: string })?.dir === "marker" &&
            (r.record as { message?: string }).message === "second-delta-sent",
        ),
      15000,
      "second-delta-sent 标记",
    );

    // 等待控制器应用 delta 后采样：若跨消息装配未重置，这里会残留第一条的
    // thinking 旧块（blocks.length === 3），回归检测即失败
    await waitFor(
      () => {
        const blocks = api.getPartialBlocks();
        return blocks.length > 0 && blocks[0].kind === "text" && blocks[0].text.includes("第二条");
      },
      8000,
      "第二条消息的流式块",
    );
    const blocks = api.getPartialBlocks();
    assert.strictEqual(blocks.length, 1, `不应残留第一条的旧块：${JSON.stringify(blocks)}`);

    await api.waitForSettled(30000, baseline);
    const assistantCount = api.getMessages().filter((m) => m.role === "assistant").length;
    assert.ok(assistantCount >= 2, `应落盘两条助手消息（实际 ${assistantCount}）`);
  });

  test("重启竞态回归：旧进程 exit 事件不污染新进程状态", async () => {
    // CRASHME：假 pi 正常响应后延迟 1.5s 崩溃。测试在流未结束时立即 restart：
    // stop() 杀掉旧进程后，其 exit 事件（macrotask）迟到于新进程的 running（微任务链）；
    // 未修复时 handleExit 会把状态打回 error，修复后身份过滤屏蔽旧事件。
    const marker = `CRASHME-${Date.now()}`;
    await api.sendPrompt(marker);

    await api.restart();

    await waitFor(
      () => api.getStatus().processState === "running" && api.getStatus().model !== null,
      20000,
      "重启后恢复 running",
    );

    // 旧进程的 exit 事件已在此前到达（stop 等待窗口内）；额外等待确认无迟到污染
    await new Promise((resolve) => setTimeout(resolve, 600));
    const status = api.getStatus();
    assert.strictEqual(status.processState, "running", "旧进程 exit 事件不得污染新状态");
    assert.strictEqual(status.model?.name, "Fake Model", "新进程状态必须同步成功");
  });

  test("pi 崩溃后重启恢复", async () => {
    // CRASHME 流程走完（1.5s 后 exit(1)）→ error 状态 → 重启 → running
    const marker = `CRASHME-${Date.now()}`;
    await api.sendPrompt(marker);
    await waitFor(() => api.getStatus().processState === "error", 15000, "pi 崩溃后进入 error");

    await api.restart();

    await waitFor(
      () => api.getStatus().processState === "running" && api.getStatus().model !== null,
      20000,
      "重启后恢复 running",
    );
    // fake-pi 消息存进程内存，重启后 get_messages 为空（新进程状态）
    assert.deepStrictEqual(api.getMessages(), [], "快照消息应反映新进程（空历史）");
  });

  // 注：「未打开文件夹」友好状态在独立空窗口实例套件覆盖
  //（src/test-no-workspace/no-workspace.test.ts）——主套件内移除全部工作区文件夹
  // 不可逆（VS Code 空窗口不支持 updateWorkspaceFolders 恢复）。
});
