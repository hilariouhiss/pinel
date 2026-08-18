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

    // 答题：Q1 选 A、Q2 多选 1/3、Q3 自定义
    api.questionnaireAnswer(0, { kind: "option", optionIndex: 0 });
    api.questionnaireAnswer(1, { kind: "multi", optionIndices: [2, 0] });
    api.questionnaireAnswer(2, { kind: "custom", text: "自定义三" });
    await waitFor(() => api.getQuestionnaire()?.phase === "reviewing", 5000, "全答完转 reviewing");

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

  test("问卷期间通用对话框走逐卡路径（标题门控不误缓冲）", async function () {
    this.timeout(60000);
    const marker = `QUESTIONNAIRE-GENERIC-${Date.now()}`;
    const baseline = api.getSettledCount();
    await api.sendPrompt(marker);
    await waitFor(() => (api.getQuestionnaire()?.questions.length ?? 0) === 3, 10000, "问卷进入");

    // 问卷期间穿插的通用 select（标题不匹配任何题目）→ 逐卡广播
    await waitFor(() => api.getPendingUi().length > 0, 10000, "通用对话框逐卡广播");
    const pending = api.getPendingUi()[0];
    assert.strictEqual(pending.id, "ui-generic-1", "必须广播通用对话框而非缓冲");
    assert.notStrictEqual(api.getQuestionnaire(), null, "问卷保持活动");
    api.uiRespond(pending.id, { value: "1. Yes" });

    // 完成问卷（Q2 多选空选择 → 回空串）
    api.questionnaireAnswer(0, { kind: "option", optionIndex: 0 });
    api.questionnaireAnswer(1, { kind: "multi", optionIndices: [] });
    api.questionnaireAnswer(2, { kind: "option", optionIndex: 0 });
    await waitFor(() => api.getQuestionnaire()?.phase === "reviewing", 5000, "reviewing");
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
        log.notices.some((n) => n.level === "warning" && n.text.includes("获取模型列表失败")),
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
        log.notices.some((n) => n.level === "error" && n.text.includes("切换模型失败")),
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
        log.notices.some((n) => n.level === "warning" && n.text.includes("获取思考强度列表失败")),
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
        log.notices.some((n) => n.level === "error" && n.text.includes("设置思考强度失败")),
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
            .notices.some((n) => n.level === "warning" && n.text.includes("状态回读失败")),
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
          log.notices.some((n) => n.text.includes("切换会话已取消")),
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
      assert.ok(!fs.existsSync(pendingPath), "临时文件必须删除");
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
});
