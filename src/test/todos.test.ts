import * as assert from "assert";
import { parseTodoTasks } from "../chat/todos";

suite("parseTodoTasks 单元测试", () => {
  test("create 快照：解析全量任务列表", () => {
    const result = {
      content: [{ type: "text", text: "Created #2: 任务二 (pending)" }],
      details: {
        action: "create",
        params: { action: "create", subject: "任务二", description: "第二个任务" },
        tasks: [
          { id: 1, subject: "任务一", status: "pending", description: "第一个任务" },
          { id: 2, subject: "任务二", status: "pending", description: "第二个任务" },
        ],
        nextId: 3,
      },
    };
    const tasks = parseTodoTasks(result);
    assert.deepStrictEqual(tasks, [
      { id: 1, subject: "任务一", status: "pending", description: "第一个任务" },
      { id: 2, subject: "任务二", status: "pending", description: "第二个任务" },
    ]);
  });

  test("update 快照：含 activeForm 与状态变更", () => {
    const result = {
      details: {
        action: "update",
        params: { action: "update", id: 2, status: "in_progress", activeForm: "执行任务二" },
        tasks: [
          { id: 1, subject: "任务一", status: "pending" },
          { id: 2, subject: "任务二", status: "in_progress", activeForm: "执行任务二" },
        ],
        nextId: 3,
      },
    };
    const tasks = parseTodoTasks(result);
    assert.ok(tasks, "必须解析成功");
    assert.strictEqual(tasks![1].status, "in_progress");
    assert.strictEqual(tasks![1].activeForm, "执行任务二");
  });

  test("结构不符 → null：缺 details / tasks 非数组 / 非空全损坏；空数组 → []（合法空快照）", () => {
    assert.strictEqual(parseTodoTasks(undefined), null);
    assert.strictEqual(parseTodoTasks(null), null);
    assert.strictEqual(parseTodoTasks("str"), null);
    assert.strictEqual(parseTodoTasks({}), null);
    assert.strictEqual(parseTodoTasks({ details: {} }), null);
    assert.strictEqual(parseTodoTasks({ details: { tasks: "not-array" } }), null);
    // 空数组 = 用户删光任务的合法快照 → 清空面板
    assert.deepStrictEqual(parseTodoTasks({ details: { tasks: [] } }), []);
    // 非空但全部损坏 = 数据可疑 → 保留旧状态
    assert.strictEqual(
      parseTodoTasks({ details: { tasks: [{ id: "x" }, { nope: true }, 42] } }),
      null,
    );
  });

  test("部分条目损坏：跳过坏条目保留好条目", () => {
    const result = {
      details: {
        tasks: [
          { id: 1, subject: "好的", status: "pending" },
          { id: "bad", subject: 2, status: "pending" },
          42,
          { id: 3, subject: "也好", status: "completed", activeForm: "完成" },
        ],
      },
    };
    const tasks = parseTodoTasks(result);
    assert.deepStrictEqual(tasks, [
      { id: 1, subject: "好的", status: "pending" },
      { id: 3, subject: "也好", status: "completed", activeForm: "完成" },
    ]);
  });

  test("未知 status 值：该条目跳过", () => {
    const result = {
      details: {
        tasks: [
          { id: 1, subject: "有效", status: "pending" },
          { id: 2, subject: "无效状态", status: "weird" },
        ],
      },
    };
    const tasks = parseTodoTasks(result);
    assert.deepStrictEqual(tasks, [{ id: 1, subject: "有效", status: "pending" }]);
  });
});
