# Task for reviewer

评审一份 VS Code 扩展仓库的初始化计划。这是只读评审，不要修改任何文件。

计划文件：C:/source_code/Other/pinel/.pi/plans/init-vscode-extension.md（先完整读取）

背景：目标仓库 C:/source_code/Other/pinel 是全新空 git 仓库。用户要为 Pi 编码智能体（@earendil-works/pi-coding-agent）开发一个类似 Claude Code 官方插件的 VS Code 扩展。已确认的决策：RPC 子进程集成（spawn `pi --mode rpc`，JSONL over stdio）、v0.1 仅核心聊天体验（副侧边栏面板 + 流式渲染 + Esc 中断 + 图片附件）、使用微软官方 generator-code 脚手架。

权威协议资料（如需核对协议细节可读取）：
- Pi RPC 协议文档：C:/Users/xueyu/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md
- Pi SDK 文档：C:/Users/xueyu/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md

评审重点（逐项检查并给出具体结论，不要泛泛而谈）：
1. 遗漏：计划是否缺少 v0.1 范围内的必要步骤/文件/边界处理？（例如 RPC 协议细节、VS Code API 限制、进程生命周期、webview 安全等）
2. 协议正确性：计划中引用的 RPC 命令/事件（prompt/steer/abort/get_state/get_available_models/get_messages、framing 规则、images 格式）与 rpc.md 是否一致？如有出入指出。
3. 歧义：任务拆解是否可直接执行？哪些步骤缺少明确的验收标准或技术细节？
4. 边界问题：Windows spawn .cmd shim、多工作区、会话持久化、pi 崩溃恢复等风险是否遗漏或缓解不足？
5. 任务顺序与依赖：任务拆解的先后顺序是否合理？

输出格式：按发现的问题逐条列出（每条：问题类别/位置/具体问题/建议修改），最后给出总体结论（可通过 / 需修订）。不要重写整个计划。

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```