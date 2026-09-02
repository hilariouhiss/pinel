import * as assert from "assert";
import { KeyedFlushThrottle, StreamFlushThrottle } from "../chat/stream-flush";
import type { StreamBlock } from "../chat/stream-assembly";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite("流式广播节流单元测试", () => {
  test("窗口内多次 push 只 flush 一次（尾部最新块）", async () => {
    const flushed: StreamBlock[][] = [];
    const throttle = new StreamFlushThrottle(20, (blocks) => flushed.push(blocks));
    const blocks1: StreamBlock[] = [{ kind: "text", text: "你" }];
    const blocks2: StreamBlock[] = [{ kind: "text", text: "你好" }];
    throttle.push(blocks1);
    await sleep(5);
    throttle.push(blocks2); // 窗口内第二次：仅更新内容
    await sleep(40);
    assert.strictEqual(flushed.length, 1, "窗口内必须合并为单次 flush");
    assert.strictEqual(flushed[0], blocks2, "flush 必须携带最新块引用");
  });

  test("窗口后再 push 触发新一次 flush（节奏持续）", async () => {
    const flushed: StreamBlock[][] = [];
    const throttle = new StreamFlushThrottle(10, (blocks) => flushed.push(blocks));
    throttle.push([{ kind: "text", text: "一" }]);
    await sleep(30);
    throttle.push([{ kind: "text", text: "二" }]);
    await sleep(30);
    assert.strictEqual(flushed.length, 2, "两个窗口各 flush 一次");
  });

  test("cancel 阻止待决 flush（重置路径防陈旧块迟到）", async () => {
    const flushed: StreamBlock[][] = [];
    const throttle = new StreamFlushThrottle(10, (blocks) => flushed.push(blocks));
    throttle.push([{ kind: "text", text: "旧" }]);
    throttle.cancel();
    await sleep(30);
    assert.strictEqual(flushed.length, 0, "cancel 后不得 flush");
  });
});

suite("按键尾沿节流单元测试", () => {
  test("窗口内同键多次 push 只 flush 一次（最新值），异键各留最新", async () => {
    const flushed: ReadonlyMap<string, string>[] = [];
    const throttle = new KeyedFlushThrottle<string>(20, (latest) => flushed.push(latest));
    throttle.push("a", "v1");
    await sleep(5);
    throttle.push("a", "v2"); // 同键覆盖
    throttle.push("b", "w1");
    await sleep(40);
    assert.strictEqual(flushed.length, 1, "窗口内必须合并为单次 flush");
    assert.strictEqual(flushed[0].get("a"), "v2", "同键必须携带最新值");
    assert.strictEqual(flushed[0].get("b"), "w1", "异键各自保留最新值");
  });

  test("窗口后再 push 触发新一次 flush", async () => {
    const flushed: ReadonlyMap<string, string>[] = [];
    const throttle = new KeyedFlushThrottle<string>(10, (latest) => flushed.push(latest));
    throttle.push("a", "v1");
    await sleep(30);
    throttle.push("a", "v2");
    await sleep(30);
    assert.strictEqual(flushed.length, 2, "两个窗口各 flush 一次");
  });

  test("cancel 丢弃待决 flush 与记忆（重置路径防陈旧值迟到）", async () => {
    const flushed: ReadonlyMap<string, string>[] = [];
    const throttle = new KeyedFlushThrottle<string>(10, (latest) => flushed.push(latest));
    throttle.push("a", "v1");
    throttle.cancel();
    await sleep(30);
    assert.strictEqual(flushed.length, 0, "cancel 后不得 flush");
    throttle.push("a", "v2"); // cancel 后重新 push 必须能正常 flush（记忆已清）
    await sleep(30);
    assert.strictEqual(flushed.length, 1, "cancel 后重新 push 正常");
    assert.strictEqual(flushed[0].get("a"), "v2");
  });

  test("空窗口不触发 flush 回调", async () => {
    // flush 只在有值时才被调用：push 后 cancel、再等窗口过期，不得调用回调
    let called = 0;
    const throttle = new KeyedFlushThrottle<string>(10, () => {
      called++;
    });
    throttle.push("a", "v1");
    throttle.cancel();
    await sleep(30);
    assert.strictEqual(called, 0);
  });
});
