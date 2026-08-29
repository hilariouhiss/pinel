import * as assert from "assert";
import { applyDelta, createAssembly } from "../chat/stream-assembly";

suite("流式装配（contentIndex 分块）单元测试", () => {
  test("text 与 thinking 多块交替时按 contentIndex 分别累积", () => {
    const a = createAssembly();
    applyDelta(a, { type: "text_start", contentIndex: 0 });
    applyDelta(a, { type: "text_delta", contentIndex: 0, delta: "你好" });
    applyDelta(a, { type: "thinking_start", contentIndex: 1 });
    applyDelta(a, { type: "thinking_delta", contentIndex: 1, delta: "思考中…" });
    applyDelta(a, { type: "thinking_end", contentIndex: 1, thinking: "思考中…" });
    applyDelta(a, { type: "text_delta", contentIndex: 0, delta: "，世界" });
    applyDelta(a, { type: "text_end", contentIndex: 0, content: "你好，世界" });

    assert.deepStrictEqual(a.blocks, [
      { kind: "text", text: "你好，世界" },
      { kind: "thinking", text: "思考中…" },
    ]);
  });

  test("text_end 以权威 content 替换增量累积", () => {
    const a = createAssembly();
    applyDelta(a, { type: "text_start", contentIndex: 0 });
    applyDelta(a, { type: "text_delta", contentIndex: 0, delta: "部分内容" });
    applyDelta(a, { type: "text_end", contentIndex: 0, content: "权威完整内容" });
    assert.strictEqual(a.blocks[0].text, "权威完整内容");
  });

  test("toolcall_start/delta/end 装配工具调用", () => {
    const a = createAssembly();
    applyDelta(a, { type: "toolcall_start", contentIndex: 0, toolCall: { id: "c1", name: "read", arguments: "{}" } });
    applyDelta(a, { type: "toolcall_delta", contentIndex: 0, delta: " 追加参数" });
    applyDelta(a, {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } },
    });
    assert.deepStrictEqual(a.blocks, [
      { kind: "toolCall", text: "", toolCall: { id: "c1", name: "read", arguments: '{"path":"README.md"}' } },
    ]);
  });

  test("toolcall_start 扁平形态（真实 pi）：顶层 id/toolName 装配工具调用", () => {
    const a = createAssembly();
    applyDelta(a, { type: "toolcall_start", contentIndex: 0, id: "call_abc123", toolName: "bash" });
    // 工具名在 start 即已就位（Tool call 兕底根因回归：流式中卡片必须显示工具本名）
    assert.deepStrictEqual(a.blocks[0].toolCall, { id: "call_abc123", name: "bash", arguments: "" });
    applyDelta(a, { type: "toolcall_delta", contentIndex: 0, delta: '{"command":' });
    applyDelta(a, { type: "toolcall_delta", contentIndex: 0, delta: '"ls"}' });
    assert.deepStrictEqual(a.blocks[0].toolCall, { id: "call_abc123", name: "bash", arguments: '{"command":"ls"}' });
    applyDelta(a, {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "call_abc123", name: "bash", arguments: { command: "ls" } },
    });
    assert.deepStrictEqual(a.blocks, [
      { kind: "toolCall", text: "", toolCall: { id: "call_abc123", name: "bash", arguments: '{"command":"ls"}' } },
    ]);
  });

  test("contentIndex 乱序到达也按索引落位", () => {
    const a = createAssembly();
    applyDelta(a, { type: "thinking_start", contentIndex: 3 });
    applyDelta(a, { type: "thinking_delta", contentIndex: 3, delta: "先思考" });
    applyDelta(a, { type: "text_start", contentIndex: 0 });
    applyDelta(a, { type: "text_delta", contentIndex: 0, delta: "后正文" });
    assert.strictEqual(a.blocks.length, 2);
    assert.strictEqual(a.blocks[0].kind, "thinking");
    assert.strictEqual(a.blocks[1].kind, "text");
    assert.strictEqual(a.blocks[1].text, "后正文");
  });

  test("增量不串块：thinking 的 delta 不会追加到 text 块", () => {
    const a = createAssembly();
    applyDelta(a, { type: "text_start", contentIndex: 0 });
    applyDelta(a, { type: "text_delta", contentIndex: 0, delta: "正文" });
    applyDelta(a, { type: "thinking_delta", contentIndex: 1, delta: "思考" });
    assert.strictEqual(a.blocks[0].text, "正文");
    assert.strictEqual(a.blocks[1].text, "思考");
  });
});
