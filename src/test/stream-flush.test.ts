import * as assert from "assert";
import { StreamFlushThrottle } from "../chat/stream-flush";
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
