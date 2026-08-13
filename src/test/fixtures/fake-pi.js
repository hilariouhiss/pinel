/**
 * 假 pi：按 rpc.md 协议实现的确定性 RPC 服务器，供集成测试使用。
 *
 * 行为：
 * - get_state / get_messages / get_available_models 返回固定状态
 * - prompt 触发流式序列：agent_start → message_start → 多 contentIndex 块
 *   （text/thinking 交替 + toolCall）→ tool_execution_* → message_end →
 *   agent_end → agent_settled
 * - prompt 含 "ABORTME"：慢速流（每事件 300ms），收到 abort 后立即收尾
 * - prompt 含 "UIREQUEST"：先发 extension_ui_request（confirm 对话框，无 timeout）
 *   并等待客户端回复（用于验证客户端自动 cancelled 回复）
 * - 所有收到的命令写入日志文件（PINEL_FAKE_PI_LOG 或系统临时目录）
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
  process.stdout.write(JSON.stringify(record) + "\n");
}

let messages = [];
let aborted = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function respond(id, command, success, data, error) {
  const res = { type: "response", command, success };
  if (id !== undefined) {res.id = id;}
  if (data !== undefined) {res.data = data;}
  if (error !== undefined) {res.error = error;}
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

/** 等待一个 extension_ui_response（confirm 对话框）。 */
let pendingUiWaiters = [];

async function streamSequence(promptText, slow) {
  const step = slow ? 400 : 60;
  const assistantContent = [
    { type: "text", text: "你好，世界" },
    { type: "thinking", thinking: "思考中…" },
    { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
  ];

  out({ type: "agent_start" });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  if (aborted) {return;}
  await delay(step);
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" } });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } });
  if (aborted) {return;}
  await delay(step);
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "思考中…" } });
  out({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 1, thinking: "思考中…" } });
  if (aborted) {return;}
  await delay(step);
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "，世界" } });
  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, toolCall: { id: "call_1", name: "read", arguments: "{}" } } });
  if (aborted) {return;}
  await delay(step);
  out({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "README.md" } });
  if (aborted) {return;}
  await delay(step);
  out({
    type: "tool_execution_update",
    toolCallId: "call_1",
    toolName: "read",
    partialResult: { content: [{ type: "text", text: "partial" }], details: {} },
  });
  if (aborted) {return;}
  await delay(step);
  out({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "README content" }], details: {} },
    isError: false,
  });
  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { id: "call_1", name: "read", arguments: { path: "README.md" } } } });
  if (aborted) {return;}
  await delay(step);
  out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "你好，世界" } });
  if (aborted) {return;}
  await delay(step);
  out({ type: "message_end", message: { role: "assistant", content: assistantContent } });

  if (aborted) {return;}
  const userMsg = { role: "user", content: promptText };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text: "README content" }],
    isError: false,
  };
  messages.push(userMsg, { role: "assistant", content: assistantContent }, toolResult);
  out({ type: "agent_end", messages: [...messages], willRetry: false });
  out({ type: "agent_settled" });
}

/** stdin 按 LF 切分（与协议一致，禁用 readline）。 */
let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let idx;
  while ((idx = stdinBuffer.indexOf("\n")) !== -1) {
    let line = stdinBuffer.slice(0, idx);
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (line.endsWith("\r")) {line = line.slice(0, -1);}
    if (line.length > 0) {void handleCommand(JSON.parse(line));}
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
      aborted = false; // 每个新 prompt 复位中断标志
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
      void streamSequence(text, text.includes("ABORTME"));
      break;
    }

    case "steer":
      respond(id, "steer", true);
      break;

    case "abort":
      respond(id, "abort", true);
      if (aborted === false) {
        aborted = true;
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
