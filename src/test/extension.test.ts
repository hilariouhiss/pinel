import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PinelTestApi } from "../extension";
import { confirmExtensionReload, confirmExtensionUninstall, confirmSessionDelete } from "../chat/controller";

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

/** 截取 marker 对应 prompt 入站之后的日志（fake-pi 日志跨测试累积，按 prompt 边界切片）。 */
function recordsAfterPrompt(records: Array<Record<string, unknown>>, marker: string): Array<Record<string, unknown>> {
  let startIndex = -1;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i].record as { dir?: string; record?: { message?: string } } | undefined;
    if (rec?.dir === "in" && typeof rec.record?.message === "string" && rec.record.message.includes(marker)) {
      startIndex = i;
    }
  }
  return startIndex >= 0 ? records.slice(startIndex) : records;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
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
    const ext = vscode.extensions.getExtension<PinelTestApi>("hilariouhiss.pinel");
    assert.ok(ext, "扩展 hilariouhiss.pinel 必须存在");
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

  test("get_commands 送达：启动后命令列表就绪（三类来源）", async () => {
    // 命令列表为 fire-and-forget 拉取，轮询等待送达
    await waitFor(() => api.getCommands().length >= 4, 10000, "命令列表送达");
    const names = api.getCommands().map((c) => c.name);
    assert.ok(names.includes("fix"), "必须包含提示模板命令");
    assert.ok(names.includes("skill:ctx-search"), "必须包含 skill: 前缀命令");
    assert.ok(names.includes("session-name"), "必须包含扩展命令");
    const fix = api.getCommands().find((c) => c.name === "fix");
    assert.strictEqual(fix?.source, "prompt");
    assert.strictEqual(fix?.description, "修复测试失败");
  });

  test("settle 后刷新命令列表（CMDADD 场景：运行中注册新命令可观察）", async () => {
    const marker = `CMDADD-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await api.waitForSettled(30000, baseline);

    // settle 后的 fetchCommands 是 fire-and-forget：轮询等待新命令出现
    await waitFor(
      () => api.getCommands().some((c) => c.name === "cmd-added"),
      10000,
      "settle 后新命令出现",
    );
  });

  test("重启后命令列表恢复（新进程重新拉取，不残留旧进程状态）", async () => {
    await api.restart();
    await waitFor(
      () => api.getStatus().processState === "running" && api.getStatus().model !== null,
      20000,
      "重启后恢复",
    );
    // 重启类场景不用 waitForSettled（无新 prompt 时 settled 不前进），轮询等待重拉完成
    await waitFor(() => api.getCommands().length >= 4, 10000, "重启后命令列表重新送达");
    // fake-pi 的 cmdAdded 是进程内存态：新进程不得残留旧进程追加的命令
    assert.ok(
      !api.getCommands().some((c) => c.name === "cmd-added"),
      "新进程命令列表不得残留旧进程的追加命令",
    );
  });

  test("/reload 命令：本地拦截并重载 pi 进程（不作为 prompt 送达）", async function () {
    this.timeout(60000);
    // 此测试位于会话切换套件之前：fake-pi 会话状态为默认文件，重载前后 sessionFile 一致
    const beforeFile = api.getCurrentSessionFile();
    const startupsBefore = readFakePiLog(logPath).filter((r) => {
      const rec = r.record as { dir?: string; event?: string } | undefined;
      return rec?.dir === "meta" && rec?.event === "startup";
    }).length;

    await api.sendPrompt("/reload");
    // 重启类场景不用 waitForSettled（无新 prompt 时 settled 不前进），轮询等待重载完成
    await waitFor(
      () => api.getStatus().processState === "running" && api.getStatus().model !== null,
      30000,
      "/reload 后恢复",
    );
    // 真实重启证据：新 fake-pi 进程启动记录 +1
    const startupsAfter = readFakePiLog(logPath).filter((r) => {
      const rec = r.record as { dir?: string; event?: string } | undefined;
      return rec?.dir === "meta" && rec?.event === "startup";
    }).length;
    assert.ok(startupsAfter > startupsBefore, "/reload 必须重启 pi 进程");
    assert.strictEqual(api.getCurrentSessionFile(), beforeFile, "重载后会话保持");
    // /reload 不得作为 prompt 送达 pi（精确匹配断言免疫跨测试累积）
    const records = readFakePiLog(logPath);
    const prompts = records.filter((r) => {
      const rec = r.record as { dir?: string; record?: { type?: string; message?: string } } | undefined;
      return rec?.dir === "in" && rec?.record?.type === "prompt" && rec?.record?.message === "/reload";
    });
    assert.strictEqual(prompts.length, 0, "/reload 不得作为 prompt 送达 pi");
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

  test("用户消息只显示一次：pi 的 user message 事件不重复推送", async () => {
    // 假 pi 默认流会发用户消息的 message_start/message_end（镜像真实 pi）；
    // 宿主必须门控不广播——webview 已有乐观渲染的用户消息，否则重复显示。
    // 会话历史跨 prompt 累积，按 marker 过滤本次 prompt 的用户消息断言恰好一条。
    const marker = `dedup-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await api.waitForSettled(30000, baseline);

    const textOf = (content: unknown): string => {
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        return content
          .filter((b) => (b as { type?: string }).type === "text")
          .map((b) => String((b as { text?: unknown }).text ?? ""))
          .join("");
      }
      return "";
    };
    const users = api.getMessages().filter((m) => m.role === "user" && textOf(m.content).includes(marker));
    assert.strictEqual(users.length, 1, "本次 prompt 的消息列表必须恰好一条用户消息");
    const counts = api.getMessageEventCounts();
    assert.strictEqual(counts.user, 0, "pi 驱动的 user message 事件不得广播（乐观渲染已显示）");
    assert.ok(counts.assistant >= 1, "助手消息广播计数必须正常");
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

  test("extension_ui_request 对话框被广播并可由用户答复（confirm 链路）", async () => {
    const marker = `UIREQUEST-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);

    // 对话框请求应广播给 UI（pendingUi 可见），而非自动取消
    await waitFor(() => api.getPendingUi().length > 0, 10000, "对话框请求广播");
    const pending = api.getPendingUi();
    assert.strictEqual(pending.length, 1, "同一时刻应只有一个待决对话框");
    assert.strictEqual(pending[0].method, "confirm");

    // 用户答复（确认）→ 假 pi 收到非 cancelled 的响应
    api.uiRespond(pending[0].id, { confirmed: true });
    await waitFor(() => api.getPendingUi().length === 0, 5000, "答复后对话框移除");

    await api.waitForSettled(30000, baseline);

    // 假 pi 记录收到的 extension_ui_response（应为 confirmed: true 而非 cancelled）
    const records = readFakePiLog(logPath);
    const responses = records.filter((r) => (r.record as { dir?: string })?.dir === "ui-response");
    assert.ok(responses.length >= 1, "假 pi 必须收到 extension_ui_response");
    const last = (responses[responses.length - 1].record as { response?: { cancelled?: boolean; confirmed?: boolean } }).response;
    assert.strictEqual(last?.cancelled, undefined, "回复不得为 cancelled");
    assert.strictEqual(last?.confirmed, true, "回复必须为 confirmed: true");

    // 流式仍然正常完成（说明对话框回复没有阻塞 agent）
    const assistant = api.getMessages().find((m) => m.role === "assistant");
    assert.ok(assistant, "UI 请求后流式必须正常完成");
  });

  test("select 对话框：广播 + 选项答复回传 value", async () => {
    const marker = `ASKUI-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);

    await waitFor(() => api.getPendingUi().length > 0, 10000, "select 请求广播");
    const pending = api.getPendingUi()[0];
    assert.strictEqual(pending.method, "select");
    assert.deepStrictEqual(pending.options, ["1. A", "2. B"]);

    // 用户选第一个选项 → value 回传
    api.uiRespond(pending.id, { value: "1. A" });
    await api.waitForSettled(30000, baseline);

    const records = readFakePiLog(logPath);
    const responses = records.filter((r) => (r.record as { dir?: string })?.dir === "ui-response");
    assert.ok(responses.length >= 1, "假 pi 必须收到 select 答复");
    const last = (responses[responses.length - 1].record as { response?: { value?: string } }).response;
    assert.strictEqual(last?.value, "1. A", "回复必须携带所选选项");
  });

  test("todo 工具结果解析为待办列表（含 snapshot 携带）", async () => {
    const marker = `TODOME-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);

    // 最终快照：2 个任务，第 2 个 in_progress
    await waitFor(
      () => api.getTodos().length === 2 && api.getTodos()[1]?.status === "in_progress",
      15000,
      "待办列表解析",
    );
    const todos = api.getTodos();
    assert.strictEqual(todos[0].subject, "任务一");
    assert.strictEqual(todos[0].status, "pending");
    assert.strictEqual(todos[1].subject, "任务二");
    assert.strictEqual(todos[1].activeForm, "执行任务二");

    await api.waitForSettled(30000, baseline);
    // snapshot 后待办状态仍保留（webview 重载恢复路径）
    assert.deepStrictEqual(api.getTodos(), todos, "settled 后待办快照必须保留");
  });

  test("pinel 插件 setStatus/setWidget 帧：白名单过滤 + 防御解析 + 缓存", async () => {
    // PINELUI：假 pi 依次发 pinel.state(好) → pinel.tree → 非 pinel 干扰 → pinel.state(坏 JSON)
    const marker = `PINELUI-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await api.waitForSettled(30000, baseline);

    const state = api.getPinelStateCache();
    assert.ok(state, "pinel.state 必须被解析并缓存");
    assert.deepStrictEqual(state.messages, { user: 2, assistant: 3, toolResult: 1, total: 6 });
    assert.strictEqual(state.model, "deepseek/deepseek-v4-pro");
    assert.strictEqual(state.thinkingLevel, "max");

    const tree = api.getPinelTreeCache();
    assert.ok(tree, "pinel.tree 必须被解析并缓存");
    assert.strictEqual(tree.leafId, "e2");
    assert.strictEqual(tree.nodes.length, 2);
    assert.strictEqual(tree.nodes[0].entryId, "e1");

    // 干扰帧（非 pinel statusKey）与坏 JSON 帧均不得污染缓存（好值保留）
    assert.strictEqual(state.messages.total, 6, "坏 JSON 帧不得覆盖好缓存");

    // ponytail 状态帧：ANSI 装饰解析（坏帧 "loaded" 先到且被忽略，好帧后到覆盖）
    const ponytail = api.getPonytailStatusCache();
    assert.ok(ponytail, "ponytail 状态帧必须被解析并缓存");
    assert.deepStrictEqual(ponytail, { active: true, mode: "full" }, "ANSI 剥离 + 实心点 + 档位解析");

    // mcp 状态帧：好帧缓存（2/2），坏帧 "garbage" 丢弃不得覆盖好缓存
    const mcp = api.getMcpStatus();
    assert.ok(mcp, "mcp 状态帧必须被解析并缓存");
    assert.deepStrictEqual(mcp, { state: "ready", enabled: 2, connected: 2 }, "mcp 好帧解析 + 坏帧不污染");

    // 工作流帧：status 好帧 → widget 好帧（覆盖）→ 空 widget（结束清空，不覆盖）→ 坏 JSON（不污染）
    const workflow = api.getPinelWorkflowCache();
    assert.ok(workflow, "pinel.workflow 必须被解析并缓存");
    assert.strictEqual(workflow.runId, "run-2", "widget 好帧必须覆盖 status 帧");
    assert.strictEqual(workflow.workflow, "sp-fix");
    assert.strictEqual(workflow.status, "running");
    assert.strictEqual(workflow.stage, "fix");
    assert.strictEqual(workflow.stageNumber, 2);
    assert.strictEqual(
      workflow.runId,
      "run-2",
      "空 widget 清空帧与坏 JSON 帧不得覆盖好缓存",
    );

    // 重启（含旧进程 exit）清空 mcp 缓存：同 commands reset 路径（断言复用既有 restart 恢复模式）
    await api.restart();
    await waitFor(
      () => api.getStatus().processState === "running" && api.getStatus().model !== null,
      20000,
      "重启后恢复",
    );
    assert.strictEqual(api.getMcpStatus(), null, "重启/退出后 mcp 缓存必须清空");
  });

  test("ponytail 档位循环：点击链路发 /ponytail <next> 扩展命令 + 帧回推刷新", async () => {
    // 借 PINELUI 场景建立状态帧缓存（mode: full）
    const marker = `PINELUI-PONYCYCLE-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await api.waitForSettled(30000, baseline);
    assert.strictEqual(api.getPonytailStatusCache()?.mode, "full");

    // full → ultra（/ponytail ultra 扩展命令，假 pi 回推新帧）
    await api.cyclePonytail();
    await waitFor(
      () => api.getPonytailStatusCache()?.mode === "ultra",
      10000,
      "ponytail 档位必须切到 ultra",
    );
    // ultra → lite（循环回绕）
    await api.cyclePonytail();
    await waitFor(
      () => api.getPonytailStatusCache()?.mode === "lite",
      10000,
      "ponytail 档位必须循环到 lite",
    );
    // 假 pi 收到的命令序列：marker prompt + 两次扩展命令
    const records = recordsAfterPrompt(readFakePiLog(logPath), marker);
    const prompts = (
      logRecordsWith(records, "in", "prompt") as Array<{ record?: { record?: { message?: string } } }>
    ).map((rec) => rec.record?.record?.message);
    assert.deepStrictEqual(
      prompts,
      [marker, "/ponytail ultra", "/ponytail lite"],
      "点击循环必须发出对应扩展命令",
    );
  });

  test("compact 原生命令：响应后 notice + 假 pi 收到命令", async () => {
    await api.compact();

    // 成功 notice（Compaction completed）
    await waitFor(
      () => api.getTestEventLog().notices.some((n) => n.text === "Compaction completed"),
      10000,
      "compact 完成 notice",
    );
    // 假 pi 收到 compact 命令
    const records = readFakePiLog(logPath);
    const compacts = logRecordsWith(records, "in", "compact");
    assert.ok(compacts.length >= 1, `假 pi 日志中必须出现 compact 命令（实际 ${compacts.length} 条）`);
  });

  test("agent_settled 清理未决对话框（pi 超时自动 resolve 路径）", async () => {
    // ASKUI-TIMEOUT：假 pi 发 select 帧后不等待回复，延时走完流并 settle
    const marker = `ASKUI-TIMEOUT-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);

    await waitFor(() => api.getPendingUi().length > 0, 10000, "对话框请求广播");
    assert.strictEqual(api.getPendingUi()[0].id, "ui-timeout-1");

    // 不回复，等待流自然结束（模拟 pi 超时自动 resolve）
    await api.waitForSettled(30000, baseline);
    assert.strictEqual(api.getPendingUi().length, 0, "settled 后未决对话框必须被清理");
  });

  test("pi 崩溃时清理未决对话框（handleExit 路径）", async () => {
    // UIREQUEST-CRASH：假 pi 发 confirm 帧后 1.5s 崩溃——对话框 pending 期间进程退出
    const marker = `UIREQUEST-CRASH-${Date.now()}`;
    await api.sendPrompt(marker);
    await waitFor(() => api.getPendingUi().length > 0, 10000, "对话框请求广播");
    await waitFor(() => api.getStatus().processState === "error", 15000, "pi 崩溃进入 error");
    assert.strictEqual(api.getPendingUi().length, 0, "崩溃后未决对话框必须清空");

    // 恢复现场供后续测试：重启
    await api.restart();
    await waitFor(
      () => api.getStatus().processState === "running" && api.getStatus().model !== null,
      20000,
      "重启后恢复",
    );
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

  test("模型自愈：get_state 前几次为空 → 重试后恢复（无自动重启）", async function () {
    this.timeout(60000);
    // NULLMODEL-FIRST：前 2 次 get_state 返回 model:null，第 3 次正常。
    // 场景经环境变量在 spawn 时激活（首次 get_state 发生在任何 prompt 之前，
    // prompt 子串标记机制不可用）。
    process.env.PINEL_FAKE_PI_SCENARIO = "NULLMODEL-FIRST";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "NULLMODEL-FIRST 重试后恢复模型",
      );
      const heal = api.getModelHealInfo();
      assert.strictEqual(heal.autoRestarted, false, "重试恢复不得触发自动重启");
      assert.strictEqual(heal.attempts, 3, `第 3 次尝试成功（实际 attempts=${heal.attempts}）`);
    } finally {
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart(); // 恢复默认场景供后续测试
    }
  });

  test("模型自愈：模型持续为空 → 自动重启恰好一次 → 警告态", async function () {
    this.timeout(90000);
    process.env.PINEL_FAKE_PI_SCENARIO = "NULLMODEL-FOREVER";
    try {
      // restart 链式等待自愈完成：手动重启（4 次尝试耗尽）→ 自动重启一次（短路为单次尝试）
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model === null,
        30000,
        "自愈重启后进入警告态（running + model 为空）",
      );
      const heal = api.getModelHealInfo();
      assert.strictEqual(heal.autoRestarted, true, "必须触发过自动重启自愈");
      assert.strictEqual(heal.attempts, 1, `重启后的进程应短路为单次尝试（实际 ${heal.attempts}）`);

      // 恰好一次：日志中 NULLMODEL-FOREVER 场景的启动记录应恰好 2 个进程
      //（手动重启 + 自愈自动重启，各一）
      const startups = readFakePiLog(logPath).filter((r) => {
        const rec = r.record as { dir?: string; event?: string; scenario?: string };
        return rec?.dir === "meta" && rec.event === "startup" && rec.scenario === "NULLMODEL-FOREVER";
      });
      assert.strictEqual(
        startups.length,
        2,
        `NULLMODEL-FOREVER 场景应恰好启动 2 个进程（实际 ${startups.length}）`,
      );
    } finally {
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart(); // 恢复默认场景供后续测试
    }
  });

  // 注：「未打开文件夹」友好状态在独立空窗口实例套件覆盖
  //（src/test-no-workspace/no-workspace.test.ts）——主套件内移除全部工作区文件夹
  // 不可逆（VS Code 空窗口不支持 updateWorkspaceFolders 恢复）。

  test("旧版 pi 不支持 get_commands：静默空列表，启动不受影响", async function () {
    this.timeout(60000);
    // NOCOMMANDS：get_commands 回 success:false。场景经环境变量在 spawn 时激活
    //（首次 get_commands 发生在任何 prompt 之前，prompt 子串标记机制不可用）。
    process.env.PINEL_FAKE_PI_SCENARIO = "NOCOMMANDS";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "NOCOMMANDS 场景启动正常",
      );
      // 失败静默：命令列表为空（补全弹窗永不弹出）；启动关键路径未被 reject
      //（running + 模型已同步即证明）；不弹 notice 由实现保证（仅写 Output 日志）
      assert.deepStrictEqual(api.getCommands(), [], "get_commands 失败时命令列表必须为空");
      assert.strictEqual(api.getStatus().processState, "running", "start 不得被 get_commands 失败拒绝");
    } finally {
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart(); // 恢复默认场景供后续测试
    }
  });

  test("问卷全链路：本地整卷 → 确认后按序回填（多选数字 + 哨兵自定义 + 修改重答）", async function () {
    this.timeout(60000);
    const marker = `QUESTIONNAIRE-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);

    // 问卷模式进入：3 题（来自 tool_execution_start 参数）
    await waitFor(() => (api.getQuestionnaire()?.questions.length ?? 0) === 3, 10000, "问卷进入");
    const q = api.getQuestionnaire()!;
    assert.strictEqual(q.phase, "answering");
    assert.strictEqual(q.questions[0].question, "问题一？");
    assert.strictEqual(q.questions[1].multiSelect, true);
    assert.strictEqual(q.id, "qna_1", "问卷 id 必须来自 tool_execution_start 的 toolCallId");

    // 答题：Q1 选 A、Q2 多选 1/3、Q3 自定义
    api.questionnaireAnswer(0, { kind: "option", optionIndex: 0 });
    api.questionnaireAnswer(1, { kind: "multi", optionIndices: [2, 0] });
    api.questionnaireAnswer(2, { kind: "custom", text: "自定义三" });
    await waitFor(() => api.getQuestionnaire()?.phase === "reviewing", 5000, "全答完转 reviewing");
    assert.strictEqual(api.getQuestionnaire()?.id, "qna_1", "答题广播后问卷 id 必须保持稳定");

    // 确认前修改：Q1 改答 B（最终答案为准）
    api.questionnaireAnswer(0, { kind: "option", optionIndex: 1 });
    assert.strictEqual(api.getQuestionnaire()?.phase, "reviewing", "修改不改变 reviewing 阶段");

    api.questionnaireConfirm();
    await waitFor(() => api.getQuestionnaire()?.phase === "submitted", 15000, "回填完成转 submitted");
    await api.waitForSettled(30000, baseline);
    await waitFor(() => api.getQuestionnaire() === null, 5000, "settle 后清卷");

    // 回填断言（fake-pi 逐题响应日志；按 prompt 边界切片防跨测试累积）
    const records = recordsAfterPrompt(readFakePiLog(logPath), marker);
    const responseFor = (id: string): { value?: string; cancelled?: boolean } => {
      const hits = records.filter((r) => {
        const rec = r.record as { dir?: string; id?: string };
        return rec?.dir === "ui-response" && rec?.id === id;
      });
      assert.strictEqual(hits.length, 1, `必须恰好收到一次 ${id} 响应`);
      return (hits[0].record as { response?: { value?: string; cancelled?: boolean } }).response ?? {};
    };
    assert.strictEqual(responseFor("qna-1").value, "2. B — 选项 B", "Q1 必须回最终修改后的答案");
    assert.strictEqual(responseFor("qna-2").value, "1,3", "Q2 多选必须回 1 基升序数字串");
    assert.strictEqual(responseFor("qna-3").value, "3. Type something.", "Q3 自定义必须先回哨兵行");
    assert.strictEqual(responseFor("qna-3i").value, "自定义三", "Q3 跟进 input 必须回自定义文本");
  });

  test("问卷取消：缓冲帧回 cancelled，插件放弃后续题目", async function () {
    this.timeout(60000);
    const marker = `QUESTIONNAIRE-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await waitFor(() => (api.getQuestionnaire()?.questions.length ?? 0) === 3, 10000, "问卷进入");

    api.questionnaireAnswer(0, { kind: "option", optionIndex: 0 });
    api.questionnaireCancel();
    await waitFor(() => api.getQuestionnaire() === null, 5000, "取消后清卷");
    await api.waitForSettled(30000, baseline);

    const records = recordsAfterPrompt(readFakePiLog(logPath), marker);
    const qna1 = records.filter((r) => {
      const rec = r.record as { dir?: string; id?: string; response?: { cancelled?: boolean } };
      return rec?.dir === "ui-response" && rec?.id === "qna-1";
    });
    assert.strictEqual(qna1.length, 1, "qna-1 必须收到 cancelled");
    assert.strictEqual(
      (qna1[0].record as { response?: { cancelled?: boolean } }).response?.cancelled,
      true,
    );
    const qna2 = records.filter(
      (r) => ((r.record as { id?: string })?.id ?? "") === "qna-2",
    );
    assert.strictEqual(qna2.length, 0, "取消后插件不得再发后续题目");
  });

  test("问卷取消竞态：首帧未到即取消 → 匹配帧回 cancelled 不阻塞 agent（QNA-SLOWFIRST）", async function () {
    this.timeout(60000);
    // fake-pi 首帧延迟 500ms：确定性制造「问卷已进入但 qna-1 帧尚未缓冲」窗口——
    // 修复前取消对空缓冲发零个 cancelled → walker 永久挂起 → settle 超时（flake 根因）
    const marker = `QUESTIONNAIRE-QNA-SLOWFIRST-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await waitFor(() => (api.getQuestionnaire()?.questions.length ?? 0) === 3, 10000, "问卷进入");

    api.questionnaireCancel();
    await waitFor(() => api.getQuestionnaire() === null, 5000, "取消后清卷");
    await api.waitForSettled(30000, baseline);

    const records = recordsAfterPrompt(readFakePiLog(logPath), marker);
    const qna1 = records.filter((r) => {
      const rec = r.record as { dir?: string; id?: string; response?: { cancelled?: boolean } };
      return rec?.dir === "ui-response" && rec?.id === "qna-1";
    });
    assert.strictEqual(qna1.length, 1, "qna-1 必须收到恰好一次 cancelled（延迟帧到达即回）");
    assert.strictEqual(
      (qna1[0].record as { response?: { cancelled?: boolean } }).response?.cancelled,
      true,
    );
    const qna2 = records.filter(
      (r) => ((r.record as { id?: string })?.id ?? "") === "qna-2",
    );
    assert.strictEqual(qna2.length, 0, "取消后插件不得再发后续题目");
  });

  test("问卷期间通用对话框走逐卡路径（标题门控不误缓冲）", async function () {
    this.timeout(60000);
    const marker = `QUESTIONNAIRE-GENERIC-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await waitFor(() => (api.getQuestionnaire()?.questions.length ?? 0) === 3, 10000, "问卷进入");
    const qnaId = api.getQuestionnaire()?.id;
    assert.ok(qnaId, "问卷必须有稳定 id");

    // 问卷期间穿插的通用 select（标题不匹配任何题目）→ 逐卡广播
    await waitFor(() => api.getPendingUi().length > 0, 10000, "通用对话框逐卡广播");
    const pending = api.getPendingUi()[0];
    assert.strictEqual(pending.id, "ui-generic-1", "必须广播通用对话框而非缓冲");
    assert.notStrictEqual(api.getQuestionnaire(), null, "问卷保持活动");
    assert.strictEqual(api.getQuestionnaire()?.id, qnaId, "通用对话框广播后问卷 id 不变");
    api.uiRespond(pending.id, { value: "1. Yes" });

    // 完成问卷（Q2 多选空选择 → 回空串）
    api.questionnaireAnswer(0, { kind: "option", optionIndex: 0 });
    api.questionnaireAnswer(1, { kind: "multi", optionIndices: [] });
    api.questionnaireAnswer(2, { kind: "option", optionIndex: 0 });
    await waitFor(() => api.getQuestionnaire()?.phase === "reviewing", 5000, "reviewing");
    assert.strictEqual(api.getQuestionnaire()?.id, qnaId, "答题广播后问卷 id 必须保持稳定");
    api.questionnaireConfirm();
    await api.waitForSettled(30000, baseline);

    const records = recordsAfterPrompt(readFakePiLog(logPath), marker);
    const responseFor = (id: string): { value?: string; cancelled?: boolean } => {
      const hits = records.filter((r) => {
        const rec = r.record as { dir?: string; id?: string };
        return rec?.dir === "ui-response" && rec?.id === id;
      });
      assert.strictEqual(hits.length, 1, `必须恰好收到一次 ${id} 响应`);
      return (hits[0].record as { response?: { value?: string; cancelled?: boolean } }).response ?? {};
    };
    assert.strictEqual(responseFor("ui-generic-1").value, "1. Yes", "通用对话框回复必须送达");
    assert.strictEqual(responseFor("qna-2").value, "", "多选空选择必须回空串");
    assert.strictEqual(responseFor("qna-1").value, "1. A — 选项 A");
    assert.strictEqual(responseFor("qna-3").value, "1. M — 选项 M");
  });

  test("问卷重入：同 prompt 第二份问卷重置 id 与答案", async function () {
    this.timeout(60000);
    const marker = `QUESTIONNAIRE-TWICE-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);

    // 第一份问卷
    await waitFor(() => (api.getQuestionnaire()?.questions.length ?? 0) === 3, 10000, "第一份问卷进入");
    assert.strictEqual(api.getQuestionnaire()?.id, "qna_1", "第一份问卷 id 必须为 toolCallId");
    api.questionnaireAnswer(0, { kind: "option", optionIndex: 0 });
    api.questionnaireAnswer(1, { kind: "multi", optionIndices: [0] });
    api.questionnaireAnswer(2, { kind: "option", optionIndex: 0 });
    await waitFor(() => api.getQuestionnaire()?.phase === "reviewing", 5000, "第一份全答完转 reviewing");
    api.questionnaireConfirm();
    await waitFor(() => api.getQuestionnaire()?.phase === "submitted", 15000, "第一份回填完成转 submitted");

    // 第一份 settle 清卷后，第二份同题问卷到达：新 id + 答案归零（重入重置分支）
    await waitFor(
      () => {
        const q2 = api.getQuestionnaire();
        return (
          q2 !== null &&
          q2.id !== "qna_1" &&
          q2.phase === "answering" &&
          q2.answers.every((a) => a === null)
        );
      },
      30000,
      "第二份问卷重入：新 id + 答案归零",
    );
    assert.strictEqual(api.getQuestionnaire()?.id, "qna_2", "第二份问卷 id 必须为新 toolCallId");

    // 清理：取消第二份（walker 收到 cancelled 放弃后续题目）
    api.questionnaireCancel();
    await waitFor(() => api.getQuestionnaire() === null, 5000, "取消清卷");
    await api.waitForSettled(30000, baseline);
  });

  // -------------------------------------------------------------------------
  // 配置面板（模型/思考强度循环 + 队列模式 + 自动压缩）
  // -------------------------------------------------------------------------

  test("配置面板：cycleModel 切到下一模型（thinkingLevel 同步）", async () => {
    await api.cycleModel();
    const s = api.getStatus();
    assert.strictEqual(s.model?.name, "Fake Model B", "模型必须循环到下一档");
    assert.strictEqual(s.thinkingLevel, "high", "cycle_model 响应携带的思考等级必须同步应用");
  });

  test("配置面板：连续 cycle 两模型循环回原点", async () => {
    // 前序测试后模型为 Fake Model B
    await api.cycleModel();
    assert.strictEqual(api.getStatus().model?.name, "Fake Model", "第一次循环回 Fake Model");
    await api.cycleModel();
    assert.strictEqual(api.getStatus().model?.name, "Fake Model B", "第二次循环回 Fake Model B");
    // 切回默认模型，保持后续测试基线
    await api.cycleModel();
    assert.strictEqual(api.getStatus().model?.name, "Fake Model", "恢复默认模型");
  });

  test("配置面板：cycleThinking 循环到下一等级（含回绕）", async () => {
    const LEVELS = ["off", "minimal", "low", "medium", "high"];
    const before = api.getStatus().thinkingLevel;
    await api.cycleThinkingLevel();
    const idx = LEVELS.indexOf(before);
    assert.ok(idx >= 0, `已知等级 ${before}`);
    assert.strictEqual(
      api.getStatus().thinkingLevel,
      LEVELS[(idx + 1) % LEVELS.length],
      "等级必须循环到下一档",
    );
    // 回绕回原等级，保持后续测试基线
    for (let i = 0; i < LEVELS.length - 1; i++) {
      await api.cycleThinkingLevel();
    }
    assert.strictEqual(api.getStatus().thinkingLevel, before, "恢复原等级");
  });

  test("配置面板：队列模式与自动压缩 set 命令更新状态", async () => {
    await api.setSteeringMode("one-at-a-time");
    assert.strictEqual(api.getStatus().steeringMode, "one-at-a-time");
    await api.setSteeringMode("all");
    assert.strictEqual(api.getStatus().steeringMode, "all");
    await api.setFollowUpMode("all");
    assert.strictEqual(api.getStatus().followUpMode, "all");
    await api.setFollowUpMode("one-at-a-time");
    assert.strictEqual(api.getStatus().followUpMode, "one-at-a-time");
    await api.setAutoCompaction(false);
    assert.strictEqual(api.getStatus().autoCompactionEnabled, false);
    await api.setAutoCompaction(true);
    assert.strictEqual(api.getStatus().autoCompactionEnabled, true);
  });

  test("配置面板：SINGLE-MODEL 场景 cycle_model 回 null，状态不变", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "SINGLE-MODEL";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "SINGLE-MODEL 场景启动",
      );
      const before = api.getStatus();
      await api.cycleModel();
      const after = api.getStatus();
      assert.strictEqual(after.model?.name, before.model?.name, "data:null 时模型不得变化");
      assert.strictEqual(after.thinkingLevel, before.thinkingLevel, "data:null 时思考等级不得变化");
    } finally {
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "恢复默认场景",
      );
    }
  });

  test("配置面板：NO-THINKING 场景 cycle_thinking_level 回 null，状态不变", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "NO-THINKING";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "NO-THINKING 场景启动",
      );
      const before = api.getStatus();
      await api.cycleThinkingLevel();
      const after = api.getStatus();
      assert.strictEqual(after.thinkingLevel, before.thinkingLevel, "data:null 时思考等级不得变化");
    } finally {
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "恢复默认场景",
      );
    }
  });

  test("配置面板：CYCLE-FAIL 场景切换失败，状态不变", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "CYCLE-FAIL";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "CYCLE-FAIL 场景启动",
      );
      const before = api.getStatus();
      await api.cycleModel(); // 内部 catch → notice，不抛异常
      const after = api.getStatus();
      assert.strictEqual(after.model?.name, before.model?.name, "success:false 时模型不得变化");
      assert.strictEqual(api.getStatus().processState, "running", "失败不得影响进程状态");
    } finally {
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "恢复默认场景",
      );
    }
  });

  test("配置面板：get_state 缺配置字段时保留默认值", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "NOSTATE-FIELDS";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "NOSTATE-FIELDS 场景启动",
      );
      const s = api.getStatus();
      assert.strictEqual(s.steeringMode, "all", "缺字段时 steeringMode 保留默认值");
      assert.strictEqual(s.followUpMode, "one-at-a-time", "缺字段时 followUpMode 保留默认值");
      assert.strictEqual(s.autoCompactionEnabled, true, "缺字段时 autoCompactionEnabled 保留默认值");
    } finally {
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "恢复默认场景",
      );
    }
  });

  test("配置面板：流式中 cycleModel 状态即时更新且流不中断", async function () {
    this.timeout(60000);
    const baseline = api.getSettledCount();
    await api.sendPrompt(`ABORTME-CONFIG-${Date.now()}`);
    await waitFor(() => api.getStatus().isStreaming, 10000, "流式开始");
    await api.cycleModel();
    assert.strictEqual(api.getStatus().model?.name, "Fake Model B", "流式中模型立即更新");
    assert.ok(api.getStatus().isStreaming, "切换不得中断流");
    await api.waitForSettled(30000, baseline);
    // 切回默认模型，保持后续测试基线
    await api.cycleModel();
    assert.strictEqual(api.getStatus().model?.name, "Fake Model", "恢复默认模型");
  });

  test("配置面板：重启后配置从状态文件恢复（持久化语义）", async function () {
    this.timeout(90000);
    // PINEL_FAKE_PI_STATE：假 pi 将配置内存态写入该文件、新进程启动时恢复
    //（模拟真实 pi 写 settings 的持久化）；唯一路径防跨测试/跨运行污染
    const statePath = path.join(
      os.tmpdir(),
      `pinel-fake-pi-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.PINEL_FAKE_PI_STATE = statePath;
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "带状态文件启动",
      );
      await api.cycleModel();
      assert.strictEqual(api.getStatus().model?.name, "Fake Model B", "模型循环到 B");
      await api.cycleThinkingLevel();
      assert.strictEqual(api.getStatus().thinkingLevel, "off", "思考等级从 high 回绕到 off");
      await api.setSteeringMode("one-at-a-time");
      await api.setFollowUpMode("all");
      await api.setAutoCompaction(false);
      assert.strictEqual(api.getStatus().steeringMode, "one-at-a-time");
      assert.strictEqual(api.getStatus().followUpMode, "all");
      assert.strictEqual(api.getStatus().autoCompactionEnabled, false);

      // 重启：新进程从状态文件恢复配置（重启类场景用 waitFor 轮询）
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model B",
        30000,
        "重启后模型从状态文件恢复",
      );
      const s = api.getStatus();
      assert.strictEqual(s.thinkingLevel, "off", "重启后思考等级保留");
      assert.strictEqual(s.steeringMode, "one-at-a-time", "重启后队列模式保留");
      assert.strictEqual(s.followUpMode, "all", "重启后跟进模式保留");
      assert.strictEqual(s.autoCompactionEnabled, false, "重启后自动压缩开关保留");
    } finally {
      delete process.env.PINEL_FAKE_PI_STATE;
      try {
        fs.unlinkSync(statePath);
      } catch {
        // 不存在即可
      }
      await api.restart(); // 恢复默认（无状态文件）场景
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "恢复默认场景",
      );
    }
  });

  // -------------------------------------------------------------------------
  // 模型/思考强度列表（get_available_models / set_model / 思考等级链路）
  // -------------------------------------------------------------------------

  /** 场景化测试公共收尾：清 env + 重启 + 等待默认状态（Fake Model / 无场景）。 */
  async function restoreDefaultScenario(): Promise<void> {
    delete process.env.PINEL_FAKE_PI_SCENARIO;
    await api.restart();
    await waitFor(
      () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
      30000,
      "恢复默认场景",
    );
  }

  test("模型列表：getModels 送达全量模型（含 provider 复合键所需字段）", async () => {
    await api.getModels();
    await waitFor(() => api.getTestEventLog().lastModels !== undefined, 10000, "models 事件送达");
    const models = api.getTestEventLog().lastModels ?? [];
    assert.deepStrictEqual(
      models.map((m) => ({ id: m.id, name: m.name, provider: m.provider })),
      [
        { id: "fake-model", name: "Fake Model", provider: "fake" },
        { id: "fake-model-b", name: "Fake Model B", provider: "fake" },
      ],
      "models 事件必须携带 id/name/provider（set_model 依赖 provider+modelId）",
    );
  });

  test("模型列表：MODELS-FAIL 场景 notice 且 events 为空数组（失败信号）", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "MODELS-FAIL";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "MODELS-FAIL 场景启动",
      );
      await api.getModels();
      await waitFor(() => api.getTestEventLog().lastModels?.length === 0, 10000, "失败信号（空数组）送达");
      const log = api.getTestEventLog();
      assert.ok(
        log.notices.some((n) => n.level === "warning" && n.text.includes("Fetch model list failed")),
        "必须弹出获取失败 warning notice",
      );
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("模型列表：setModel 切换到指定模型（思考等级经 get_state 回读保持）", async () => {
    await api.setModel("fake", "fake-model-b");
    await waitFor(() => api.getStatus().model?.name === "Fake Model B", 10000, "setModel 生效");
    const s = api.getStatus();
    assert.strictEqual(s.model?.provider, "fake", "provider 必须同步");
    assert.strictEqual(s.thinkingLevel, "high", "无 re-clamp 时思考等级保持（get_state 回读）");
    // 恢复基线
    await api.setModel("fake", "fake-model");
    await waitFor(() => api.getStatus().model?.name === "Fake Model", 10000, "恢复默认模型");
  });

  test("模型列表：SETMODEL-CLAMP 场景切模型后思考等级经 get_state 回读同步", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "SETMODEL-CLAMP";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "SETMODEL-CLAMP 场景启动",
      );
      await api.setModel("fake", "fake-model-b");
      await waitFor(() => api.getStatus().model?.name === "Fake Model B", 10000, "setModel 生效");
      await waitFor(() => api.getStatus().thinkingLevel === "medium", 10000, "思考等级回读为 medium");
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("模型列表：SETMODEL-MISS 场景模型未找到 → error notice 状态不变", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "SETMODEL-MISS";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "SETMODEL-MISS 场景启动",
      );
      const before = api.getStatus();
      await api.setModel("fake", "no-such-model");
      const after = api.getStatus();
      assert.strictEqual(after.model?.name, before.model?.name, "未找到时模型不得变化");
      assert.strictEqual(after.thinkingLevel, before.thinkingLevel, "未找到时思考等级不得变化");
      const log = api.getTestEventLog();
      assert.ok(
        log.notices.some((n) => n.level === "error" && n.text.includes("Switch model failed")),
        "必须弹出 error notice",
      );
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("思考列表：getThinkingLevels 送达全量等级；setThinkingLevel 生效", async () => {
    await api.getThinkingLevels();
    await waitFor(() => api.getTestEventLog().lastThinkingLevels !== undefined, 10000, "thinkingLevels 事件送达");
    assert.deepStrictEqual(api.getTestEventLog().lastThinkingLevels, ["off", "minimal", "low", "medium", "high"]);

    await api.setThinkingLevel("low");
    await waitFor(() => api.getStatus().thinkingLevel === "low", 10000, "setThinkingLevel 生效");
    // 恢复基线
    await api.setThinkingLevel("high");
    await waitFor(() => api.getStatus().thinkingLevel === "high", 10000, "恢复默认等级");
  });

  test("思考列表：THINKLEVELS-OFF 场景回 [off]（不支持思考的模型）", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "THINKLEVELS-OFF";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "THINKLEVELS-OFF 场景启动",
      );
      await api.getThinkingLevels();
      await waitFor(() => api.getTestEventLog().lastThinkingLevels !== undefined, 10000, "thinkingLevels 事件送达");
      assert.deepStrictEqual(api.getTestEventLog().lastThinkingLevels, ["off"], "不支持思考时仅 [off]");
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("思考列表：THINKLEVELS-FAIL 场景 notice 且空数组（失败信号）", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "THINKLEVELS-FAIL";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "THINKLEVELS-FAIL 场景启动",
      );
      await api.getThinkingLevels();
      await waitFor(() => api.getTestEventLog().lastThinkingLevels?.length === 0, 10000, "失败信号（空数组）送达");
      const log = api.getTestEventLog();
      assert.ok(
        log.notices.some((n) => n.level === "warning" && n.text.includes("Fetch thinking effort list failed")),
        "必须弹出获取失败 warning notice",
      );
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("思考列表：SETTHINK-CLAMP 场景 clamp 后 get_state 确认实际值", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "SETTHINK-CLAMP";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "SETTHINK-CLAMP 场景启动",
      );
      await api.setThinkingLevel("ultra"); // 不在支持列表：clamp 到最低支持值
      await waitFor(() => api.getStatus().thinkingLevel === "off", 10000, "clamp 后的实际值经 get_state 确认");
      const log = api.getTestEventLog();
      assert.ok(
        !log.notices.some((n) => n.level === "error" && n.text.includes("设置思考强度失败")),
        "clamp 不是失败，不得弹 error notice",
      );
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("思考列表：SETTHINK-FAIL 场景 error notice 状态不变", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "SETTHINK-FAIL";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "SETTHINK-FAIL 场景启动",
      );
      const before = api.getStatus();
      await api.setThinkingLevel("low");
      const after = api.getStatus();
      assert.strictEqual(after.thinkingLevel, before.thinkingLevel, "success:false 时思考等级不得变化");
      const log = api.getTestEventLog();
      assert.ok(
        log.notices.some((n) => n.level === "error" && n.text.includes("Set thinking effort failed")),
        "必须弹出 error notice",
      );
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("模型列表：SETMODEL-READBACKFAIL 回读失败 → notice 且模型保留 set_model 结果", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "SETMODEL-READBACKFAIL";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "SETMODEL-READBACKFAIL 场景启动",
      );
      await api.setModel("fake", "fake-model-b");
      await waitFor(() => api.getStatus().model?.name === "Fake Model B", 10000, "set_model 结果先应用");
      await waitFor(
        () =>
          api
            .getTestEventLog()
            .notices.some((n) => n.level === "warning" && n.text.includes("State read-back failed")),
        10000,
        "回读失败 warning notice",
      );
      assert.strictEqual(api.getStatus().model?.name, "Fake Model B", "回读失败后模型保留 set_model 结果");
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("模型列表：SETMODEL-SLOW 迟到响应竞态——restart 后不残留旧进程结果", async function () {
    this.timeout(60000);
    process.env.PINEL_FAKE_PI_SCENARIO = "SETMODEL-SLOW";
    try {
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "SETMODEL-SLOW 场景启动",
      );
      // fire-and-forget：set_model 在旧进程延时 1.5s 响应，立即 restart
      void api.setModel("fake", "fake-model-b");
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
        30000,
        "重启完成",
      );
      // 等待超过延时窗口（若迟到响应污染新状态，此时应已可见）
      await new Promise((resolve) => setTimeout(resolve, 2000));
      assert.strictEqual(api.getStatus().model?.name, "Fake Model", "新进程状态不得残留旧响应");
      assert.strictEqual(api.getStatus().thinkingLevel, "high", "思考等级也不得被污染");
    } finally {
      await restoreDefaultScenario();
    }
  });

  test("模型列表：流式中 setModel 状态即时更新且流不中断", async function () {
    this.timeout(60000);
    const baseline = api.getSettledCount();
    await api.sendPrompt(`ABORTME-CONFIG-${Date.now()}`);
    await waitFor(() => api.getStatus().isStreaming, 10000, "流式开始");
    await api.setModel("fake", "fake-model-b");
    await waitFor(() => api.getStatus().model?.name === "Fake Model B", 10000, "流式中 setModel 生效");
    assert.ok(api.getStatus().isStreaming, "切换不得中断流");
    await api.waitForSettled(30000, baseline);
    // 恢复基线
    await api.setModel("fake", "fake-model");
    await waitFor(() => api.getStatus().model?.name === "Fake Model", 10000, "恢复默认模型");
  });

  // ---------------------------------------------------------------------------
  // 会话历史：列表扫描 / 切换 / 新建（假会话文件 + 临时 sessionDir）
  // ---------------------------------------------------------------------------

  /** 会话文件 header（假元信息）。 */
  function sessionHeader(id: string, timestamp: string): string {
    return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/fake/project" });
  }

  suite("会话历史：列表/切换/新建（假会话文件）", () => {
    let sessionDir: string;
    let sessionA: string;
    let sessionB: string;
    let sessionBroken: string;

    suiteSetup(async function () {
      this.timeout(120000);
      // 临时会话目录（唯一路径防跨运行污染）+ 假会话文件
      sessionDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinel-session-dir-"));
      sessionA = path.join(sessionDir, "2026-08-17T01-00-00-000Z_aaaa.jsonl");
      sessionB = path.join(sessionDir, "2026-08-18T01-00-00-000Z_bbbb.jsonl");
      sessionBroken = path.join(sessionDir, "2026-08-16T01-00-00-000Z_cccc.jsonl");
      await fs.promises.writeFile(
        sessionA,
        [
          sessionHeader("session-a", "2026-08-17T01:00:00.000Z"),
          JSON.stringify({
            type: "session_info",
            id: "a1",
            parentId: null,
            timestamp: "2026-08-17T01:01:00.000Z",
            name: "重构认证模块",
          }),
          JSON.stringify({
            type: "message",
            id: "a2",
            parentId: null,
            timestamp: "2026-08-17T01:02:00.000Z",
            message: { role: "user", content: "帮我重构认证模块" },
          }),
        ].join("\n"),
      );
      await fs.promises.writeFile(
        sessionB,
        [
          sessionHeader("session-b", "2026-08-18T01:00:00.000Z"),
          JSON.stringify({
            type: "message",
            id: "b1",
            parentId: null,
            timestamp: "2026-08-18T01:02:00.000Z",
            message: {
              role: "user",
              content: [
                { type: "image", data: "x", mimeType: "image/png" },
                { type: "text", text: "看图说话" },
              ],
            },
          }),
        ].join("\n"),
      );
      await fs.promises.writeFile(sessionBroken, "{broken header");
      // mtime 排序控制：B 最新、A 次之（损坏文件本就跳过）
      const now = Date.now();
      await fs.promises.utimes(sessionB, new Date(now), new Date(now));
      await fs.promises.utimes(sessionA, new Date(now - 60_000), new Date(now - 60_000));

      // 配置扩展扫描自定义会话目录（fake-pi 忽略 --session-dir 参数，无影响）。
      // 注意：config.update 的 thenable 在主进程持久化完成时 resolve，扩展宿主
      // 的配置缓存经 IPC 广播刷新（onDidChangeConfiguration）——立即 focus 会
      // 读到旧缓存导致扫默认目录。轮询值验证（验证的正是 provider 依赖的
      // 确切条件，无事件先于监听注册发出而落空的死角）。
      const config = vscode.workspace.getConfiguration("pinel");
      await config.update("sessionDir", sessionDir, vscode.ConfigurationTarget.Global);
      await waitFor(
        () => vscode.workspace.getConfiguration("pinel").get<string>("sessionDir") === sessionDir,
        5000,
        "sessionDir 配置传播到扩展宿主",
      );
      // 打开历史视图触发 provider resolve + 首次扫描
      await vscode.commands.executeCommand("pinel.sessionHistory.focus");
    });

    suiteTeardown(async () => {
      const config = vscode.workspace.getConfiguration("pinel");
      await config.update("sessionDir", "", vscode.ConfigurationTarget.Global);
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    });

    test("列表送达：扫描自定义目录 + mtime 排序 + 元信息 + 损坏文件跳过", async () => {
      await waitFor(() => api.getSessionList().length >= 2, 10000, "历史列表送达");
      const list = api.getSessionList();
      assert.strictEqual(list[0].path, sessionB, "mtime 最新在前");
      assert.strictEqual(list[1].path, sessionA);
      assert.ok(!list.some((i) => i.path === sessionBroken), "损坏文件必须跳过");
      const a = list.find((i) => i.path === sessionA);
      assert.strictEqual(a?.name, "重构认证模块", "session_info 名称解析");
      assert.ok(a?.preview?.includes("帮我重构认证模块"), "首条 user 消息预览");
      assert.ok(a?.truncated === false, "短文件不标记 truncated");
      const b = list.find((i) => i.path === sessionB);
      assert.ok(b?.preview?.includes("看图说话"), "数组形态 content 提取");
    });

    test("切换会话：switch_session 送达 + 消息替换 + 高亮更新", async function () {
      this.timeout(60000);
      // 制造默认会话消息（切换后应被替换为 fake-pi 的 B 会话数据）
      const baseline = api.getSettledCount();
      await api.sendPrompt(`SWITCHME-${Date.now()}`);
      await api.waitForSettled(30000, baseline);
      assert.ok(api.getMessages().length >= 2, "默认会话必须有消息");

      await api.switchSession(sessionA);
      await waitFor(() => api.getCurrentSessionFile() === sessionA, 10000, "切换后 sessionFile 回显");
      // 消息替换为 B 会话数据（非旧会话残留）
      const msgs = api.getMessages();
      assert.strictEqual(msgs.length, 2, "B 会话消息条数");
      assert.strictEqual(msgs[0].content, "B 会话的问题", "B 会话首条消息");
      // 高亮：provider 广播的当前会话文件指向 sessionA
      await waitFor(() => api.getLastCurrentSessionFile() === sessionA, 10000, "高亮更新");
      // 命令送达（fake-pi 日志跨测试累积，取最近一条 switch_session 断言 sessionPath）
      const records = readFakePiLog(logPath);
      const switches = records.filter((r) => {
        const rec = r.record as { dir?: string; record?: { type?: string; sessionPath?: string } } | undefined;
        return rec?.dir === "in" && rec?.record?.type === "switch_session" && rec?.record?.sessionPath === sessionA;
      });
      assert.ok(switches.length >= 1, "switch_session 必须携带 sessionPath");
    });

    test("切换会话后旧待办清零", async function () {
      this.timeout(60000);
      // 制造当前会话待办（切换后必须清零而非残留显示）
      await api.sendPrompt(`TODOME-${Date.now()}`);
      await waitFor(() => api.getTodos().length === 2, 15000, "切换前待办填充");

      await api.switchSession(sessionA);
      await waitFor(() => api.getCurrentSessionFile() === sessionA, 10000, "切换后 sessionFile 回显");
      assert.deepStrictEqual(api.getTodos(), [], "切换后待办必须清零");
    });

    test("新建会话：new_session 送达 + 消息清空 + 新会话文件", async function () {
      this.timeout(60000);
      // 当前可能是前序测试切换后的 B 会话：直接制造新消息再新建
      const baseline = api.getSettledCount();
      await api.sendPrompt(`NEWME-${Date.now()}`);
      await api.waitForSettled(30000, baseline);
      assert.ok(api.getMessages().length > 0, "新建前必须有消息");
      const oldFile = api.getCurrentSessionFile();

      await api.newSession();
      await waitFor(
        () => api.getCurrentSessionFile() !== undefined && api.getCurrentSessionFile() !== oldFile,
        10000,
        "新会话文件生成",
      );
      assert.deepStrictEqual(api.getMessages(), [], "新建后消息清空");
      // 切换状态复位断言：主流程 finally 必发 sessionSwitching:false
      //（HistoryApp 本地乐观置位依赖宿主复位，否则历史面板卡「切换中」）
      assert.strictEqual(api.getTestEventLog().lastSessionSwitching, false, "新建后必须广播 switching:false");
      const records = readFakePiLog(logPath);
      const news = logRecordsWith(records, "in", "new_session");
      assert.ok(news.length >= 1, "new_session 命令送达");
    });

    test("/new 命令：本地拦截并新建会话", async function () {
      this.timeout(60000);
      const oldFile = api.getCurrentSessionFile();
      await api.sendPrompt("/new");
      await waitFor(
        () => api.getCurrentSessionFile() !== undefined && api.getCurrentSessionFile() !== oldFile,
        10000,
        "新会话文件生成",
      );
      assert.deepStrictEqual(api.getMessages(), [], "新建后消息清空");
      // /new 不得作为 prompt 送达 pi（精确匹配断言免疫跨测试累积；
      // 不得断言「最近 in 为 new_session」——后随 get_messages/get_state 入站）
      const records = readFakePiLog(logPath);
      const slashPrompts = records.filter((r) => {
        const rec = r.record as { dir?: string; record?: { type?: string; message?: string } } | undefined;
        return rec?.dir === "in" && rec?.record?.type === "prompt" && rec?.record?.message === "/new";
      });
      assert.strictEqual(slashPrompts.length, 0, "/new 不得作为 prompt 送达 pi");
    });

    test("/new 带参数时原样送达 pi（不拦截）", async function () {
      this.timeout(60000);
      const marker = `/new extra-${Date.now()}`;
      const before = api.getCurrentSessionFile();
      const baseline = api.getSettledCount();
      await api.sendPrompt(marker);
      await api.waitForSettled(30000, baseline);
      const records = readFakePiLog(logPath);
      const after = recordsAfterPrompt(records, marker);
      const promptRecs = logRecordsWith(after, "in", "prompt");
      assert.ok(promptRecs.length >= 1, "/new 带参数必须作为 prompt 送达");
      assert.strictEqual(api.getCurrentSessionFile(), before, "带参数不得触发新建");
    });

    test("流式中 /new：abort 后新建会话", async function () {
      this.timeout(60000);
      const before = api.getCurrentSessionFile();
      // ABORTME：慢速流（每事件 400ms），不等待 settle 直接发 /new
      void api.sendPrompt("ABORTME 流式中 /new");
      await new Promise((resolve) => setTimeout(resolve, 300)); // 确保流已开始
      assert.ok(api.getStatus().isStreaming, "流已开始");
      await api.sendPrompt("/new");
      await waitFor(() => api.getCurrentSessionFile() !== before, 15000, "流式中 /new 成功");
      assert.ok(api.getStatus().isStreaming === false, "abort 后流停止");
      // 拦截早退在 isStreaming 分支之前：/new 不得转为 steer 送达
      const records = readFakePiLog(logPath);
      const steers = records.filter((r) => {
        const rec = r.record as { dir?: string; record?: { type?: string; message?: string } } | undefined;
        return rec?.dir === "in" && rec?.record?.type === "steer" && rec?.record?.message === "/new";
      });
      assert.strictEqual(steers.length, 0, "/new 不得转为 steer 送达");
    });

    test("重启恢复会话：spawn 携带 --session 指向上次会话文件", async function () {
      this.timeout(60000);
      // 切到真实存在的会话文件（reload/restart 后应继续该会话而非新建）
      await api.switchSession(sessionA);
      await waitFor(() => api.getCurrentSessionFile() === sessionA, 10000, "切换后 sessionFile 回显");

      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        30000,
        "重启后恢复",
      );
      // 最新 fake-pi 进程应收到 --session <上次会话文件>（恢复链路断言；
      // fake-pi 忽略该参数——真实 pi 会打开指定会话文件继续）
      const records = readFakePiLog(logPath);
      const startups = records.filter((r) => {
        const rec = r.record as { dir?: string; event?: string } | undefined;
        return rec?.dir === "meta" && rec?.event === "startup";
      });
      assert.ok(startups.length >= 1, "必须有 fake-pi 启动记录");
      const argv = (startups[startups.length - 1].record as { argv?: string[] }).argv ?? [];
      assert.ok(argv.includes("--session"), "spawn 必须携带 --session 参数");
      assert.ok(argv.includes(sessionA), "--session 必须指向上次会话文件");
    });

    test("会话文件已删除时重启不恢复（回退新建会话）", async function () {
      this.timeout(60000);
      // 独立临时会话文件：删除后不影响其他测试使用的 sessionA/sessionB
      const sessionGone = path.join(sessionDir, `2026-08-19T01-00-00-000Z_${Date.now()}.jsonl`);
      await fs.promises.writeFile(sessionGone, sessionHeader("session-gone", "2026-08-19T01:00:00.000Z"));
      await api.switchSession(sessionGone);
      await waitFor(() => api.getCurrentSessionFile() === sessionGone, 10000, "切换后 sessionFile 回显");
      await fs.promises.rm(sessionGone);

      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        30000,
        "重启后恢复",
      );
      const records = readFakePiLog(logPath);
      const startups = records.filter((r) => {
        const rec = r.record as { dir?: string; event?: string } | undefined;
        return rec?.dir === "meta" && rec?.event === "startup";
      });
      const argv = (startups[startups.length - 1].record as { argv?: string[] }).argv ?? [];
      assert.ok(!argv.includes("--session"), "会话文件已删除：spawn 不得携带 --session");
    });

    test("SWITCH-CANCEL：切换被取消 → 状态保持 + info notice", async function () {
      this.timeout(60000);
      process.env.PINEL_FAKE_PI_SCENARIO = "SWITCH-CANCEL";
      try {
        await api.restart();
        await waitFor(
          () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
          30000,
          "SWITCH-CANCEL 场景启动",
        );
        const baseline = api.getSettledCount();
        await api.sendPrompt(`CANCELME-${Date.now()}`);
        await api.waitForSettled(30000, baseline);
        const beforeCount = api.getMessages().length;
        const beforeFile = api.getCurrentSessionFile();

        await api.switchSession(sessionA);
        // cancelled：命令往返已完成，状态必须保持
        assert.strictEqual(api.getCurrentSessionFile(), beforeFile, "取消后会话不得切换");
        assert.strictEqual(api.getMessages().length, beforeCount, "取消后消息不得替换");
        const log = api.getTestEventLog();
        assert.ok(
          log.notices.some((n) => n.text.includes("Session switch cancelled")),
          "必须弹出取消提示",
        );
      } finally {
        await restoreDefaultScenario();
      }
    });

    test("SWITCH-LATE-END：切换后迟到的旧流 agent_end 不污染新会话", async function () {
      this.timeout(60000);
      process.env.PINEL_FAKE_PI_SCENARIO = "SWITCH-LATE-END";
      try {
        await api.restart();
        await waitFor(
          () => api.getStatus().processState === "running" && api.getStatus().model?.name === "Fake Model",
          30000,
          "SWITCH-LATE-END 场景启动",
        );
        // 制造消息（旧流快照非空才有污染风险）
        const baseline = api.getSettledCount();
        await api.sendPrompt(`LATEEND-${Date.now()}`);
        await api.waitForSettled(30000, baseline);
        assert.ok(api.getMessages().length >= 2, "旧会话必须有消息");

        await api.switchSession(sessionA);
        await waitFor(() => api.getCurrentSessionFile() === sessionA, 10000, "切换完成");
        // 等待 fake-pi 延迟 400ms 补发的旧 agent_end 到达并被防护丢弃
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const msgs = api.getMessages();
        assert.strictEqual(msgs.length, 2, "迟到 agent_end 不得覆盖为旧消息");
        assert.strictEqual(msgs[0].content, "B 会话的问题", "消息保持 B 会话数据");
      } finally {
        await restoreDefaultScenario();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 聊天 header 会话历史列表（controller.getSessionList 实时扫描路径）
  // ---------------------------------------------------------------------------

  suite("聊天 header 会话历史列表（controller 扫描路径）", () => {
    let sessionDir: string;
    let sessionA: string;
    let sessionB: string;

    /** 会话文件 header（假元信息）。 */
    function sessionHeader(id: string, timestamp: string): string {
      return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/fake/project" });
    }

    suiteSetup(async function () {
      this.timeout(120000);
      sessionDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinel-chat-sessions-"));
      sessionA = path.join(sessionDir, "2026-08-17T01-00-00-000Z_aaaa.jsonl");
      sessionB = path.join(sessionDir, "2026-08-18T01-00-00-000Z_bbbb.jsonl");
      const broken = path.join(sessionDir, "2026-08-16T01-00-00-000Z_cccc.jsonl");
      await fs.promises.writeFile(
        sessionA,
        [
          sessionHeader("chat-session-a", "2026-08-17T01:00:00.000Z"),
          JSON.stringify({
            type: "session_info",
            id: "a1",
            parentId: null,
            timestamp: "2026-08-17T01:01:00.000Z",
            name: "聊天入口会话",
          }),
          JSON.stringify({
            type: "message",
            id: "a2",
            parentId: null,
            timestamp: "2026-08-17T01:02:00.000Z",
            message: { role: "user", content: "聊天入口第一条消息" },
          }),
        ].join("\n"),
      );
      await fs.promises.writeFile(
        sessionB,
        [
          sessionHeader("chat-session-b", "2026-08-18T01:00:00.000Z"),
          JSON.stringify({
            type: "message",
            id: "b1",
            parentId: null,
            timestamp: "2026-08-18T01:02:00.000Z",
            message: { role: "user", content: "更新的会话" },
          }),
        ].join("\n"),
      );
      await fs.promises.writeFile(broken, "{broken header");
      // mtime 排序控制：B 最新、A 次之（损坏文件本就跳过）
      const now = Date.now();
      await fs.promises.utimes(sessionB, new Date(now), new Date(now));
      await fs.promises.utimes(sessionA, new Date(now - 60_000), new Date(now - 60_000));

      // 配置扩展扫描自定义会话目录（fake-pi 忽略 --session-dir 参数，无影响）；
      // config.update 的 IPC 传播为异步，轮询值验证（同会话历史 suite 模式）
      const config = vscode.workspace.getConfiguration("pinel");
      await config.update("sessionDir", sessionDir, vscode.ConfigurationTarget.Global);
      await waitFor(
        () => vscode.workspace.getConfiguration("pinel").get<string>("sessionDir") === sessionDir,
        5000,
        "sessionDir 配置传播到扩展宿主",
      );
    });

    suiteTeardown(async () => {
      const config = vscode.workspace.getConfiguration("pinel");
      await config.update("sessionDir", "", vscode.ConfigurationTarget.Global);
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    });

    test("getChatSessionList：controller 实时扫描（排序/元信息/损坏跳过）", async function () {
      this.timeout(60000);
      const list = await api.getChatSessionList();
      assert.strictEqual(list.length, 2, "损坏文件跳过");
      assert.strictEqual(list[0].path, sessionB, "mtime 最新在前");
      assert.strictEqual(list[1].path, sessionA);
      const a = list.find((i) => i.path === sessionA);
      assert.strictEqual(a?.name, "聊天入口会话", "session_info 名称解析");
      assert.ok(a?.preview?.includes("聊天入口第一条消息"), "首条 user 消息预览");
      // currentSessionFile 由 panel 拼装（getStatus().sessionFile）：fake-pi 会话在
      // /fake/ 目录外，仅断言其存在（高亮匹配由切换链路既有测试覆盖）
      assert.ok(typeof api.getStatus().sessionFile === "string", "sessionFile 存在");
    });

    test("getChatSessionList 与历史视图扫描一致（共享扫描链路）", async function () {
      this.timeout(60000);
      // 关闭并重开历史视图：销毁旧 webview 触发重新 resolve + 扫描
      //（旧视图可能缓存了上一 suite 的扫描结果/旧配置）
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await vscode.commands.executeCommand("pinel.sessionHistory.focus");
      await waitFor(
        () => api.getSessionList().length >= 2 && api.getSessionList()[0].path === sessionB,
        15000,
        "历史视图按新配置重新扫描",
      );
      const viaProvider = api.getSessionList().map((i) => i.path).sort();
      const viaController = (await api.getChatSessionList()).map((i) => i.path).sort();
      assert.deepStrictEqual(viaController, viaProvider, "两条路径扫描结果一致");
    });
  });

  // ---------------------------------------------------------------------------
  // 会话标题广播（header 标题链路）
  // ---------------------------------------------------------------------------

  suite("会话标题广播（sessionTitle）", () => {
    test("启动后标题消息送达（fake-pi 无真实会话文件 → undefined）", async function () {
      this.timeout(60000);
      // restart 触发 fireSnapshot → sessionFile 变化检测 → 异步解析广播
      await api.restart();
      await waitFor(() => api.getStatus().processState === "running", 30000, "重启完成");
      await waitFor(
        () => api.getTestEventLog().lastSessionTitle !== undefined,
        15000,
        "sessionTitle 广播送达",
      );
      // fake-pi 的 sessionFile 为内存态 /fake/session.jsonl（文件不存在）→ 解析失败 undefined
      assert.strictEqual(
        api.getTestEventLog().lastSessionTitle?.title,
        undefined,
        "无会话文件时标题为 undefined",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 会话重命名/删除（会话列表行操作）
  // ---------------------------------------------------------------------------

  suite("会话重命名/删除（会话列表行操作）", () => {
    let sessionDir: string;
    let sessionA: string;
    let sessionB: string;

    function sessionHeader(id: string, timestamp: string): string {
      return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/fake/project" });
    }

    function setSessionNameRecords(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
      return records.filter((r) => {
        const rec = r.record as { dir?: string; record?: { type?: string } } | undefined;
        return rec?.dir === "in" && rec?.record?.type === "set_session_name";
      });
    }

    suiteSetup(async function () {
      this.timeout(120000);
      sessionDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinel-rename-sessions-"));
      sessionA = path.join(sessionDir, "2026-08-17T01-00-00-000Z_aaaa.jsonl");
      sessionB = path.join(sessionDir, "2026-08-18T01-00-00-000Z_bbbb.jsonl");
      await fs.promises.writeFile(
        sessionA,
        [
          sessionHeader("rename-session-a", "2026-08-17T01:00:00.000Z"),
          JSON.stringify({
            type: "session_info",
            id: "a1",
            parentId: null,
            timestamp: "2026-08-17T01:01:00.000Z",
            name: "旧名A",
          }),
          JSON.stringify({
            type: "message",
            id: "a2",
            parentId: null,
            timestamp: "2026-08-17T01:02:00.000Z",
            message: { role: "user", content: "A 的消息" },
          }),
        ].join("\n"),
      );
      await fs.promises.writeFile(
        sessionB,
        [
          sessionHeader("rename-session-b", "2026-08-18T01:00:00.000Z"),
          JSON.stringify({
            type: "message",
            id: "b1",
            parentId: null,
            timestamp: "2026-08-18T01:02:00.000Z",
            message: { role: "user", content: "B 的消息" },
          }),
        ].join("\n"),
      );
      // 配置扩展扫描自定义会话目录（同既有 suite 模式）
      const config = vscode.workspace.getConfiguration("pinel");
      await config.update("sessionDir", sessionDir, vscode.ConfigurationTarget.Global);
      await waitFor(
        () => vscode.workspace.getConfiguration("pinel").get<string>("sessionDir") === sessionDir,
        5000,
        "sessionDir 配置传播",
      );
    });

    suiteTeardown(async () => {
      const config = vscode.workspace.getConfiguration("pinel");
      await config.update("sessionDir", "", vscode.ConfigurationTarget.Global);
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    });

    test("非当前会话重命名：文件追加 session_info + 列表立即刷新（不依赖 pi）", async function () {
      this.timeout(60000);
      const before = api.getTestEventLog().sessionListRefreshCount;
      await api.renameSession(sessionB, "新名字B");
      await waitFor(
        () => api.getTestEventLog().sessionListRefreshCount > before,
        10000,
        "sessionListRefresh 广播",
      );
      // 文件物理追加：leaf id = 最后一个条目 b1，格式对齐 pi appendSessionInfo
      const content = await fs.promises.readFile(sessionB, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      const info = JSON.parse(lines[lines.length - 1]) as {
        type?: string;
        parentId?: unknown;
        name?: unknown;
      };
      assert.strictEqual(info.type, "session_info");
      assert.strictEqual(info.parentId, "b1");
      assert.strictEqual(info.name, "新名字B");
      // 列表扫描读出新名称
      const list = await api.getChatSessionList();
      assert.strictEqual(list.find((i) => i.path === sessionB)?.name, "新名字B");
      // 纯文件操作：当前会话仍是 fake-pi 内存态（未涉及 pi 进程）
      assert.strictEqual(api.getCurrentSessionFile(), "/fake/session.jsonl");
    });

    test("当前会话重命名：RPC set_session_name 送达 + 落盘 + 标题刷新", async function () {
      this.timeout(60000);
      // 前置：切到扫描目录内真实文件（fake-pi 落盘目标；标题解析自文件 session_info）
      await api.switchSession(sessionA);
      await waitFor(() => api.getCurrentSessionFile() === sessionA, 15000, "切换完成");
      await waitFor(
        () => api.getTestEventLog().lastSessionTitle?.title === "旧名A",
        15000,
        "切换后标题解析",
      );
      const before = api.getTestEventLog().sessionListRefreshCount;
      await api.renameSession(sessionA, "重命名A");
      // fake-pi 收到 set_session_name 命令（按入站计数断言，避免跨测试日志累积）
      await waitFor(
        () => setSessionNameRecords(readFakePiLog(logPath)).length > 0,
        10000,
        "set_session_name 送达 fake-pi",
      );
      const sent = setSessionNameRecords(readFakePiLog(logPath))[0];
      assert.strictEqual(
        (sent.record as { record?: { name?: string } }).record?.name,
        "重命名A",
        "命令携带新名称",
      );
      // 标题 force 重解析（RPC 成功 → 文件已落盘 → 读出新名）
      await waitFor(
        () => api.getTestEventLog().lastSessionTitle?.title === "重命名A",
        15000,
        "标题刷新为重命名结果",
      );
      await waitFor(
        () => api.getTestEventLog().sessionListRefreshCount > before,
        10000,
        "sessionListRefresh 广播",
      );
      // fake-pi 向真实文件物理追加（列表扫描可见）
      const list = await api.getChatSessionList();
      assert.strictEqual(list.find((i) => i.path === sessionA)?.name, "重命名A");
    });

    test("RENAME-FAIL 场景：notice 反馈且列表/标题不变", async function () {
      this.timeout(60000);
      process.env.PINEL_FAKE_PI_SCENARIO = "RENAME-FAIL";
      // 专用会话文件（独立于其他测试的重命名结果，避免顺序耦合）
      const sessionC = path.join(sessionDir, "2026-08-16T01-00-00-000Z_cccc.jsonl");
      await fs.promises.writeFile(
        sessionC,
        [
          sessionHeader("rename-session-c", "2026-08-16T01:00:00.000Z"),
          JSON.stringify({
            type: "session_info",
            id: "c1",
            parentId: null,
            timestamp: "2026-08-16T01:01:00.000Z",
            name: "FAIL旧名",
          }),
        ].join("\n"),
      );
      try {
        await api.restart();
        await waitFor(
          () => api.getStatus().processState === "running",
          30000,
          "RENAME-FAIL 场景启动",
        );
        await api.switchSession(sessionC);
        await waitFor(() => api.getCurrentSessionFile() === sessionC, 15000, "切换完成");
        await waitFor(
          () => api.getTestEventLog().lastSessionTitle?.title === "FAIL旧名",
          15000,
          "切换后标题解析",
        );
        const refreshBefore = api.getTestEventLog().sessionListRefreshCount;
        await api.renameSession(sessionC, "失败名");
        // 失败 notice（旧版 pi 无此命令 → send 抛错 → 可见反馈）
        await waitFor(
          () => api.getTestEventLog().notices.some((n) => n.text.includes("Rename failed")),
          10000,
          "重命名失败 notice",
        );
        // 状态不变：标题仍旧名、无刷新信号、文件未追加
        assert.strictEqual(api.getTestEventLog().lastSessionTitle?.title, "FAIL旧名");
        assert.strictEqual(api.getTestEventLog().sessionListRefreshCount, refreshBefore);
        const content = await fs.promises.readFile(sessionC, "utf8");
        assert.ok(!content.includes("失败名"), "文件未被追加");
      } finally {
        delete process.env.PINEL_FAKE_PI_SCENARIO;
        await api.restart();
        await waitFor(
          () => api.getStatus().processState === "running",
          30000,
          "恢复默认场景",
        );
        // 重启后当前会话回到 fake-pi 内存态；清理专用文件
        await fs.promises.rm(sessionC, { force: true });
      }
    });

    test("删除非当前会话：文件删除 + 列表立即刷新", async function () {
      this.timeout(60000);
      // 上一测试的 finally 重启后当前会话回到 fake-pi 内存态（非扫描目录内文件）
      const before = api.getTestEventLog().sessionListRefreshCount;
      await api.deleteSession(sessionB);
      await waitFor(() => !fs.existsSync(sessionB), 10000, "会话文件已删除");
      await waitFor(
        () => api.getTestEventLog().sessionListRefreshCount > before,
        10000,
        "sessionListRefresh 广播",
      );
      const list = await api.getChatSessionList();
      assert.ok(!list.some((i) => i.path === sessionB), "列表不再包含已删会话");
      assert.ok(fs.existsSync(sessionA), "当前会话文件不受影响");
    });

    test("删除当前会话：拒绝（notice）且文件保留", async function () {
      this.timeout(60000);
      // 先切到扫描目录内真实文件作为当前会话（上一测试后当前为 fake-pi 内存态）
      await api.switchSession(sessionA);
      await waitFor(() => api.getCurrentSessionFile() === sessionA, 15000, "切换完成");
      const refreshBefore = api.getTestEventLog().sessionListRefreshCount;
      await api.deleteSession(sessionA);
      assert.ok(
        api.getTestEventLog().notices.some((n) => n.text.includes("Current session cannot be deleted")),
        "拒绝 notice",
      );
      assert.ok(fs.existsSync(sessionA), "文件保留");
      assert.strictEqual(api.getTestEventLog().sessionListRefreshCount, refreshBefore, "无刷新信号");
    });

    test("删除确认 seam：showWarningMessage 拒绝/接受两条路径", async function () {
      this.timeout(60000);
      const orig = vscode.window.showWarningMessage;
      try {
        vscode.window.showWarningMessage = (async () => undefined) as typeof vscode.window.showWarningMessage;
        assert.strictEqual(await confirmSessionDelete(sessionA), false, "拒绝路径返回 false");
        assert.ok(fs.existsSync(sessionA), "确认 seam 本身不删文件");
        vscode.window.showWarningMessage = (async () => "Delete") as typeof vscode.window.showWarningMessage;
        assert.strictEqual(await confirmSessionDelete(sessionA), true, "确认路径返回 true");
      } finally {
        vscode.window.showWarningMessage = orig;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 会话分支/回溯（fork/clone：header 分支选择器链路）
  // ---------------------------------------------------------------------------

  suite("会话分支/回溯（fork/clone）", () => {
    let sessionDir: string;

    suiteSetup(async function () {
      this.timeout(120000);
      // 临时会话目录：fork/clone 物理落盘目标（fake-pi 经 PINEL_FAKE_PI_SESSION_DIR 写入）
      sessionDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinel-fork-sessions-"));
      const config = vscode.workspace.getConfiguration("pinel");
      await config.update("sessionDir", sessionDir, vscode.ConfigurationTarget.Global);
      process.env.PINEL_FAKE_PI_SESSION_DIR = sessionDir;
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        20000,
        "pi 进程启动（fork 套件）",
      );
    });

    suiteTeardown(async () => {
      const config = vscode.workspace.getConfiguration("pinel");
      await config.update("sessionDir", "", vscode.ConfigurationTarget.Global);
      delete process.env.PINEL_FAKE_PI_SESSION_DIR;
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      await api.restart();
    });

    /** 产生 N 条 user 消息（prompt 流式后 fake-pi 落内存态，get_fork_messages 派生）。 */
    const sendAndSettle = async (text: string) => {
      const baseline = api.getSettledCount();
      await api.sendPrompt(text);
      await api.waitForSettled(30000, baseline);
    };

    test("getForkMessages 送达：历史用户消息列表（防御解析）", async function () {
      this.timeout(60000);
      await sendAndSettle("分支测试第一条");
      await sendAndSettle("分支测试第二条");
      await api.getForkMessages();
      const log = api.getTestEventLog();
      assert.ok(log.lastForkMessages, "forkMessages 广播送达");
      const msgs = log.lastForkMessages!;
      assert.strictEqual(msgs.length, 2, "两条 user 消息（assistant/toolResult 排除）");
      assert.strictEqual(msgs[0].entryId, "fork-msg-0");
      assert.strictEqual(msgs[0].text, "分支测试第一条");
      assert.strictEqual(msgs[1].entryId, "fork-msg-1");
      assert.strictEqual(msgs[1].text, "分支测试第二条");
    });

    test("fork 全链路：切换新会话 + 消息截断 + 输入框回填 + 物理落盘 + 列表刷新", async function () {
      this.timeout(60000);
      const before = api.getCurrentSessionFile();
      await api.forkSession("fork-msg-1");
      // fork 后 pi 自动 rebind 新文件（客户端不得再发 switch_session）
      await waitFor(() => api.getCurrentSessionFile() !== before, 15000, "fork 后会话文件变化");
      const sessionFile = api.getCurrentSessionFile()!;
      assert.ok(sessionFile.startsWith(sessionDir), "新会话文件落在 sessionDir");
      assert.ok(fs.existsSync(sessionFile), "fork 文件物理落盘");
      // 落盘内容：header + 截断至 fork 点的祖先链（可被 scanSessions 解析）
      const content = fs.readFileSync(sessionFile, "utf8");
      assert.ok(content.startsWith('{"type":"session"'), "header 对齐 createBranchedSession");
      assert.ok(content.includes("分支测试第一条"), "祖先链含 fork 点前消息");
      assert.ok(content.includes("分支测试第二条"), "fork 点消息含在祖先链内（可回填重发）");
      // 截断验证：header + 4 条祖先链消息（fork 点之后的 assistant/toolResult 不落盘）
      const lines = content.trim().split("\n");
      assert.strictEqual(lines.length, 5, "落盘 = header + 截断至 fork 点的消息");
      // 消息截断：原 6 条（user/assistant/toolResult 交错）→ fork-msg-1 含其自身共 4 条
      const msgs = api.getMessages();
      assert.strictEqual(msgs.length, 4, "消息截断至 fork 点");
      assert.strictEqual(msgs[3].content, "分支测试第二条", "fork 点消息保留（可回填重发）");
      // 输入框回填被 fork 消息文本（fillPrompt；替换草稿语义对齐 Ctrl+G）
      assert.strictEqual(api.getTestEventLog().lastFillPrompt, "分支测试第二条");
      // 会话列表出现新文件（scanSessions 可解析）
      await waitFor(
        async () => (await api.getChatSessionList()).some((i) => i.path === sessionFile),
        10000,
        "会话列表出现 fork 文件",
      );
    });

    test("clone：复制当前分支为新会话文件并切换（副本内容一致）", async function () {
      this.timeout(60000);
      const before = api.getCurrentSessionFile();
      await api.cloneSession();
      await waitFor(() => api.getCurrentSessionFile() !== before, 15000, "clone 后会话文件变化");
      const sessionFile = api.getCurrentSessionFile()!;
      assert.ok(sessionFile.startsWith(sessionDir), "clone 文件落在 sessionDir");
      assert.ok(fs.existsSync(sessionFile), "clone 文件物理落盘");
      const content = fs.readFileSync(sessionFile, "utf8");
      assert.ok(content.includes("分支测试第一条"), "副本含原分支消息");
      // 消息保持完整（clone 不截断）
      assert.strictEqual(api.getMessages().length, 4, "clone 后消息完整");
      await waitFor(
        async () => (await api.getChatSessionList()).some((i) => i.path === sessionFile),
        10000,
        "会话列表出现 clone 文件",
      );
    });

    test("FORK-FAIL：error notice + 会话文件不变", async function () {
      this.timeout(60000);
      process.env.PINEL_FAKE_PI_SCENARIO = "FORK-FAIL";
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        20000,
        "pi 进程启动（FORK-FAIL）",
      );
      const before = api.getCurrentSessionFile();
      const noticesBefore = api.getTestEventLog().notices.length;
      await api.forkSession("fork-msg-0");
      await waitFor(
        () => api.getTestEventLog().notices.length > noticesBefore,
        10000,
        "fork 失败 notice",
      );
      const latest = api.getTestEventLog().notices[api.getTestEventLog().notices.length - 1];
      assert.strictEqual(latest.level, "error");
      assert.ok(latest.text.startsWith("Fork failed"), `notice 文案: ${latest.text}`);
      assert.strictEqual(api.getCurrentSessionFile(), before, "失败后会话文件不变");
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        20000,
        "pi 进程启动（恢复默认场景）",
      );
    });

    test("FORK-CANCELLED：info notice + 不刷新 + 不回填", async function () {
      this.timeout(60000);
      process.env.PINEL_FAKE_PI_SCENARIO = "FORK-CANCELLED";
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        20000,
        "pi 进程启动（FORK-CANCELLED）",
      );
      const before = api.getCurrentSessionFile();
      const fillBefore = api.getTestEventLog().lastFillPrompt;
      const noticesBefore = api.getTestEventLog().notices.length;
      await api.forkSession("fork-msg-0");
      await waitFor(
        () => api.getTestEventLog().notices.length > noticesBefore,
        10000,
        "fork 取消 notice",
      );
      const latest = api.getTestEventLog().notices[api.getTestEventLog().notices.length - 1];
      assert.strictEqual(latest.level, "info");
      assert.strictEqual(latest.text, "Fork cancelled");
      assert.strictEqual(api.getCurrentSessionFile(), before, "取消后会话文件不变");
      assert.strictEqual(api.getTestEventLog().lastFillPrompt, fillBefore, "取消不回填输入框");
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        20000,
        "pi 进程启动（恢复默认场景）",
      );
    });

    test("CLONE-FAIL：error notice + 会话文件不变", async function () {
      this.timeout(60000);
      process.env.PINEL_FAKE_PI_SCENARIO = "CLONE-FAIL";
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        20000,
        "pi 进程启动（CLONE-FAIL）",
      );
      const before = api.getCurrentSessionFile();
      const noticesBefore = api.getTestEventLog().notices.length;
      await api.cloneSession();
      await waitFor(
        () => api.getTestEventLog().notices.length > noticesBefore,
        10000,
        "clone 失败 notice",
      );
      const latest = api.getTestEventLog().notices[api.getTestEventLog().notices.length - 1];
      assert.strictEqual(latest.level, "error");
      assert.ok(latest.text.startsWith("Clone failed"), `notice 文案: ${latest.text}`);
      assert.strictEqual(api.getCurrentSessionFile(), before, "失败后会话文件不变");
      delete process.env.PINEL_FAKE_PI_SCENARIO;
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        20000,
        "pi 进程启动（恢复默认场景）",
      );
    });

    test("空会话/无效 entryId：error notice + 状态不变", async function () {
      this.timeout(60000);
      // 新建会话清空消息：get_fork_messages 为空、fork 无效 entryId
      await api.newSession();
      const before = api.getCurrentSessionFile();
      const noticesBefore = api.getTestEventLog().notices.length;
      await api.forkSession("fork-msg-999");
      await waitFor(
        () => api.getTestEventLog().notices.length > noticesBefore,
        10000,
        "无效 entryId notice",
      );
      const latest = api.getTestEventLog().notices[api.getTestEventLog().notices.length - 1];
      assert.strictEqual(latest.level, "error");
      assert.ok(latest.text.startsWith("Fork failed"), `notice 文案: ${latest.text}`);
      assert.strictEqual(api.getCurrentSessionFile(), before, "失败后会话文件不变");
      // 恢复：回到 fork 前的会话（newSession 后消息为空，需重新产生）
      await api.restart();
      await waitFor(
        () => api.getStatus().processState === "running" && api.getStatus().model !== null,
        20000,
        "pi 进程启动（恢复）",
      );
      // 供后续 suite 使用：重新产生一条 user 消息（防残留空会话影响断言）
      await sendAndSettle("分支测试回填");
    });

    test("流式中 fork：prepareForSessionChange 正常 abort 后执行", async function () {
      this.timeout(60000);
      const before = api.getCurrentSessionFile();
      // ABORTME：慢速流（每事件 400ms），不等待 settle 直接 fork
      const baseline = api.getSettledCount();
      void api.sendPrompt("ABORTME 流式中 fork");
      await new Promise((resolve) => setTimeout(resolve, 300)); // 确保流已开始
      assert.ok(api.getStatus().isStreaming, "流已开始");
      await api.forkSession("fork-msg-0");
      await waitFor(() => api.getCurrentSessionFile() !== before, 15000, "流式中 fork 成功");
      assert.ok(api.getStatus().isStreaming === false, "abort 后流停止");
    });
  });

  // ---------------------------------------------------------------------------
  // 会话信息条（get_session_stats 开关 + 统计广播）
  // ---------------------------------------------------------------------------

  suite("会话信息条（get_session_stats）", () => {
    suiteSetup(async function () {
      this.timeout(120000);
      // 初始清理：配置默认关（防跨 run 污染，本 suite 结束时也会还原）
      await vscode.workspace.getConfiguration("pinel").update("showSessionStats", false, vscode.ConfigurationTarget.Global);
    });

    suiteTeardown(async () => {
      await vscode.workspace.getConfiguration("pinel").update("showSessionStats", false, vscode.ConfigurationTarget.Global);
    });

    test("开关开启：status 同步 + 首拉统计广播（全量字段）", async function () {
      this.timeout(60000);
      await api.setShowSessionStats(true);
      await waitFor(
        () => api.getStatus().showSessionStats === true,
        5000,
        "开关状态同步到 status",
      );
      await waitFor(
        () => api.getTestEventLog().lastSessionStats?.stats !== null && api.getTestEventLog().lastSessionStats?.stats !== undefined,
        15000,
        "首拉 sessionStats 广播",
      );
      const stats = api.getTestEventLog().lastSessionStats!.stats;
      assert.ok(stats, "stats 非 null（首拉成功）");
      // 相对断言（fake-pi 进程内消息/会话状态跨 suite 累积，绝对值不可预测）：
      // 统计归属当前会话、tokens 五项为数字、cost 数字、contextUsage 结构完整
      assert.strictEqual(stats.sessionFile, api.getCurrentSessionFile(), "统计归属当前会话");
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
        assert.ok(typeof stats.tokens[key] === "number" && stats.tokens[key] >= 0, `tokens.${key} 为数字`);
      }
      assert.ok(typeof stats.cost === "number" && stats.cost > 0, "cost 存在且大于 0");
      assert.ok(stats.contextUsage, "contextUsage 存在");
      assert.ok(typeof stats.contextUsage!.tokens === "number", "contextUsage.tokens 为数字");
      assert.ok(typeof stats.contextUsage!.percent === "number", "contextUsage.percent 为数字");
    });

    test("环境段广播：folderName + 富化 git 状态字段", async function () {
      this.timeout(60000);
      await api.setShowSessionStats(true);
      await waitFor(
        () => api.getTestEventLog().lastSessionEnv?.env !== undefined,
        15000,
        "首拉 sessionEnv 广播",
      );
      const env = api.getTestEventLog().lastSessionEnv!.env;
      // folderName = 工作区根目录名（controller 用 path.basename 计算；不硬编码仓库名——
      // 仓库迁移/改名（pinel → vscode/pi 拆分）会破坏硬编码断言）
      const expectedFolder = path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");
      assert.ok(expectedFolder.length > 0, "测试工作区根目录名非空");
      assert.strictEqual(env.folderName, expectedFolder, "folderName = 工作区文件夹名");
      assert.ok(env.git, "git 非 null（仓库内）");
      const git = env.git!;
      assert.ok(typeof git.branch === "string" && git.branch.length > 0, "branch 非空");
      assert.ok(typeof git.ahead === "number" && git.ahead >= 0, "ahead 为数字");
      assert.ok(typeof git.behind === "number" && git.behind >= 0, "behind 为数字");
      assert.ok(typeof git.trackedChanges === "boolean", "trackedChanges 为布尔");
      assert.ok(typeof git.untracked === "boolean", "untracked 为布尔");
    });

    test("settle 后刷新：新回合结束统计更新", async function () {
      this.timeout(60000);
      assert.strictEqual(api.getStatus().showSessionStats, true);
      const before = api.getTestEventLog().lastSessionStats?.stats;
      assert.ok(before, "首拉已有 stats");
      const beforeInput = before!.tokens.input;
      const marker = `STATS-SETTLE-${Date.now()}`;
      const baseline = api.getSettledCount();
      await api.sendPrompt(marker);
      await api.waitForSettled(30000, baseline);
      // settle 钩子触发 refreshSessionStats → 消息数增长 → token 变大
      await waitFor(
        () => (api.getTestEventLog().lastSessionStats?.stats?.tokens.input ?? 0) > beforeInput,
        15000,
        "settle 后统计刷新",
      );
    });

    test("切换会话后：统计归属新会话（sessionFile 更新 + 数值变化）", async function () {
      this.timeout(60000);
      const target = "/fake/switch-stats-target.jsonl";
      await api.switchSession(target);
      await waitFor(() => api.getCurrentSessionFile() === target, 15000, "切换完成");
      // 切换钩子：先 fire null 占位再拉取覆盖 → 最终归属新会话（base=500 < 默认 1000）
      await waitFor(
        () => api.getTestEventLog().lastSessionStats?.stats?.sessionFile === target,
        15000,
        "统计归属新会话",
      );
      const stats = api.getTestEventLog().lastSessionStats?.stats;
      assert.ok(stats, "切换后已有 stats");
      assert.ok(stats.tokens.input < 1000, "切换后 base 变化（新会话统计生效）");
    });

    test("STATS-FAIL 场景：无旧值不 fire + 不弹 notice", async function () {
      this.timeout(60000);
      process.env.PINEL_FAKE_PI_SCENARIO = "STATS-FAIL";
      try {
        await api.restart();
        await waitFor(() => api.getStatus().processState === "running", 30000, "STATS-FAIL 启动");
        // restart 清空 stats；开关由 start 回读配置保持开启；记下 restart 后的广播状态
        const marker = `STATS-FAIL-${Date.now()}`;
        const baseline = api.getSettledCount();
        await api.sendPrompt(marker);
        await api.waitForSettled(30000, baseline);
        // settle 触发拉取 → 失败 → 无旧值 → 不 fire（等待观察窗口后断言无更新）
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.ok(
          !api.getTestEventLog().notices.some((n) => n.text.includes("获取会话统计失败")),
          "失败静默：不弹 notice",
        );
        // 无旧值：不 fire——lastSessionStats 保持重启前值（sessionFile 仍是切换目标）
        const stats = api.getTestEventLog().lastSessionStats?.stats;
        assert.ok(stats, "重启前存在统计");
        assert.strictEqual(stats.sessionFile, "/fake/switch-stats-target.jsonl", "无新广播（保留重启前值）");
      } finally {
        delete process.env.PINEL_FAKE_PI_SCENARIO;
        await api.restart();
        await waitFor(() => api.getStatus().processState === "running", 30000, "恢复默认场景");
      }
    });

    test("STATS-NOCONTEXT 场景：contextUsage 缺省（显示层占位）", async function () {
      this.timeout(60000);
      process.env.PINEL_FAKE_PI_SCENARIO = "STATS-NOCONTEXT";
      try {
        await api.restart();
        await waitFor(() => api.getStatus().processState === "running", 30000, "STATS-NOCONTEXT 启动");
        const marker = `STATS-NOCONTEXT-${Date.now()}`;
        const baseline = api.getSettledCount();
        await api.sendPrompt(marker);
        await api.waitForSettled(30000, baseline);
        await waitFor(
          () => api.getTestEventLog().lastSessionStats?.stats?.contextUsage === undefined,
          15000,
          "contextUsage 缺省广播",
        );
      } finally {
        delete process.env.PINEL_FAKE_PI_SCENARIO;
        await api.restart();
        await waitFor(() => api.getStatus().processState === "running", 30000, "恢复默认场景");
      }
    });

    test("开关持久化：restart 后配置保留且 start 回读恢复", async function () {
      this.timeout(60000);
      // 确保开关为开（前序测试可能已置）
      await api.setShowSessionStats(true);
      const configValue = vscode.workspace.getConfiguration("pinel").get<boolean>("showSessionStats");
      assert.strictEqual(configValue, true, "配置已持久化");
      await api.restart();
      await waitFor(() => api.getStatus().processState === "running", 30000, "重启完成");
      // start 回读配置 → restart 重置 status 后开关恢复（防静默复位）
      assert.strictEqual(api.getStatus().showSessionStats, true, "重启后开关保持");
      // 且首拉统计恢复（start 首拉：running 后拉取）
      await waitFor(
        () => api.getTestEventLog().lastSessionStats?.stats?.sessionFile === "/fake/session.jsonl",
        15000,
        "重启后统计恢复（默认会话）",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // @ 添加文件（fileList 扫描 / sendPrompt fileRefs 拼装）
  // ---------------------------------------------------------------------------

  suite("@ 添加文件（工作区扫描与发送拼装）", () => {
    let fixtureDir: string;

    suiteSetup(async function () {
      this.timeout(120000);
      // workspace 根内唯一名 fixture 目录（主套件不可切换工作区——评审 M3；
      // 结束删除；gitignore 过滤另由仓库根既有规则覆盖）
      fixtureDir = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", `__pinel_at_fixture_${Date.now()}`);
      await fs.promises.mkdir(fixtureDir, { recursive: true });
      await fs.promises.writeFile(path.join(fixtureDir, "note.txt"), "这是测试文件内容\n第二行\n");
      await fs.promises.writeFile(path.join(fixtureDir, "img.png"), "fake-png-bytes");
    });

    suiteTeardown(async () => {
      await fs.promises.rm(fixtureDir, { recursive: true, force: true });
    });

    test("getFileList：工作区扫描（含 fixture 文件；仓库根 gitignore 规则生效）", async function () {
      this.timeout(60000);
      const { items } = await api.getFileList();
      const note = items.find((i) => i.path.startsWith("__pinel_at_fixture_") && i.path.endsWith("note.txt"));
      assert.ok(note, "fixture 文本文件必须在列表中");
      assert.strictEqual(note.isImage, false, "txt 非图片");
      const img = items.find((i) => i.path.endsWith("img.png"));
      assert.ok(img && img.isImage, "png 图片判定");
      // 仓库根 gitignore 规则（dist/ out/ 等）必须生效
      assert.ok(!items.some((i) => i.path.startsWith("dist/")), "仓库根 gitignore 的 dist/ 过滤生效");
      assert.ok(!items.some((i) => i.path.startsWith("node_modules/")), "node_modules 硬编码跳过");
    });

    test("sendPrompt 带 fileRefs：文本 <file name> 注入 + 图片附件送达 fake-pi", async function () {
      this.timeout(60000);
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const relNote = path.relative(root, path.join(fixtureDir, "note.txt")).replace(/\\/g, "/");
      const relImg = path.relative(root, path.join(fixtureDir, "img.png")).replace(/\\/g, "/");
      const marker = `ATFILE-${Date.now()}`;
      const baseline = api.getSettledCount();
      await api.sendPrompt(`${marker} 看看这两个文件`, [relNote, relImg]);
      await api.waitForSettled(30000, baseline);

      // fake-pi 入站 prompt 记录：文本含 <file name> 注入内容、images 含图片附件
      const records = readFakePiLog(logPath);
      const after = recordsAfterPrompt(records, marker);
      const promptRecs = logRecordsWith(after, "in", "prompt");
      assert.ok(promptRecs.length >= 1, "prompt 入站记录必须存在");
      // 日志行结构：{ t, record: { dir, record: 请求 } }
      const rec = (promptRecs[promptRecs.length - 1] as { record?: { record?: { message?: unknown; images?: unknown[] } } })
        ?.record?.record;
      const msg = String(rec?.message ?? "");
      assert.ok(msg.includes(`<file name=`), "prompt 必须含 <file name> 注入");
      assert.ok(msg.includes("这是测试文件内容"), "文本文件内容必须注入");
      assert.ok(Array.isArray(rec?.images) && rec.images.length >= 1, "图片附件必须送达");
      assert.strictEqual(
        (rec?.images?.[0] as { mimeType?: string })?.mimeType,
        "image/png",
        "图片 mimeType 正确",
      );
      // 注：settle 后用户消息为权威列表（含 <file> markup）——显示层剥离由
      // MessageView 处理（webview 逻辑，宿主不可断言，F5 覆盖）
    });

    test("/new 带 fileRefs 时原样发送（不拦截）", async function () {
      this.timeout(60000);
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const relNote = path.relative(root, path.join(fixtureDir, "note.txt")).replace(/\\/g, "/");
      const before = api.getCurrentSessionFile();
      const baseline = api.getSettledCount();
      await api.sendPrompt("/new", [relNote]);
      await api.waitForSettled(30000, baseline);
      // prompt 送达且以 /new 开头（attachFileRefs 在文本后追加 <file> 内容）
      const records = readFakePiLog(logPath);
      const promptRecs = logRecordsWith(records, "in", "prompt");
      const rec = (promptRecs[promptRecs.length - 1] as { record?: { record?: { message?: unknown } } })
        ?.record?.record;
      const msg = String(rec?.message ?? "");
      assert.ok(msg.startsWith("/new"), "带 fileRefs 的 /new 必须原样送达");
      assert.ok(msg.includes("<file name="), "fileRefs 注入必须保留");
      assert.strictEqual(api.getCurrentSessionFile(), before, "带 fileRefs 不得触发新建");
    });
  });

  suite("提示词编辑器（Ctrl+G 编辑/回填/清理）", () => {
    /** 指定路径的临时文件标签页是否打开。 */
    function pendingTabOpen(pendingPath: string): boolean {
      return vscode.window.tabGroups.all.some((g) =>
        g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === pendingPath),
      );
    }

    /** 关闭指定路径的临时文件标签页（干净 tab，避免 dirty 关闭弹保存确认）。 */
    async function closeTabFor(pendingPath: string): Promise<void> {
      for (const group of vscode.window.tabGroups.all) {
        const tab = group.tabs.find(
          (t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === pendingPath,
        );
        if (tab) {
          await vscode.window.tabGroups.close(tab);
          return;
        }
      }
      assert.fail(`标签页不存在: ${pendingPath}`);
    }

    test("编辑→保存→回填→发送→关闭清理 全链路", async function () {
      this.timeout(60000);
      // 编辑：打开编辑器并带入初始内容
      await api.editPrompt("初始提示词");
      const pendingPath = api.getPendingPromptUriPath();
      assert.ok(pendingPath, "临时文件路径必须存在");
      assert.ok(fs.existsSync(pendingPath), "临时文件必须已创建");
      assert.ok(pendingTabOpen(pendingPath), "编辑器标签页必须打开");
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor && editor.document.uri.fsPath === pendingPath, "编辑器必须激活且指向临时文件");
      assert.strictEqual(editor.document.getText(), "初始提示词", "初始内容必须带入");

      // 编辑并保存 → 保存事件回填广播
      await editor.edit((eb) => {
        const doc = editor.document;
        eb.replace(
          new vscode.Range(new vscode.Position(0, 0), doc.positionAt(doc.getText().length)),
          "编辑后的提示词\n第二行",
        );
      });
      await vscode.commands.executeCommand("workbench.action.files.save");
      await waitFor(
        () => api.getTestEventLog().lastFillPrompt === "编辑后的提示词\n第二行",
        10000,
        "保存后回填广播",
      );

      // 发送 → 关闭编辑器标签页 + 删除临时文件（disposeForSend 为异步 fire-and-forget，
      // pendingUri 同步清空，文件/tab 清理需轮询等待）
      await api.sendPrompt("编辑后的提示词\n第二行");
      await waitFor(() => api.getPendingPromptUriPath() === undefined, 10000, "发送后清理 pending");
      await waitFor(() => !fs.existsSync(pendingPath), 10000, "临时文件删除");
      await waitFor(() => !pendingTabOpen(pendingPath), 10000, "编辑器标签页关闭");
    });

    test("手动关闭标签页：清理文件但不触发回填", async function () {
      this.timeout(60000);
      await api.editPrompt("草稿内容");
      const pendingPath = api.getPendingPromptUriPath();
      assert.ok(pendingPath && fs.existsSync(pendingPath), "临时文件必须存在");
      const before = api.getTestEventLog().lastFillPrompt;

      await closeTabFor(pendingPath);
      await waitFor(() => api.getPendingPromptUriPath() === undefined, 10000, "关闭后清理 pending");
      // 文件删除为异步 fire-and-forget（与上方 disposeForSend 同路径），须轮询而非裸断言（镜像 L2506 兄弟测试）
      await waitFor(() => !fs.existsSync(pendingPath), 10000, "临时文件删除");
      assert.strictEqual(api.getTestEventLog().lastFillPrompt, before, "未保存不得回填（广播不变）");
    });

    test("重复 Ctrl+G：关闭旧编辑器并新建（旧文件清理）", async function () {
      this.timeout(60000);
      await api.editPrompt("第一版");
      const firstPath = api.getPendingPromptUriPath();
      assert.ok(firstPath, "第一次临时文件必须存在");

      await api.editPrompt("第二版");
      const secondPath = api.getPendingPromptUriPath();
      assert.ok(secondPath && secondPath !== firstPath, "第二次必须新建临时文件");
      assert.ok(!fs.existsSync(firstPath), "旧临时文件必须删除");
      assert.ok(!pendingTabOpen(firstPath), "旧编辑器标签页必须关闭");
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor && editor.document.uri.fsPath === secondPath, "新编辑器必须激活");
      assert.strictEqual(editor.document.getText(), "第二版", "新内容必须带入");

      // 收尾：手动关闭新标签页，保持 pending 干净（后续测试无残留）
      await closeTabFor(secondPath);
      await waitFor(() => api.getPendingPromptUriPath() === undefined, 10000, "收尾清理");
    });
  });

  // -------------------------------------------------------------------------
  // 扩展管理（本地扩展 + settings.json packages；纯文件操作不依赖 pi 进程）
  // -------------------------------------------------------------------------

  suite("扩展管理（本地扩展 + packages）", () => {
    let agentDir: string;

    suiteSetup(async () => {
      agentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinel-agent-dir-"));
      await fs.promises.mkdir(path.join(agentDir, "extensions"), { recursive: true });
      process.env.PI_CODING_AGENT_DIR = agentDir;
    });

    suiteTeardown(async () => {
      delete process.env.PI_CODING_AGENT_DIR;
      await fs.promises.rm(agentDir, { recursive: true, force: true });
    });

    test("getCatalogState：20 项目录 + 安装态按 packages identity 命中", async function () {
      this.timeout(30000);
      await fs.promises.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          packages: ["npm:@juicesharp/rpiv-todo", "npm:other"],
        }),
      );
      const entries = await api.getCatalogState();
      assert.strictEqual(entries.length, 20);
      const groups = { "pi-packages": 0, "rpiv-mono": 0 };
      for (const e of entries) {
        assert.ok(e.installSpec.startsWith("npm:@"), e.installSpec);
        assert.ok(["ok", "limited", "tui-only"].includes(e.compat));
        assert.ok(["installed", "available"].includes(e.state));
        groups[e.group] += 1;
      }
      assert.deepStrictEqual(groups, { "pi-packages": 9, "rpiv-mono": 11 });
      const byId = new Map(entries.map((e) => [e.id, e]));
      assert.strictEqual(byId.get("rpiv-todo")?.state, "installed"); // 字符串条目命中
      assert.strictEqual(byId.get("rpiv-btw")?.state, "available");
      assert.strictEqual(byId.get("rpiv-voice")?.compat, "tui-only");
      assert.strictEqual(byId.get("rpiv-voice")?.defaultSet, true);
      assert.strictEqual(byId.get("rpiv-btw")?.defaultSet, undefined);
    });

    test("getExtensionList：本地扩展 + packages 合并（enabled/filtered/scope 判定）", async function () {
      this.timeout(30000);
      await fs.promises.writeFile(path.join(agentDir, "extensions", "foo.ts"), "export default () => {}");
      await fs.promises.writeFile(path.join(agentDir, "extensions", "off.ts.disabled"), "export default () => {}");
      await fs.promises.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          packages: [
            "npm:a",
            { source: "npm:b", extensions: [], skills: [], prompts: [], themes: [] },
            { source: "npm:c", extensions: [] },
          ],
        }),
      );
      const items = await api.getExtensionList();
      const byName = new Map(items.map((i) => [i.name, i]));
      assert.strictEqual(byName.get("foo")?.kind, "local");
      assert.strictEqual(byName.get("foo")?.enabled, true);
      assert.strictEqual(byName.get("off")?.enabled, false);
      assert.strictEqual(byName.get("a")?.kind, "package");
      assert.strictEqual(byName.get("a")?.enabled, true);
      assert.strictEqual(byName.get("b")?.enabled, false);
      assert.strictEqual(byName.get("c")?.enabled, true);
      assert.strictEqual(byName.get("c")?.filtered, true);
      for (const i of items) {
        assert.strictEqual(i.scope, "global");
      }
    });

    test("setExtensionEnabled：本地重命名往返 + 包 settings 编辑往返", async function () {
      this.timeout(30000);
      const foo = path.join(agentDir, "extensions", "foo.ts");
      // 本地禁用 → 启用
      await api.setExtensionEnabled(foo, "local", "global", false);
      assert.ok(!fs.existsSync(foo), "foo.ts 应被重命名");
      assert.ok(fs.existsSync(`${foo}.disabled`), "foo.ts.disabled 应存在");
      await api.setExtensionEnabled(foo, "local", "global", true);
      assert.ok(fs.existsSync(foo), "foo.ts 应恢复");

      // 包禁用 → 启用（settings.json round-trip，保留其他键）
      const settingsPath = path.join(agentDir, "settings.json");
      await api.setExtensionEnabled("npm:a", "package", "global", false);
      let parsed = JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
      assert.deepStrictEqual(parsed.packages[0], {
        source: "npm:a",
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      });
      await api.setExtensionEnabled("npm:a", "package", "global", true);
      parsed = JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
      assert.deepStrictEqual(parsed.packages[0], "npm:a");
    });

    test("uninstallExtension：本地删除 + 本地路径包 settings 条目移除", async function () {
      this.timeout(30000);
      // 本地删除（foo.ts 已在上一测试恢复启用）
      const foo = path.join(agentDir, "extensions", "foo.ts");
      await api.uninstallExtension(foo, "local", "global", foo);
      assert.ok(!fs.existsSync(foo), "本地扩展应被删除");

      // 本地路径包：不触发 pi remove（pi remove 不支持 local source）
      const settingsPath = path.join(agentDir, "settings.json");
      const parsed = JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
      const packages = [...parsed.packages, "./local-ext"];
      await fs.promises.writeFile(settingsPath, JSON.stringify({ ...parsed, packages }));
      await api.uninstallExtension("./local-ext", "package", "global", "./local-ext");
      const after = JSON.parse(await fs.promises.readFile(settingsPath, "utf8"));
      assert.ok(!after.packages.includes("./local-ext"), "本地路径包应从 settings 移除");
    });

    test("卸载确认 seam + reload 提示 seam：拒绝/接受两条路径", async function () {
      this.timeout(30000);
      const warnOrig = vscode.window.showWarningMessage;
      const infoOrig = vscode.window.showInformationMessage;
      try {
        vscode.window.showWarningMessage = (async () => undefined) as typeof vscode.window.showWarningMessage;
        assert.strictEqual(await confirmExtensionUninstall("x"), false);
        vscode.window.showWarningMessage = (async () => "Uninstall") as typeof vscode.window.showWarningMessage;
        assert.strictEqual(await confirmExtensionUninstall("x"), true);

        vscode.window.showInformationMessage = (async () => undefined) as typeof vscode.window.showInformationMessage;
        assert.strictEqual(await confirmExtensionReload(), false);
        vscode.window.showInformationMessage = (async () => "Reload") as typeof vscode.window.showInformationMessage;
        assert.strictEqual(await confirmExtensionReload(), true);
      } finally {
        vscode.window.showWarningMessage = warnOrig;
        vscode.window.showInformationMessage = infoOrig;
      }
    });

    test("getExtensionList 视图合成：project 继承行 / global 过滤 / all 包去重", async function () {
      this.timeout(30000);
      const projectSettings = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, ".pi", "settings.json");
      if (fs.existsSync(projectSettings)) {
        this.skip(); // 仓库 .pi/settings.json 已存在（非测试场景），避免污染真实配置
      }
      // 全局：本地扩展 foo + 包 npm:a / npm:shared（重建干净目录，前序测试有残留）
      await fs.promises.rm(path.join(agentDir, "extensions"), { recursive: true, force: true });
      await fs.promises.mkdir(path.join(agentDir, "extensions"), { recursive: true });
      await fs.promises.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: ["npm:a", "npm:shared"] }),
      );
      await fs.promises.writeFile(path.join(agentDir, "extensions", "foo.ts"), "export default () => {}");
      // 项目：project-only + 覆盖 shared（禁用）
      await fs.promises.mkdir(path.dirname(projectSettings), { recursive: true });
      await fs.promises.writeFile(
        projectSettings,
        JSON.stringify({
          packages: [
            "npm:project-only",
            { source: "npm:shared", extensions: [], skills: [], prompts: [], themes: [] },
          ],
        }),
      );
      try {
        // project：项目条目 + 继承全局包（inherited，scope 重写 project）；全局本地扩展不列出
        const proj = await api.getExtensionList("project");
        const byName = new Map(proj.map((i) => [i.name, i]));
        assert.strictEqual(proj.length, 3, `project 视图应含 3 条，实际 ${JSON.stringify(proj.map((i) => i.name))}`);
        assert.strictEqual(byName.get("project-only")?.scope, "project");
        assert.strictEqual(byName.get("project-only")?.inherited, undefined);
        assert.strictEqual(byName.get("shared")?.scope, "project");
        assert.strictEqual(byName.get("shared")?.inherited, undefined);
        assert.strictEqual(byName.get("shared")?.enabled, false);
        assert.strictEqual(byName.get("a")?.scope, "project", "继承行 scope 应重写为 project");
        assert.strictEqual(byName.get("a")?.inherited, true);
        assert.strictEqual(byName.get("a")?.enabled, true);
        assert.ok(!byName.has("foo"), "全局本地扩展不应出现在 project 视图");

        // global：仅全局条目，无 inherited
        const glob = await api.getExtensionList("global");
        const gNames = new Map(glob.map((i) => [i.name, i]));
        assert.strictEqual(glob.length, 3);
        assert.ok(gNames.has("foo") && gNames.has("a") && gNames.has("shared"));
        for (const i of glob) {
          assert.strictEqual(i.scope, "global");
          assert.strictEqual(i.inherited, undefined);
        }

        // all：包按 identity 去重（project 优先）；本地不去重
        const all = await api.getExtensionList("all");
        const aNames = new Map(all.map((i) => [i.name, i]));
        assert.strictEqual(all.length, 4);
        assert.strictEqual(aNames.get("foo")?.kind, "local");
        assert.strictEqual(aNames.get("a")?.scope, "global");
        assert.strictEqual(aNames.get("shared")?.scope, "project", "同包 project 优先");
        assert.strictEqual(aNames.get("project-only")?.scope, "project");
      } finally {
        await fs.promises.rm(projectSettings, { force: true }); // 测试前不存在 → 删除还原
      }
    });

    test("setExtensionEnabled 项目覆盖：inherited 包 upsert 写 .pi/settings.json", async function () {
      this.timeout(30000);
      const projectSettings = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, ".pi", "settings.json");
      if (fs.existsSync(projectSettings)) {
        this.skip(); // 仓库 .pi/settings.json 已存在（非测试场景），避免污染真实配置
      }
      await fs.promises.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:a"] }));
      try {
        // 项目级禁用全局包（upsert append 对象空数组）
        await api.setExtensionEnabled("npm:a", "package", "project", false);
        let parsed = JSON.parse(await fs.promises.readFile(projectSettings, "utf8"));
        assert.deepStrictEqual(parsed.packages, [
          { source: "npm:a", extensions: [], skills: [], prompts: [], themes: [] },
        ]);
        // 项目级启用（恢复字符串，不产生重复条目）
        await api.setExtensionEnabled("npm:a", "package", "project", true);
        parsed = JSON.parse(await fs.promises.readFile(projectSettings, "utf8"));
        assert.deepStrictEqual(parsed.packages, ["npm:a"]);
        // project 视图：a 为项目条目（非继承行）
        const proj = await api.getExtensionList("project");
        assert.strictEqual(proj.length, 1);
        assert.strictEqual(proj[0].name, "a");
        assert.strictEqual(proj[0].scope, "project");
        assert.strictEqual(proj[0].inherited, undefined);
      } finally {
        await fs.promises.rm(projectSettings, { force: true }); // 测试前不存在 → 删除还原
      }
    });
  });

  suite("subagent 卡片（工具事件解析）", () => {
    test("SUBAGENTME：start/update/end 三事件合并 → 专属字段与输出", async function () {
      this.timeout(60000);
      // 前序套件可能残留流式态：未 settle 时 sendPrompt 会变 steer，fake-pi 场景不分派
      await waitFor(() => !api.getStatus().isStreaming, 30000, "前序流结束");
      const marker = `SUBAGENTME-${Date.now()}`;
      const baseline = api.getSettledCount();
      await api.sendPrompt(marker);
      await api.waitForSettled(30000, baseline);
      await waitFor(() => api.getTools().get("sub_1")?.subagent !== undefined, 10000, "subagent 卡片字段送达");
      const card = api.getTools().get("sub_1")!;
      const sub = card.subagent!;
      assert.strictEqual(sub.description, "Exploring auth flow");
      assert.strictEqual(sub.subagentType, "Explore");
      assert.strictEqual(sub.model, "haiku");
      assert.strictEqual(sub.thinking, "high");
      assert.strictEqual(sub.status, "completed");
      assert.strictEqual(sub.turnCount, 5);
      assert.strictEqual(sub.toolUses, 3);
      assert.strictEqual(sub.tokens, "12.3k");
      assert.strictEqual(sub.durationMs, 4200);
      // end 的 activity "" 清空运行中活动行
      assert.strictEqual(sub.activity, null);
      assert.strictEqual(card.status, "done");
      assert.ok(card.output.includes("## Findings"), "输出必须含 markdown 报告");
    });

    test("SUBAGENTBAD：details 字段全错 → 字段级降级，输出仍可达", async function () {
      this.timeout(60000);
      await waitFor(() => !api.getStatus().isStreaming, 30000, "前序流结束");
      const marker = `SUBAGENTBAD-${Date.now()}`;
      const baseline = api.getSettledCount();
      await api.sendPrompt(marker);
      await api.waitForSettled(30000, baseline);
      await waitFor(() => api.getTools().get("sub_bad")?.subagent !== undefined, 10000, "降级卡片送达");
      const card = api.getTools().get("sub_bad")!;
      const sub = card.subagent!;
      assert.strictEqual(sub.description, "Degrade case");
      assert.strictEqual(sub.model, null);
      assert.strictEqual(sub.thinking, null);
      assert.strictEqual(sub.turnCount, null);
      // details 状态不可解析 → end 兑底 completed（防 spinner 永转）
      assert.strictEqual(sub.status, "completed");
      assert.strictEqual(card.output, "partial output");
    });
  });

  // -------------------------------------------------------------------------
  // 自动压缩阈值（百分比 → 全局 settings.json compaction.reserveTokens）
  // -------------------------------------------------------------------------

  suite("自动压缩阈值", () => {
    let agentDir: string;

    suiteSetup(async () => {
      // 隔离：防写真实 ~/.pi/agent/settings.json（对齐扩展管理套件模式）
      agentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinel-threshold-"));
      process.env.PI_CODING_AGENT_DIR = agentDir;
    });

    suiteTeardown(async () => {
      delete process.env.PI_CODING_AGENT_DIR;
      await fs.promises.rm(agentDir, { recursive: true, force: true });
    });

    test("setCompactionThreshold：换算写 settings.json + 回显 + notice", async function () {
      this.timeout(30000);
      await api.setCompactionThreshold(80);

      // fake-pi get_session_stats contextWindow=200000 → 80% → 预留 40000
      const settings = JSON.parse(await fs.promises.readFile(path.join(agentDir, "settings.json"), "utf8"));
      assert.strictEqual(settings.compaction.reserveTokens, 40000, "80% × 200000 窗口 → 预留 40000");
      assert.strictEqual(api.getStatus().autoCompactPercent, 80, "status 回显百分比");
      await waitFor(
        () => api.getTestEventLog().notices.some((n) => n.text.includes("threshold set to 80%")),
        10000,
        "阈值保存 notice",
      );
    });

    test("非法百分比：error notice 且不写 settings.json", async function () {
      this.timeout(30000);
      // 自包含：先写哨兵内容，断言非法调用后内容不变（不依赖套件内测试顺序）
      const p = path.join(agentDir, "settings.json");
      await fs.promises.writeFile(p, JSON.stringify({ sentinel: true }));
      await api.setCompactionThreshold(150);
      await waitFor(
        () =>
          api.getTestEventLog().notices.some(
            (n) => n.level === "error" && n.text.includes("Invalid compaction threshold"),
          ),
        10000,
        "非法阈值 error notice",
      );
      const content = JSON.parse(await fs.promises.readFile(p, "utf8"));
      assert.deepStrictEqual(content, { sentinel: true }, "非法值不得写 settings");
    });

    test("已有 settings 合并写：compaction 其他键与 packages 保留", async function () {
      this.timeout(30000);
      await fs.promises.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: ["npm:a"], compaction: { enabled: true, reserveTokens: 16384 } }),
      );
      await api.setCompactionThreshold(90);
      const settings = JSON.parse(await fs.promises.readFile(path.join(agentDir, "settings.json"), "utf8"));
      assert.strictEqual(settings.compaction.reserveTokens, 20000, "90% × 200000 → 预留 20000");
      assert.strictEqual(settings.compaction.enabled, true, "compaction 其他键保留");
      assert.deepStrictEqual(settings.packages, ["npm:a"], "packages 键保留");
    });
  });

  // 自动提交开关（写全局 settings.json pinel.autoCommit；pi 侧 auto-commit 扩展按轮注入提示词）
  // -------------------------------------------------------------------------

  suite("自动提交开关", () => {
    let agentDir: string;

    suiteSetup(async () => {
      // 隔离：防写真实 ~/.pi/agent/settings.json（对齐扩展管理套件模式）
      agentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinel-autocommit-"));
      process.env.PI_CODING_AGENT_DIR = agentDir;
    });

    suiteTeardown(async () => {
      delete process.env.PI_CODING_AGENT_DIR;
      await fs.promises.rm(agentDir, { recursive: true, force: true });
    });

    test("setAutoCommit(true)：写 settings.json + status 回显 + notice", async function () {
      this.timeout(30000);
      await api.setAutoCommit(true);

      const settings = JSON.parse(await fs.promises.readFile(path.join(agentDir, "settings.json"), "utf8"));
      assert.strictEqual(settings.pinel.autoCommit, true, "settings.json 必须写入 pinel.autoCommit=true");
      assert.strictEqual(api.getStatus().autoCommitEnabled, true, "status 回显开启");
      await waitFor(
        () => api.getTestEventLog().notices.some((n) => n.text === "Auto commit enabled"),
        10000,
        "开启 notice",
      );
    });

    test("setAutoCommit(false) + 合并写：其余键保留", async function () {
      this.timeout(30000);
      await fs.promises.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ packages: ["npm:a"], compaction: { reserveTokens: 16384 }, pinel: { other: 1 } }),
      );
      await api.setAutoCommit(false);
      const settings = JSON.parse(await fs.promises.readFile(path.join(agentDir, "settings.json"), "utf8"));
      assert.strictEqual(settings.pinel.autoCommit, false, "pinel.autoCommit=false 写入");
      assert.strictEqual(settings.pinel.other, 1, "pinel 其他键保留");
      assert.deepStrictEqual(settings.packages, ["npm:a"], "packages 键保留");
      assert.strictEqual(settings.compaction.reserveTokens, 16384, "compaction 键保留");
      assert.strictEqual(api.getStatus().autoCommitEnabled, false, "status 回显关闭");
    });

    test("损坏 settings.json：error notice 且不覆盖", async function () {
      this.timeout(30000);
      const p = path.join(agentDir, "settings.json");
      await fs.promises.writeFile(p, "not-json");
      await api.setAutoCommit(true);
      await waitFor(
        () =>
          api.getTestEventLog().notices.some(
            (n) => n.level === "error" && n.text.includes("Save auto commit setting failed"),
          ),
        10000,
        "损坏 settings error notice",
      );
      assert.strictEqual(await fs.promises.readFile(p, "utf8"), "not-json", "损坏文件不得被覆盖");
    });
  });
});
