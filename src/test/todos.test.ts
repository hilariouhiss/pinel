import * as assert from "assert";
import { parseTodoNextId, parseTodoTasks, selectRoundTasks, resolveRoundBaseline } from "../chat/todos";

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

suite("parseTodoNextId / selectRoundTasks / resolveRoundBaseline", () => {
  test("nextId 防御解析：合法数字、缺字段、非法值", () => {
    const result = (nextId: unknown) => ({ details: { tasks: [], nextId } });
    assert.strictEqual(parseTodoNextId(result(3)), 3);
    assert.strictEqual(parseTodoNextId({ details: {} }), null);
    assert.strictEqual(parseTodoNextId({ details: { nextId: "x" } }), null);
    assert.strictEqual(parseTodoNextId({ details: { nextId: 0 } }), null);
    assert.strictEqual(parseTodoNextId(null), null);
  });

  test("回合过滤：只保留 id > 基线（旧任务不回显）", () => {
    const tasks = [
      { id: 1, subject: "旧一", status: "completed" as const },
      { id: 2, subject: "旧二", status: "completed" as const },
      { id: 3, subject: "旧三", status: "pending" as const },
      { id: 4, subject: "新一", status: "pending" as const },
    ];
    assert.deepStrictEqual(selectRoundTasks(tasks, 3), [
      { id: 4, subject: "新一", status: "pending" as const },
    ]);
    assert.deepStrictEqual(selectRoundTasks(tasks, 0), tasks);
  });

  test("基线解析：nextId ≤ 基线 → 归零（clear 计数器重置）；否则保持", () => {
    assert.strictEqual(resolveRoundBaseline(3, 5), 3, "单调递增保持");
    assert.strictEqual(resolveRoundBaseline(3, 1), 0, "clear 后归 1 → 基线归零");
    assert.strictEqual(resolveRoundBaseline(0, 1), 0, "首回合基线保持 0");
    assert.strictEqual(resolveRoundBaseline(3, null), 3, "nextId 缺失保持基线");
  });
});
