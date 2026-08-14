import * as assert from "assert";
import {
  inputResponseFor,
  parseQuestionnaireAnswer,
  parseQuestionnaireArgs,
  selectResponseFor,
  titleMatchesQuestion,
} from "../chat/questionnaire";

suite("parseQuestionnaireArgs 单元测试", () => {
  test("合法参数：解析题目/选项/多选/header（忽略多余字段）", () => {
    const args = {
      questions: [
        {
          question: "问题一？",
          header: "q1",
          options: [
            { label: "A", description: "选项 A", preview: "预览 A" },
            { label: "B", description: "选项 B" },
          ],
          extra: "ignored",
        },
        {
          question: "问题二？",
          header: "q2",
          options: [
            { label: "X", description: "选项 X" },
            { label: "Y", description: "选项 Y" },
          ],
          multiSelect: true,
        },
      ],
    };
    const questions = parseQuestionnaireArgs(args);
    assert.ok(questions, "必须解析成功");
    assert.strictEqual(questions!.length, 2);
    assert.strictEqual(questions![0].question, "问题一？");
    assert.strictEqual(questions![0].header, "q1");
    assert.strictEqual(questions![0].multiSelect, false);
    assert.strictEqual(questions![0].options[0].preview, "预览 A");
    assert.strictEqual(questions![1].multiSelect, true);
  });

  test("结构不符 → null", () => {
    assert.strictEqual(parseQuestionnaireArgs(undefined), null);
    assert.strictEqual(parseQuestionnaireArgs(null), null);
    assert.strictEqual(parseQuestionnaireArgs("str"), null);
    assert.strictEqual(parseQuestionnaireArgs({}), null);
    assert.strictEqual(parseQuestionnaireArgs({ questions: "not-array" }), null);
    assert.strictEqual(parseQuestionnaireArgs({ questions: [] }), null);
  });

  test("部分条目损坏：跳过坏题目/坏选项保留好条目；全部无效 → null", () => {
    const args = {
      questions: [
        { question: "", options: [{ label: "A" }] }, // 缺题面
        42, // 非对象
        {
          question: "有效题",
          options: [{ label: "A" }, { label: "" }, null], // 坏选项跳过
        },
      ],
    };
    const questions = parseQuestionnaireArgs(args);
    assert.deepStrictEqual(questions, [
      { question: "有效题", options: [{ label: "A" }], multiSelect: false },
    ]);
    assert.strictEqual(parseQuestionnaireArgs({ questions: [{ question: "", options: [] }] }), null);
  });
});

suite("parseQuestionnaireAnswer 单元测试", () => {
  const question = {
    question: "题？",
    options: [{ label: "A" }, { label: "B" }, { label: "C" }],
    multiSelect: false,
  };

  test("合法回答", () => {
    assert.deepStrictEqual(parseQuestionnaireAnswer({ kind: "option", optionIndex: 1 }, question), {
      kind: "option",
      optionIndex: 1,
    });
    assert.deepStrictEqual(
      parseQuestionnaireAnswer({ kind: "multi", optionIndices: [2, 0, 2] }, question),
      { kind: "multi", optionIndices: [2, 0] }, // 去重
    );
    assert.deepStrictEqual(parseQuestionnaireAnswer({ kind: "custom", text: "自己写" }, question), {
      kind: "custom",
      text: "自己写",
    });
  });

  test("非法回答 → null", () => {
    assert.strictEqual(parseQuestionnaireAnswer(undefined, question), null);
    assert.strictEqual(parseQuestionnaireAnswer("str", question), null);
    assert.strictEqual(parseQuestionnaireAnswer({ kind: "option", optionIndex: 3 }, question), null);
    assert.strictEqual(parseQuestionnaireAnswer({ kind: "option", optionIndex: -1 }, question), null);
    assert.strictEqual(parseQuestionnaireAnswer({ kind: "option", optionIndex: "x" }, question), null);
    assert.strictEqual(
      parseQuestionnaireAnswer({ kind: "multi", optionIndices: [0, 9] }, question),
      null,
    );
    assert.strictEqual(parseQuestionnaireAnswer({ kind: "multi", optionIndices: "bad" }, question), null);
    assert.strictEqual(parseQuestionnaireAnswer({ kind: "custom", text: "" }, question), null);
    assert.strictEqual(parseQuestionnaireAnswer({ kind: "custom", text: 42 }, question), null);
    assert.strictEqual(parseQuestionnaireAnswer({ kind: "weird" }, question), null);
  });
});

suite("回填映射单元测试", () => {
  const single = {
    question: "单选？",
    options: [{ label: "A" }, { label: "B" }],
    multiSelect: false,
  };
  const multi = {
    question: "多选？",
    options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
    multiSelect: true,
  };
  const options = ["1. A — desc", "2. B — desc", "3. Type something."];

  test("select 帧：答选项回原行；答自定义回哨兵行 + 跟进标记", () => {
    assert.deepStrictEqual(selectResponseFor(single, { kind: "option", optionIndex: 1 }, options), {
      value: "2. B — desc",
      needsFollowup: false,
    });
    assert.deepStrictEqual(selectResponseFor(single, { kind: "custom", text: "自己写" }, options), {
      value: "3. Type something.",
      needsFollowup: true,
    });
  });

  test("select 帧防御：无答案/越界/空 options/多选答案 → null", () => {
    assert.strictEqual(selectResponseFor(single, null, options), null);
    assert.strictEqual(selectResponseFor(single, { kind: "option", optionIndex: 2 }, options), null);
    assert.strictEqual(selectResponseFor(single, { kind: "option", optionIndex: 0 }, []), null);
    assert.strictEqual(selectResponseFor(single, { kind: "multi", optionIndices: [0] }, options), null);
  });

  test("input 帧：多选回 1 基升序数字串/空串；自定义回文本；单选项 → null", () => {
    assert.strictEqual(inputResponseFor(multi, { kind: "multi", optionIndices: [2, 0] }), "1,3");
    assert.strictEqual(inputResponseFor(multi, { kind: "multi", optionIndices: [] }), "");
    assert.strictEqual(inputResponseFor(multi, { kind: "custom", text: "手写" }), "手写");
    assert.strictEqual(inputResponseFor(multi, null), null);
    assert.strictEqual(inputResponseFor(single, { kind: "option", optionIndex: 0 }), null);
  });

  test("标题归属：题面/header 子串命中", () => {
    const q = { question: "问题一？", header: "q1", options: [], multiSelect: false };
    assert.strictEqual(titleMatchesQuestion("[q1] 问题一？", q), true);
    assert.strictEqual(titleMatchesQuestion("问题一？\n\nType your answer:", q), true);
    assert.strictEqual(titleMatchesQuestion("另一个问题", q), false);
    assert.strictEqual(titleMatchesQuestion(undefined, q), false);
  });
});
