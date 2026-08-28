/**
 * 假 pi：按 rpc.md 协议实现的确定性 RPC 服务器，供集成测试使用。
 *
 * 行为：
 * - get_state / get_messages / get_available_models 返回固定状态
 * - prompt 触发流式序列：message_start/message_end（用户消息，镜像真实 pi）→
 *   agent_start → message_start → 多 contentIndex 块（text/thinking 交替 + toolCall）
 *   → tool_execution_* → message_end → agent_end → agent_settled
 * - prompt 含 "ABORTME"：慢速流（每事件 400ms），收到 abort 后立即收尾
 * - prompt 含 "UIREQUEST"：先发 extension_ui_request（confirm 对话框，无 timeout）
 *   并等待客户端回复（用于验证客户端自动 cancelled 回复）
 * - prompt 含 "TWOMSG"：一个 prompt 产出两条连续助手消息（第一条含 text+thinking，
 *   第二条仅 text 慢速），用于回归测试跨消息 contentIndex 装配重置
 * - prompt 含 "QUESTIONNAIRE"：模拟 rpiv-ask-user-question 的 RPC 问卷 walker——
 *   先发 tool_execution_start（ask_user_question 完整题目参数），再逐题串行发
 *   select/input 并逐一等待回复（单选哨兵后跟进 input、多选发 input），
 *   每题回复记录到日志（dir: "ui-response"）供集成测试断言；任一点收到
 *   cancelled 即放弃后续题目（与插件 walker 一致）；含 "QUESTIONNAIRE-TWICE"
 *   时首卷 settle 后再发第二份同题问卷（toolCallId qna_2，帧前缀 qna2）
 * - get_commands 返回固定命令集（扩展/模板/技能三类，含 skill: 前缀名）；
 *   prompt 含 "CMDADD" 时向命令集追加一条命令（settle 后刷新可观察）
 * - cycle_model：在 MODELS 间循环，响应 {model, thinkingLevel, isScoped}；
 *   场景 SINGLE-MODEL 回 data:null（仅一个模型）、CYCLE-FAIL 回 success:false
 * - cycle_thinking_level：在 THINKING_LEVELS 间循环，响应 {level}；
 *   场景 NO-THINKING 回 data:null（模型不支持思考）
 * - set_model：按 provider+modelId 查 MODELS，命中则写入内存态并返回该模型；
 *   未命中回 error（Model not found）；场景 SETMODEL-CLAMP 在切换后把
 *   currentThinkingLevel 重置为 "medium"（合成行为：真实 pi 仅在“新模型不支持
 *   当前等级”时调整、默认保持，此处仅用于验证客户端 get_state 回读同步）；
 *   场景 SETMODEL-SLOW 延时 ~1.5s 再响应（供迟到响应竞态测试）；
 *   场景 SETMODEL-READBACKFAIL 在 set_model 成功后令下一次 get_state 失败一次
 *   （验证“回读失败 → notice，状态保留 set_model 结果”分支）
 * - get_available_thinking_levels：返回 THINKING_LEVELS；场景 THINKLEVELS-OFF
 *   回 ["off"]（模型不支持思考）、THINKLEVELS-FAIL 回 success:false（旧版 pi）
 * - set_thinking_level：写入内存态并回 success；场景 SETTHINK-CLAMP 把请求
 *   clamp 到 THINKING_LEVELS 内（如请求 off → minimal，模拟真实 pi clamp）；
 *   场景 SETTHINK-FAIL 回 success:false（设置失败）
 * - set_steering_mode / set_follow_up_mode / set_auto_compaction：写入内存态
 *   （get_state 回读，保证“重启后配置恢复”可自动化验证）
 * - 配置持久化：设 PINEL_FAKE_PI_STATE 时，配置内存态写入该文件并在启动时
 *   恢复（模拟真实 pi 写 settings 的行为；不设则仅进程内存态）
 * - 环境变量 PINEL_FAKE_PI_SCENARIO 在进程启动时读取，作用于 get_state
 *   （首次 get_state 发生在任何 prompt 之前，prompt 子串标记机制不可用）：
 *   NULLMODEL-FIRST：前 2 次 get_state 返回 model:null，之后正常
 *   NULLMODEL-FOREVER：get_state 恒返回 model:null
 *   NOCOMMANDS：get_commands 回 success:false（模拟旧版 pi 未知命令）
 *   SINGLE-MODEL：cycle_model 回 data:null（仅一个可用模型）
 *   NO-THINKING：cycle_thinking_level 回 data:null（模型不支持思考）
 *   CYCLE-FAIL：cycle_model 回 success:false（切换失败）
 *   NOSTATE-FIELDS：get_state 不带配置三字段（模拟旧版 pi，客户端应保留默认值）
 *   THINKLEVELS-OFF：get_available_thinking_levels 回 ["off"]（不支持思考）
 *   THINKLEVELS-FAIL：get_available_thinking_levels 回 success:false（旧版 pi）
 *   MODELS-FAIL：get_available_models 回 success:false（旧版 pi）
 *   SETMODEL-CLAMP：set_model 后重置思考等级为 "medium"（合成行为，见上）
 *   SETMODEL-SLOW：set_model 延时 ~1.5s 响应（迟到响应竞态）
 *   SETMODEL-READBACKFAIL：set_model 成功后下一次 get_state 失败一次
 *   SETTHINK-CLAMP：set_thinking_level clamp（如 off → minimal）
 *   SETTHINK-FAIL：set_thinking_level 回 success:false（设置失败）
 *   SWITCH-CANCEL：switch_session 回 data.cancelled:true（扩展钩子取消）
 *   SWITCH-LATE-END：switch_session 正常响应后延迟 ~400ms 补发旧流的
 *     agent_end（携带切换前旧消息）——模拟真实 pi 的异步乱序，验证客户端
 *     settle 后迟到事件的代际防护（agent_end 在 isStreaming=false 时丢弃）
 *   FORK-FAIL：fork 回 success:false（fork 失败；客户端应 notice 且状态不变）
 *   FORK-CANCELLED：fork 回 data.cancelled:true（session_before_fork 扩展钩子取消）
 * - get_fork_messages / fork / clone：默认行为（真实 pi 镜像）——get_fork_messages
 *   从当前消息派生 [{entryId,text}]（仅非空 user 消息）；fork 按 entryId 截断消息
 *   至选中点并切换会话（设 PINEL_FAKE_PI_SESSION_DIR 时物理落盘新会话文件，
 *   header 对齐真实 pi createBranchedSession），回 {text,cancelled:false}；
 *   clone 复制当前会话文件为新文件并切换，回 {cancelled:false}
 * - switch_session / new_session：默认行为（真实 pi 镜像）——switch_session
 *   把当前会话文件回显为传入 sessionPath 并重置消息为 B 会话数据；
 *   new_session 清空消息并生成新会话文件（get_state/get_messages 回读）
 * - 所有收到/发出的记录写入日志文件（PINEL_FAKE_PI_LOG 或系统临时目录）
 * - stdin EOF（父进程关闭管道）时退出：与真实 pi 的优雅退出路径一致，
 *   保证集成测试的 restart 流程不付 2.5s 优雅期等待
 */
"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const LOG_PATH = process.env.PINEL_FAKE_PI_LOG || path.join(os.tmpdir(), "pinel-fake-pi.log");

/** 场景开关（进程启动时读取一次）：作用于 get_state 的模型字段。 */
const SCENARIO = process.env.PINEL_FAKE_PI_SCENARIO || "";

log({ dir: "meta", event: "startup", pid: process.pid, scenario: SCENARIO });

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
 * 会话内存态：switch_session/new_session 修改、get_state/get_messages 回读。
 * 默认会话与 stateData() 历史行为一致（/fake/session.jsonl）。
 */
let currentSessionFile = "/fake/session.jsonl";
let currentSessionId = "fake-session";
let newSessionCount = 0;
let forkCount = 0;
let cloneCount = 0;
/** 当前会话显示名（set_session_name 写入；get_state 镜像 sessionName 字段）。 */
let currentSessionName = undefined;

/** B 会话数据（switch_session 后重置为的消息集合，与默认会话可区分）。 */
const sessionBMessages = [
  { role: "user", content: "B 会话的问题" },
  { role: "assistant", content: [{ type: "text", text: "B 会话的回答" }] },
];

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

/**
 * 向会话文件物理追加 session_info 条目（格式对齐宿主 appendSessionName /
 * 真实 pi appendSessionInfo）：leaf id = 最后一个非 header 条目、uuid8 查重、
 * 尾无换行先补 \n。文件不存在/不可读时抛错由调用方吞掉（仅内存态）。
 */
function appendSessionInfoToFile(filePath, name) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error("no file");
  }
  const ids = new Set();
  let leafId = null;
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 坏行跳过（对齐 parseSessionEntryLine）
    }
    if (!entry || entry.type === "session") {
      continue;
    }
    if (typeof entry.id === "string" && entry.id) {
      ids.add(entry.id);
      leafId = entry.id;
    }
  }
  let id = "";
  for (let i = 0; i < 100; i++) {
    const candidate = crypto.randomUUID().slice(0, 8);
    if (!ids.has(candidate)) {
      id = candidate;
      break;
    }
  }
  if (!id) {
    id = crypto.randomUUID();
  }
  const entry = {
    type: "session_info",
    id,
    parentId: leafId,
    timestamp: new Date().toISOString(),
    name: String(name).replace(/[\r\n]+/g, " ").trim(),
  };
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(filePath, prefix + JSON.stringify(entry) + "\n", "utf8");
}

/**
 * fork 物理落盘：在 PINEL_FAKE_PI_SESSION_DIR 指向的目录写新会话文件
 * （真实 pi createBranchedSession 镜像：header {type:session,id,timestamp,cwd,
 * parentSession} + 截断至 fork 点的消息）。未设 env 时返回 null（仅内存态）。
 */
function writeBranchedSession(entryIndex) {
  const dir = process.env.PINEL_FAKE_PI_SESSION_DIR;
  if (!dir) {
    return null;
  }
  const filePath = path.join(dir, `${Date.now()}_${crypto.randomUUID()}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      parentSession: currentSessionFile,
    }),
  ];
  for (let i = 0; i <= entryIndex && i < messages.length; i++) {
    lines.push(JSON.stringify(messages[i]));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

/** clone 物理落盘：复制当前会话文件内容到新文件；当前文件不存在时写 header + 消息。 */
function writeCloneSession() {
  const dir = process.env.PINEL_FAKE_PI_SESSION_DIR;
  if (!dir) {
    return null;
  }
  const filePath = path.join(dir, `${Date.now()}_${crypto.randomUUID()}.jsonl`);
  try {
    const content = fs.readFileSync(currentSessionFile, "utf8");
    fs.writeFileSync(filePath, content, "utf8");
  } catch {
    const lines = [
      JSON.stringify({
        type: "session",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        parentSession: currentSessionFile,
      }),
    ];
    for (const m of messages) {
      lines.push(JSON.stringify(m));
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  }
  return filePath;
}

const MODEL = { id: "fake-model", name: "Fake Model", provider: "fake" };

/** 可用模型列表（cycle_model 循环；get_available_models 返回全量）。 */
const MODELS = [
  MODEL,
  { id: "fake-model-b", name: "Fake Model B", provider: "fake" },
];

/** 思考等级循环表（cycle_thinking_level）。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

/**
 * 配置内存态：set_* / cycle_* 写入、get_state 回读。
 * 设 PINEL_FAKE_PI_STATE 时持久化到该文件（模拟真实 pi 写 settings），
 * 新进程启动时恢复——使“重启后配置恢复”可自动化验证。
 */
let currentModelIndex = 0;
let currentThinkingLevel = "high";
let steeringMode = "all";
let followUpMode = "one-at-a-time";
let autoCompactionEnabled = true;

/** 配置持久化文件（env 指定；未设则仅内存态）。 */
const STATE_PATH = process.env.PINEL_FAKE_PI_STATE || "";

/** 启动时从状态文件恢复配置（真实 pi 的 settings 行为镜像）。 */
function loadState() {
  if (!STATE_PATH) {
    return;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (saved && typeof saved === "object") {
      currentModelIndex = typeof saved.currentModelIndex === "number" ? saved.currentModelIndex : currentModelIndex;
      currentThinkingLevel = typeof saved.currentThinkingLevel === "string" ? saved.currentThinkingLevel : currentThinkingLevel;
      steeringMode = typeof saved.steeringMode === "string" ? saved.steeringMode : steeringMode;
      followUpMode = typeof saved.followUpMode === "string" ? saved.followUpMode : followUpMode;
      autoCompactionEnabled = typeof saved.autoCompactionEnabled === "boolean" ? saved.autoCompactionEnabled : autoCompactionEnabled;
    }
  } catch {
    // 状态文件不存在/损坏：保持默认值
  }
}

/** 每次配置变更后写入状态文件（真实 pi 的 settings 行为镜像）。 */
function saveState() {
  if (!STATE_PATH) {
    return;
  }
  try {
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({
        currentModelIndex,
        currentThinkingLevel,
        steeringMode,
        followUpMode,
        autoCompactionEnabled,
      }),
    );
  } catch {
    // 保存失败不影响协议
  }
}

loadState();

/** get_state 已响应次数（仅 NULLMODEL 场景统计）。 */
let getStateCount = 0;

/** SETMODEL-READBACKFAIL：set_model 成功后的下一次 get_state 回失败（一次性）。 */
let readbackFailPending = false;

/** get_commands 基础命令集（三类来源 + skill: 前缀名，供补全链路测试）。 */
const baseCommands = [
  { name: "fix", description: "修复测试失败", source: "prompt", sourceInfo: { path: "/fake/prompts/fix.md" } },
  { name: "plan", description: "制定实现计划", source: "prompt", sourceInfo: { path: "/fake/prompts/plan.md" } },
  { name: "skill:ctx-search", description: "检索本地索引", source: "skill", sourceInfo: { path: "/fake/skills/ctx-search/SKILL.md" } },
  { name: "session-name", description: "设置会话名", source: "extension", sourceInfo: { path: "/fake/extensions/session.ts" } },
];
/** CMDADD 场景：是否已向命令集追加过（进程内存态，只追加一次防重复）。 */
let cmdAdded = false;

function stateData() {
  let model = MODELS[currentModelIndex];
  if (SCENARIO === "NULLMODEL-FOREVER") {
    getStateCount++;
    model = null;
  } else if (SCENARIO === "NULLMODEL-FIRST") {
    getStateCount++;
    if (getStateCount <= 2) {
      model = null;
    }
  }
  if (SCENARIO === "NOSTATE-FIELDS") {
    // 模拟旧版 pi：get_state 不带配置三字段（客户端应保留默认值）
    return {
      model,
      thinkingLevel: currentThinkingLevel,
      // 流式中回真实 streaming 状态（真实 pi 行为；客户端回读依赖它）
      isStreaming: streaming,
      isCompacting: false,
      sessionFile: currentSessionFile,
      sessionId: currentSessionId,
      messageCount: messages.length,
      pendingMessageCount: 0,
    };
  }
  return {
    model,
    thinkingLevel: currentThinkingLevel,
    isStreaming: streaming,
    isCompacting: false,
    steeringMode,
    followUpMode,
    autoCompactionEnabled,
    sessionFile: currentSessionFile,
    sessionId: currentSessionId,
    messageCount: messages.length,
    pendingMessageCount: 0,
  };
}

const pendingUiWaiters = [];

async function streamSequence(promptText, slow) {
  const gen = abortGeneration;
  streaming = true;
  const step = slow ? 400 : 60;
  // 镜像真实 pi：用户消息也发 message_start/message_end（pinel 侧必须门控
  // 不重复推送——webview 已有乐观渲染的用户消息）
  const userMessage = { role: "user", content: [{ type: "text", text: promptText }] };
  out({ type: "message_start", message: userMessage });
  out({ type: "message_end", message: userMessage });
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

// stdin EOF：父进程关闭管道 → 优雅退出（与真实 pi 的 RPC 优雅退出路径一致）
process.stdin.on("end", () => {
  log({ dir: "meta", event: "stdin-end", scenario: SCENARIO });
  process.exit(0);
});

async function handleCommand(record) {
  log({ dir: "in", record });
  const { id, type } = record;

  switch (type) {
    case "get_state":
      if (readbackFailPending) {
        // SETMODEL-READBACKFAIL：模拟回读失败（一次性，之后恢复正常）
        readbackFailPending = false;
        respond(id, "get_state", false, undefined, "readback failed (scenario)");
        break;
      }
      respond(id, "get_state", true, stateData());
      break;

    case "get_messages":
      respond(id, "get_messages", true, { messages: [...messages] });
      break;

    case "get_available_models":
      if (SCENARIO === "MODELS-FAIL") {
        // 模拟旧版 pi：未知命令（客户端应 notice + 关弹窗）
        respond(id, "get_available_models", false, undefined, "Unknown command: get_available_models");
        break;
      }
      respond(id, "get_available_models", true, { models: [...MODELS] });
      break;

    case "cycle_model": {
      if (SCENARIO === "CYCLE-FAIL") {
        respond(id, "cycle_model", false, undefined, "model switch failed");
        break;
      }
      if (SCENARIO === "SINGLE-MODEL") {
        // 仅一个可用模型：cycle_model 回 data:null（客户端应提示且状态不变）
        respond(id, "cycle_model", true, null);
        break;
      }
      currentModelIndex = (currentModelIndex + 1) % MODELS.length;
      saveState();
      respond(id, "cycle_model", true, {
        model: MODELS[currentModelIndex],
        thinkingLevel: currentThinkingLevel,
        isScoped: false,
      });
      break;
    }

    case "set_model": {
      const model = MODELS.find((m) => m.provider === record.provider && m.id === record.modelId);
      if (!model) {
        respond(id, "set_model", false, undefined, `Model not found: ${record.provider}/${record.modelId}`);
        break;
      }
      if (SCENARIO === "SETMODEL-SLOW") {
        // 迟到响应竞态：延时后响应（测试侧 fire-and-forget 后立即 restart）
        setTimeout(() => {
          currentModelIndex = MODELS.indexOf(model);
          saveState();
          respond(id, "set_model", true, model);
        }, 1500);
        break;
      }
      currentModelIndex = MODELS.indexOf(model);
      saveState();
      if (SCENARIO === "SETMODEL-CLAMP") {
        // 合成行为：真实 pi 仅在“新模型不支持当前等级”时 re-clamp、默认保持
        // 当前等级；此处重置为 medium 仅用于验证客户端 get_state 回读同步
        currentThinkingLevel = "medium";
        saveState();
      }
      if (SCENARIO === "SETMODEL-READBACKFAIL") {
        readbackFailPending = true; // 下一次 get_state 失败一次
      }
      respond(id, "set_model", true, model);
      break;
    }

    case "get_available_thinking_levels": {
      if (SCENARIO === "THINKLEVELS-FAIL") {
        respond(id, "get_available_thinking_levels", false, undefined, "Unknown command: get_available_thinking_levels");
        break;
      }
      if (SCENARIO === "THINKLEVELS-OFF") {
        // 模型不支持思考：仅 ["off"]（真实 pi 行为镜像）
        respond(id, "get_available_thinking_levels", true, { levels: ["off"] });
        break;
      }
      respond(id, "get_available_thinking_levels", true, { levels: [...THINKING_LEVELS] });
      break;
    }

    case "set_thinking_level": {
      if (SCENARIO === "SETTHINK-FAIL") {
        respond(id, "set_thinking_level", false, undefined, "set thinking level failed");
        break;
      }
      if (SCENARIO === "SETTHINK-CLAMP") {
        // 模拟真实 pi 的 clamp 语义：请求的等级不在支持列表内时取最低支持值
        currentThinkingLevel = THINKING_LEVELS.includes(record.level) ? record.level : THINKING_LEVELS[0];
        saveState();
        respond(id, "set_thinking_level", true);
        break;
      }
      currentThinkingLevel = String(record.level);
      saveState();
      respond(id, "set_thinking_level", true);
      break;
    }

    case "cycle_thinking_level": {
      if (SCENARIO === "NO-THINKING") {
        // 模型不支持思考：回 data:null（客户端应提示且状态不变）
        respond(id, "cycle_thinking_level", true, null);
        break;
      }
      const idx = THINKING_LEVELS.indexOf(currentThinkingLevel);
      currentThinkingLevel = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
      saveState();
      respond(id, "cycle_thinking_level", true, { level: currentThinkingLevel });
      break;
    }

    case "set_steering_mode":
      steeringMode = record.mode;
      saveState();
      respond(id, "set_steering_mode", true);
      break;

    case "set_follow_up_mode":
      followUpMode = record.mode;
      saveState();
      respond(id, "set_follow_up_mode", true);
      break;

    case "set_auto_compaction":
      autoCompactionEnabled = Boolean(record.enabled);
      saveState();
      respond(id, "set_auto_compaction", true);
      break;

    case "get_commands":
      if (SCENARIO === "NOCOMMANDS") {
        // 模拟旧版 pi：未知命令（客户端应静默保持空列表，不影响启动）
        respond(id, "get_commands", false, undefined, "Unknown command: get_commands");
      } else {
        const extra = cmdAdded
          ? [{ name: "cmd-added", description: "追加的命令", source: "prompt", sourceInfo: {} }]
          : [];
        respond(id, "get_commands", true, { commands: [...baseCommands, ...extra] });
      }
      break;

    case "switch_session": {
      if (SCENARIO === "SWITCH-CANCEL") {
        // 扩展钩子取消切换：状态不变
        respond(id, "switch_session", true, { cancelled: true });
        break;
      }
      const sessionPath = String(record.sessionPath ?? "");
      const oldMessages = [...messages];
      currentSessionFile = sessionPath;
      currentSessionId = "switched-session";
      // 拷贝而非引用：prompt 流式的 push 会污染共享的 sessionBMessages 常量
      //（实测：切换后消息数从 2 涨到 5，统计断言失败）
      messages = [...sessionBMessages];
      respond(id, "switch_session", true, { cancelled: false });
      if (SCENARIO === "SWITCH-LATE-END") {
        // 模拟真实 pi 的异步乱序：切换响应后延迟补发旧流的 agent_end
        //（携带切换前旧消息）——验证客户端 settle 后迟到事件的代际防护
        setTimeout(() => {
          out({ type: "agent_end", messages: oldMessages, willRetry: false });
        }, 400);
      }
      break;
    }

    case "new_session": {
      newSessionCount++;
      currentSessionFile = `/fake/session-new-${newSessionCount}.jsonl`;
      currentSessionId = "new-session";
      messages = [];
      respond(id, "new_session", true, { cancelled: false });
      break;
    }

    case "set_session_name": {
      // 真实 pi 镜像（rpc-mode.js）：trim 后空名报错；成功无 data。
      // 向 currentSessionFile 物理追加 session_info 条目（重命名测试断言
      // 文件内容/标题刷新/列表名称依赖真实落盘——与宿主 appendSessionName 同格式）。
      const name = String(record.name ?? "").replace(/[\r\n]+/g, " ").trim();
      if (!name) {
        respond(id, "set_session_name", false, undefined, "Session name cannot be empty");
        break;
      }
      if (SCENARIO === "RENAME-FAIL") {
        // 模拟旧版 pi 无此命令：失败路径（客户端应 notice 且状态不变）
        respond(id, "set_session_name", false, undefined, "Unknown command: set_session_name");
        break;
      }
      currentSessionName = name;
      try {
        appendSessionInfoToFile(currentSessionFile, name);
      } catch {
        // 文件不存在（默认 /fake/session.jsonl 内存态）：仅更新内存态
      }
      respond(id, "set_session_name", true);
      break;
    }

    case "get_fork_messages": {
      // 真实 pi 镜像（agent-session.js getUserMessagesForForking）：
      // 仅非空 user 消息；entryId 为派生稳定标识（fork 命令回传解析）。
      const result = [];
      let userIndex = 0;
      messages.forEach((m) => {
        if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
          result.push({ entryId: `fork-msg-${userIndex}`, text: m.content });
          userIndex++;
        }
      });
      respond(id, "get_fork_messages", true, { messages: result });
      break;
    }

    case "fork": {
      // 场景检查先于 entryId 校验：FORK-FAIL/FORK-CANCELLED 经 env 激活（restart
      // 后消息为空时仍生效——对齐 SWITCH-CANCEL 的 SCENARIO 前置模式）
      if (SCENARIO === "FORK-FAIL") {
        respond(id, "fork", false, undefined, "Fork failed (fake)");
        break;
      }
      if (SCENARIO === "FORK-CANCELLED") {
        respond(id, "fork", true, { cancelled: true });
        break;
      }
      const entryId = String(record.entryId ?? "");
      const match = entryId.match(/^fork-msg-(\d+)$/);
      const userIndex = match ? parseInt(match[1], 10) : -1;
      // user 计数 → 数组索引（user 消息在 messages 中与 assistant/toolResult 交错）
      let entryIndex = -1;
      let userCount = 0;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i] && messages[i].role === "user" && typeof messages[i].content === "string") {
          if (userCount === userIndex) {
            entryIndex = i;
            break;
          }
          userCount++;
        }
      }
      if (entryIndex < 0) {
        respond(id, "fork", false, undefined, "Invalid entry ID for forking");
        break;
      }
      // 流状态复位（S7）：流式中 fork 场景防 get_messages 回读混入旧流残余
      streaming = false;
      abortGeneration++;
      const newFile = writeBranchedSession(entryIndex);
      forkCount++;
      currentSessionFile = newFile || `/fake/fork-${forkCount}.jsonl`;
      currentSessionId = "forked-session";
      currentSessionName = undefined;
      // fork 后消息 = 祖先链（截断至 fork 点；真实 pi 语义）
      messages = messages.slice(0, entryIndex + 1);
      respond(id, "fork", true, { text: messages[entryIndex].content, cancelled: false });
      break;
    }

    case "clone": {
      // 空会话（无 leaf）时真实 pi 回 success:false（rpc-mode.js）
      if (SCENARIO === "CLONE-FAIL" || !messages.length) {
        respond(id, "clone", false, undefined, "Cannot clone session: no current entry selected");
        break;
      }
      if (SCENARIO === "CLONE-CANCELLED") {
        respond(id, "clone", true, { cancelled: true });
        break;
      }
      streaming = false;
      abortGeneration++;
      const newFile = writeCloneSession();
      cloneCount++;
      currentSessionFile = newFile || `/fake/clone-${cloneCount}.jsonl`;
      currentSessionId = "cloned-session";
      currentSessionName = undefined;
      respond(id, "clone", true, { cancelled: false });
      break;
    }

    case "get_session_stats": {
      // 真实 pi 镜像（docs/rpc.md 已收录）：聚合全会话条目。
      // 统计随消息数与会话派生（messages.length / currentSessionFile 的 base），
      // 让「settle 后刷新」「切换后更新」断言可区分新旧值。
      if (SCENARIO === "STATS-FAIL") {
        respond(id, "get_session_stats", false, undefined, "stats failed (scenario)");
        break;
      }
      const n = messages.length;
      // 默认会话 /fake/session.jsonl 与切换后会话区分（切换后统计归属变化可断言）
      const base = currentSessionFile === "/fake/session.jsonl" ? 1000 : 500;
      const input = base + n * 100;
      const output = Math.round(base / 2) + n * 50;
      const cacheRead = base + n * 100;
      const cacheWrite = Math.round(base / 4);
      const stats = {
        sessionFile: currentSessionFile,
        sessionId: currentSessionId,
        userMessages: n,
        assistantMessages: n,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: n,
        tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
        cost: 0.01 + n * 0.001,
      };
      if (SCENARIO !== "STATS-NOCONTEXT") {
        // 无模型/无 contextWindow 时 contextUsage 缺省（STATS-NOCONTEXT 模拟）
        stats.contextUsage = {
          tokens: base + n * 50,
          contextWindow: 200000,
          percent: Math.round(((base + n * 50) / 200000) * 100),
        };
      }
      respond(id, "get_session_stats", true, stats);
      break;
    }

    case "prompt": {
      respond(id, "prompt", true);
      const text = String(record.message ?? "");
      // 注意：UIREQUEST-CRASH 必须优先于 UIREQUEST 判断（子串包含关系）
      if (text.includes("UIREQUEST-CRASH")) {
        // 对话框 pending 期间进程崩溃：发 confirm 帧后 1.5s exit(1)
        out({
          type: "extension_ui_request",
          id: "ui-crash-1",
          method: "confirm",
          title: "Crash?",
          message: "pending 期间崩溃",
        });
        setTimeout(() => process.exit(1), 1500);
        // 进程将在 1.5s 后死亡，此等待不会 resolve（进程死亡即回收）
        await waitForUiResponse("ui-crash-1");
        break;
      }
      if (text.includes("UIREQUEST")) {
        out({
          type: "extension_ui_request",
          id: "ui-1",
          method: "confirm",
          title: "Allow?",
          message: "Proceed with fake action?",
        });
        // 等待客户端回复（pinel 现在渲染内联卡片由用户作答；不回复则一直等待）
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
      if (text.includes("CMDADD")) {
        // 模拟运行中注册新命令：settle 后客户端刷新 get_commands 时可见
        cmdAdded = true;
      }
      if (text.includes("QUESTIONNAIRE")) {
        const twice = text.includes("QUESTIONNAIRE-TWICE");
        await questionnaireSequence(text.includes("QUESTIONNAIRE-GENERIC"), twice ? { streamAfter: false } : undefined);
        if (twice) {
          // 等第一份问卷的流 settle（settle 会清卷）再发第二份：验证重入重置
          // （同题新 toolCallId qna_2，walker 帧前缀 qna2）
          await streamSequence(`questionnaire-settle-${Date.now()}`, false);
          await questionnaireSequence(false, { toolCallId: "qna_2", framePrefix: "qna2" });
        }
        break;
      }
      if (text.includes("ASKUI-TIMEOUT")) {
        // 模拟 pi 对带 timeout 的对话框自动超时 resolve：发 select 帧后
        // 不等待响应，延时走完流并 settle（配合 settled 清理回归测试）
        out({
          type: "extension_ui_request",
          id: "ui-timeout-1",
          method: "select",
          title: "Choose?",
          options: ["1. A", "2. B"],
          timeout: 1000,
        });
        void streamSequence(text, false);
        break;
      }
      if (text.includes("SUBAGENTBAD")) {
        // 模拟 subagent 卡片降级：args 仅 description；details 字段类型全错
        //（扩展格式漂移）——卡片字段保持兜底值，输出仍可达
        out({ type: "tool_execution_start", toolCallId: "sub_bad", toolName: "subagent", args: { description: "Degrade case" } });
        out({ type: "tool_execution_update", toolCallId: "sub_bad", toolName: "subagent", partialResult: { content: [{ type: "text", text: "1 tool uses..." }], details: "garbage" } });
        out({ type: "tool_execution_end", toolCallId: "sub_bad", toolName: "subagent", result: { content: [{ type: "text", text: "partial output" }], details: { modelName: 42, tags: "not-array", status: "unknown-status", turnCount: "5" } }, isError: false });
        void streamSequence(text, false);
        break;
      }
      if (text.includes("SUBAGENTME")) {
        // 模拟 subagent 工具执行：start(args 请求值) → update(running details 实时活动)
        // → end(completed details + markdown 报告)，对齐 @gotgenes/pi-subagents 事件形态
        out({
          type: "tool_execution_start",
          toolCallId: "sub_1",
          toolName: "subagent",
          args: { description: "Exploring auth flow", prompt: "Find the auth flow", subagent_type: "Explore", model: "haiku", thinking: "high" },
        });
        out({
          type: "tool_execution_update",
          toolCallId: "sub_1",
          toolName: "subagent",
          partialResult: {
            content: [{ type: "text", text: "2 tool uses..." }],
            details: { displayName: "Explore", description: "Exploring auth flow", subagentType: "Explore", modelName: "haiku", tags: ["thinking: high"], status: "running", activity: "reading src/auth.ts", turnCount: 2, toolUses: 2, tokens: "8.1k", spinnerFrame: 3 },
          },
        });
        out({
          type: "tool_execution_end",
          toolCallId: "sub_1",
          toolName: "subagent",
          result: {
            content: [{ type: "text", text: "## Findings\n\n- Auth uses JWT tokens\n- Refresh via cookie" }],
            details: { displayName: "Explore", description: "Exploring auth flow", subagentType: "Explore", modelName: "haiku", tags: ["thinking: high"], status: "completed", activity: "", turnCount: 5, toolUses: 3, tokens: "12.3k", durationMs: 4200 },
          },
          isError: false,
        });
        void streamSequence(text, false);
        break;
      }
      if (text.includes("TODOME")) {
        // 模拟 todo 工具执行：两轮 create + update，details.tasks 为全量快照
        out({ type: "tool_execution_start", toolCallId: "todo_1", toolName: "todo", args: { action: "create", subject: "任务一", description: "第一个任务" } });
        out({ type: "tool_execution_end", toolCallId: "todo_1", toolName: "todo", result: todoResult("create", { action: "create", subject: "任务一", description: "第一个任务" }, [
          { id: 1, subject: "任务一", status: "pending", description: "第一个任务" },
        ]) });
        out({ type: "tool_execution_start", toolCallId: "todo_2", toolName: "todo", args: { action: "create", subject: "任务二", description: "第二个任务" } });
        out({ type: "tool_execution_end", toolCallId: "todo_2", toolName: "todo", result: todoResult("create", { action: "create", subject: "任务二", description: "第二个任务" }, [
          { id: 1, subject: "任务一", status: "pending", description: "第一个任务" },
          { id: 2, subject: "任务二", status: "pending", description: "第二个任务" },
        ]) });
        out({ type: "tool_execution_start", toolCallId: "todo_3", toolName: "todo", args: { action: "update", id: 2, status: "in_progress", activeForm: "执行任务二" } });
        out({ type: "tool_execution_end", toolCallId: "todo_3", toolName: "todo", result: todoResult("update", { action: "update", id: 2, status: "in_progress", activeForm: "执行任务二" }, [
          { id: 1, subject: "任务一", status: "pending", description: "第一个任务" },
          { id: 2, subject: "任务二", status: "in_progress", description: "第二个任务", activeForm: "执行任务二" },
        ]) });
        void streamSequence(text, false);
        break;
      }
      if (text.includes("ASKUI")) {
        // 模拟 ask_user_question 插件的 RPC 问卷：发 select 帧等待回复
        out({
          type: "extension_ui_request",
          id: "ui-1",
          method: "select",
          title: "Pick one",
          options: ["1. A", "2. B"],
        });
        const response = await waitForUiResponse("ui-1");
        log({ dir: "ui-response", response });
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
      // 命中后从数组移除：防止后续同 id 请求命中已 resolve 的旧 waiter
      const idx = pendingUiWaiters.findIndex((w) => w.id === record.id);
      if (idx !== -1) {
        const [waiter] = pendingUiWaiters.splice(idx, 1);
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

/**
 * QUESTIONNAIRE 场景：模拟 rpiv-ask-user-question 的 RPC 问卷 walker。
 * 题目：Q1 单选（A/B）、Q2 多选（X/Y/Z）、Q3 单选（M/N）；每题对话框
 * 串行发送并等待回复；单选哨兵行后跟进 input（自定义答案）；任一点收到
 * cancelled 即放弃后续题目（与插件 walker 语义一致）。
 * withGeneric（QUESTIONNAIRE-GENERIC 标记）：问卷开始前穿插一个标题不匹配
 * 任何题目的通用 select（ui-generic-1），验证 pinel 的标题门控——通用
 * 对话框走逐卡路径、问卷帧才被缓冲。
 * opts：toolCallId/framePrefix 定制帧与工具 id（QUESTIONNAIRE-TWICE 第二卷用）；
 * streamAfter:false 抑制尾部流（TWICE 首卷由调用方 await 流后再发第二卷）。
 */
async function questionnaireSequence(withGeneric, opts = {}) {
  const toolCallId = opts.toolCallId ?? "qna_1";
  const fid = (n) => (opts.framePrefix ? `${opts.framePrefix}-${n}` : `qna-${n}`);
  let aborted = false;
  out({
    type: "tool_execution_start",
    toolCallId,
    toolName: "ask_user_question",
    args: {
      questions: [
        {
          question: "问题一？",
          header: "q1",
          options: [
            { label: "A", description: "选项 A" },
            { label: "B", description: "选项 B" },
          ],
        },
        {
          question: "问题二？",
          header: "q2",
          options: [
            { label: "X", description: "选项 X" },
            { label: "Y", description: "选项 Y" },
            { label: "Z", description: "选项 Z" },
          ],
          multiSelect: true,
        },
        {
          question: "问题三？",
          header: "q3",
          options: [
            { label: "M", description: "选项 M" },
            { label: "N", description: "选项 N" },
          ],
        },
      ],
    },
  });

  // 问卷期间穿插的通用对话框（标题不匹配任何题目 → pinel 走逐卡路径）
  if (withGeneric) {
    out({
      type: "extension_ui_request",
      id: "ui-generic-1",
      method: "select",
      title: "Allow something?",
      options: ["1. Yes", "2. No"],
    });
    const rg = await waitForUiResponse("ui-generic-1");
    log({ dir: "ui-response", id: "ui-generic-1", response: rg });
  }

  // Q1 单选：select + 哨兵行
  out({
    type: "extension_ui_request",
    id: fid(1),
    method: "select",
    title: "[q1] 问题一？",
    options: ["1. A — 选项 A", "2. B — 选项 B", "3. Type something."],
  });
  const r1 = await waitForUiResponse(fid(1));
  log({ dir: "ui-response", id: fid(1), response: r1 });
  if (r1.cancelled) {
    aborted = true;
  } else if (r1.value === "3. Type something.") {
    // 哨兵：跟进 input（自定义答案）
    out({
      type: "extension_ui_request",
      id: `${fid(1)}i`,
      method: "input",
      title: "问题一？\n\nType your answer:",
      placeholder: "",
    });
    const r1i = await waitForUiResponse(`${fid(1)}i`);
    log({ dir: "ui-response", id: `${fid(1)}i`, response: r1i });
    if (r1i.cancelled) {
      aborted = true;
    }
  }

  // Q2 多选：input
  if (!aborted) {
    out({
      type: "extension_ui_request",
      id: fid(2),
      method: "input",
      title: "问题二？\n\nEnter the numbers of all that apply, comma-separated (e.g. \"1,3\"), or type a custom answer as plain text.",
      placeholder: "1,3",
    });
    const r2 = await waitForUiResponse(fid(2));
    log({ dir: "ui-response", id: fid(2), response: r2 });
    if (r2.cancelled) {
      aborted = true;
    }
  }

  // Q3 单选：select + 哨兵行
  if (!aborted) {
    out({
      type: "extension_ui_request",
      id: fid(3),
      method: "select",
      title: "[q3] 问题三？",
      options: ["1. M — 选项 M", "2. N — 选项 N", "3. Type something."],
    });
    const r3 = await waitForUiResponse(fid(3));
    log({ dir: "ui-response", id: fid(3), response: r3 });
    if (!r3.cancelled && r3.value === "3. Type something.") {
      out({
        type: "extension_ui_request",
        id: `${fid(3)}i`,
        method: "input",
        title: "问题三？\n\nType your answer:",
        placeholder: "",
      });
      const r3i = await waitForUiResponse(`${fid(3)}i`);
      log({ dir: "ui-response", id: `${fid(3)}i`, response: r3i });
    }
  }

  out({
    type: "tool_execution_end",
    toolCallId,
    toolName: "ask_user_question",
    result: { content: [{ type: "text", text: aborted ? "questionnaire abandoned" : "questionnaire answered" }], details: {} },
    isError: false,
  });
  if (opts.streamAfter !== false) {
    void streamSequence(`questionnaire-${Date.now()}`, false);
  }
}

/** 构造 todo 工具的 tool_execution_end result（details.tasks 全量快照）。 */
function todoResult(action, params, tasks) {
  const verb = action === "update" ? "Updated" : "Created";
  const target = tasks[tasks.length - 1] ?? params;
  const label = params.id !== undefined ? `#${params.id}` : `#${tasks.length}`;
  return {
    content: [{ type: "text", text: `${verb} ${label}: ${target.subject} (${target.status})` }],
    details: { action, params, tasks, nextId: tasks.length + 1 },
  };
}
