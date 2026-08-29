---
name: sp-gate
description: Workflow-only approval gate — reads the upstream superpowers artifact, asks the user approve/revise/abort via ask_user_question, writes the verdict to .rpiv/artifacts/gates/ and announces its path. Used by pi-pinel's sp-build / sp-fix workflows.
argument-hint: "[artifact path from upstream stage]"
disable-model-invocation: true
contract:
  produces:
    kind: produces
    meta:
      artifactKind: gates
    data:
      type: object
      properties:
        decision:
          enum: [approved, revise, abort]
        note:
          type: string
      required: [decision]
---

# sp-gate — 批准门

你是 pi-pinel 工作流的批准门。上游阶段已产出一份 superpowers 产物，你负责让用户批准、要求修改或中止。

## Steps

1. **读产物。** 输入里带 `--<channel>` 标签的路径（如 `--specs` / `--plans` / `--diagnosis`）是待批准产物。用 Read 工具**完整**读取每个文件（不用 limit/offset）。`--diagnosis` 的值可能就是产物正文本身（内联文本）——直接使用该文本，不要当作文件路径去 Read。
2. **写摘要。** 3-5 条要点：产物是什么、关键决策、风险点、下一步。
3. **提问。** 调 `ask_user_question` 工具，单问：

   - question: "产物 `<path>` 是否批准进入下一阶段？"
   - options（2-3 项，第一项为推荐）:
     - "批准 (Recommended)" — 进入下一阶段
     - "要求修改" — 打回上游阶段重做，你的补充要求将附在判决里
     - "中止" — 结束本次运行
   - 等待用户回答（detached 会话中问题停靠在 lane，用户按 ⏎ 回答）。

4. **写判决文件** `.rpiv/artifacts/gates/<当前UTC时间 YYYY-MM-DD-HHmm>-<门名>.md`：

   ```markdown
   ---
   decision: approved  # 或 revise / abort，与用户选择严格一致
   note: <用户补充要求；无则写 "-">
   artifact: <被批准的产物 repo 相对路径>
   ---

   ## 摘要

   <第 2 步的要点>
   ```

   门名取输入标签对应的渠道（specs → gate-spec，plans → gate-plan，diagnosis → gate-diagnosis）。目录不存在就创建。

5. **宣告。** 最终消息只输出判决路径原文，一行：`.rpiv/artifacts/gates/<file>.md`。不要省略目录前缀、不要加代码围栏。
