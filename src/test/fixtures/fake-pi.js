/**
 * 假 pi：按 rpc.md 协议实现的确定性 RPC 服务器，供集成测试使用。
 *
 * 行为：
 * - get_state / get_messages / get_available_models 返回固定状态
 * - prompt 触发流式序列：agent_start → message_start → 多 contentIndex 块
 *   （text/thinking 交替 + toolCall）→ tool_execution_* → message_end →
 *   agent_end → agent_settled
 * - prompt 含 "ABORTME"：慢速流（每事件 400ms），收到 abort 后立即收尾
 * - prompt 含 "UIREQUEST"：先发 extension_ui_request（confirm 对话框，无 timeout）
 *   并等待客户端回复（用于验证客户端自动 cancelled 回复）
 * - prompt 含 "TWOMSG"：一个 prompt 产出两条连续助手消息（第一条含 text+thinking，
 *   第二条仅 text 慢速），用于回归测试跨消息 contentIndex 装配重置
 * - 所有收到/发出的记录写入日志文件（PINEL_FAKE_PI_LOG 或系统临时目录）
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOG_PATH = process.env.PINEL_FAKE_PI_LOG || path.join(os.tmpdir(), "pinel-fake-pi.log");

function log(record) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ t: Date.now(), record }) + "\n");
  } catch {
    // 日志失败不影响协议
  }
}

function out(record) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ t: Date.now(), record: { dir: "out", record } }) + "\n");
  } catch {
    // 日志失败不影响协议
  }
  process.stdout.write(JSON.stringify(record) + "\n");
}

let messages = [];

/**
 * 中断代际：每次 abort 自增。流在启动时记录当前代际，每个异步步骤后先检查
 * 代际是否变化再继续发射。
 *
 * （历史坑：早期实现用全局布尔 aborted，且新 prompt 会把它复位——这会让
 * 已被 abort 的旧流的定时器“复活”，其迟到事件污染后续消息的流式装配，
 * 造成间歇性测试失败。）
 */
let abortGeneration = 0;
let streaming = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function respond(id, command, success, data, error) {
  const res = { type: "response", command, success };
  if (id !== undefined) {
    res.id = id;
  }
  if (data !== undefined) {
    res.data = data;
  }
  if (error !== undefined) {
    res.error = error;
  }
  out(res);
}

const MODEL = { id: "fake-model", name: "Fake Model", provider: "fake" };

function stateData() {
  return {
    model: MODEL,
    thinkingLevel: "high",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    sessionFile: "/fake/session.jsonl",
    sessionId: "fake-session",
    messageCount: messages.length,
    pendingMessageCount: 0,
  };
}

const pendingUiWaiters = [];

async function streamSequence(promptText, slow) {
  const gen = abortGeneration;
  streaming = true;
  const step = slow ? 400 : 60;
  const assistantContent = [
    { type: "text", text: "你好，世界" },
    { type: "thinking", thinking: "思考中…" },
    { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
  ];

  out({ type: "agent_start" });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" } });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "思考中…" } });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 1, thinking: "思考中…" } });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "，世界" } });
  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, toolCall: { id: "call_1", name: "read", arguments: "{}" } } });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "README.md" } });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({
    type: "tool_execution_update",
    toolCallId: "call_1",
    toolName: "read",
    partialResult: { content: [{ type: "text", text: "partial" }], details: {} },
  });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "README content" }], details: {} },
    isError: false,
  });
  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { id: "call_1", name: "read", arguments: { path: "README.md" } } } });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "你好，世界" } });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({ type: "message_end", message: { role: "assistant", content: assistantContent } });

  if (abortGeneration !== gen) {
    return;
  }
  messages.push(
    { role: "user", content: promptText },
    { role: "assistant", content: assistantContent },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "README content" }],
      isError: false,
    },
  );
  streaming = false;
  out({ type: "agent_end", messages: [...messages], willRetry: false });
  out({ type: "agent_settled" });
}

/**
 * 一个 prompt 产出两条连续助手消息：第一条含 text+thinking 块，
 * 第二条仅 text 块（慢速）。用于回归测试：跨消息 contentIndex 装配必须重置，
 * 否则第二条的流式块会串入第一条遗留的 thinking 块。
 */
async function twoMessageSequence(promptText) {
  const gen = abortGeneration;
  streaming = true;
  const step = 400;
  out({ type: "agent_start" });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "第一条" } });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "旧思考" } });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 1, thinking: "旧思考" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "第一条" } });
  out({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "第一条" },
        { type: "thinking", thinking: "旧思考" },
      ],
    },
  });

  log({ dir: "marker", message: "second-message-start" });

  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });

  await delay(step);
  if (abortGeneration !== gen) {
    return;
  }
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "第二条" } });
  // 在第二条消息的流式窗口内保持稳定状态，供测试确定性地采样部分消息块
  log({ dir: "marker", message: "second-delta-sent" });

  await delay(2500);
  if (abortGeneration !== gen) {
    return;
  }
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "，完整" } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "第二条，完整" } });
  out({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "第二条，完整" }] },
  });

  if (abortGeneration !== gen) {
    return;
  }
  messages.push(
    { role: "user", content: promptText },
    {
      role: "assistant",
      content: [
        { type: "text", text: "第一条" },
        { type: "thinking", thinking: "旧思考" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "第二条，完整" }] },
  );
  streaming = false;
  out({ type: "agent_end", messages: [...messages], willRetry: false });
  out({ type: "agent_settled" });
}

// stdin 按 LF 切分（与协议一致，禁用 readline）
let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let idx;
  while ((idx = stdinBuffer.indexOf("\n")) !== -1) {
    let line = stdinBuffer.slice(0, idx);
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length > 0) {
      void handleCommand(JSON.parse(line));
    }
  }
});

async function handleCommand(record) {
  log({ dir: "in", record });
  const { id, type } = record;

  switch (type) {
    case "get_state":
      respond(id, "get_state", true, stateData());
      break;

    case "get_messages":
      respond(id, "get_messages", true, { messages: [...messages] });
      break;

    case "get_available_models":
      respond(id, "get_available_models", true, { models: [MODEL] });
      break;

    case "prompt": {
      respond(id, "prompt", true);
      const text = String(record.message ?? "");
      if (text.includes("UIREQUEST")) {
        out({
          type: "extension_ui_request",
          id: "ui-1",
          method: "confirm",
          title: "Allow?",
          message: "Proceed with fake action?",
        });
        // 等待客户端回复（客户端应自动回复 cancelled，否则这里会一直等待）
        const response = await waitForUiResponse("ui-1");
        log({ dir: "ui-response", response });
      }
      if (text.includes("CRASHME")) {
        // 模拟 pi 崩溃：正常响应后延迟退出（配合 restart 竞态回归测试：
        // 测试在流未结束时立即 restart，旧进程的 exit 事件迟到不得污染新状态）
        void streamSequence(text, false);
        setTimeout(() => process.exit(1), 1500);
        break;
      }
      if (text.includes("TWOMSG")) {
        void twoMessageSequence(text);
      } else {
        void streamSequence(text, text.includes("ABORTME"));
      }
      break;
    }

    case "steer":
      respond(id, "steer", true);
      break;

    case "abort":
      respond(id, "abort", true);
      abortGeneration++;
      if (streaming) {
        streaming = false;
        out({ type: "agent_end", messages: [...messages], willRetry: false });
        out({ type: "agent_settled" });
      }
      break;

    case "extension_ui_response": {
      const waiter = pendingUiWaiters.find((w) => w.id === record.id);
      if (waiter) {
        waiter.resolve(record);
      }
      break;
    }

    default:
      respond(id, type, false, undefined, `fake-pi: 未知命令 ${type}`);
  }
}

function waitForUiResponse(id) {
  return new Promise((resolve) => {
    pendingUiWaiters.push({ id, resolve });
  });
}
