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
});
