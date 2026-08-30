import * as assert from "assert";
import { parseBashInput } from "../chat/bash";

suite("! / !! 终端命令前缀解析", () => {
  test("! 前缀：命令进 LLM 上下文", () => {
    assert.deepStrictEqual(parseBashInput("!ls"), { command: "ls", excludeFromContext: false });
    assert.deepStrictEqual(parseBashInput("! npm test"), {
      command: "npm test",
      excludeFromContext: false,
    });
  });

  test("!! 前缀：只执行不送 LLM", () => {
    assert.deepStrictEqual(parseBashInput("!!git status"), {
      command: "git status",
      excludeFromContext: true,
    });
    assert.deepStrictEqual(parseBashInput("!!  pwd"), {
      command: "pwd",
      excludeFromContext: true,
    });
  });

  test("空命令不劫持（! / !! 单独出现视为普通消息）", () => {
    assert.strictEqual(parseBashInput("!"), null);
    assert.strictEqual(parseBashInput("!!"), null);
    assert.strictEqual(parseBashInput("!   "), null);
  });

  test("非前缀开头 → null（普通消息路径）", () => {
    assert.strictEqual(parseBashInput("hello !world"), null);
    assert.strictEqual(parseBashInput("！ls"), null); // 全角感叹号不识别
    assert.strictEqual(parseBashInput(""), null);
  });
});
