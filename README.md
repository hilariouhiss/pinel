# @hilariouhiss/pinel — Pinel 桥 + superpowers×rpiv-workflow 集成包

## 它是什么

两部分：
1. Pinel VS Code 面板桥（原有）：PINEL_PLUGIN=1 的 rpc 会话里推送会话状态/消息树。
2. superpowers × rpiv-workflow 集成（新增）：三条内置 /wf 工作流，把 superpowers
   技能编排成可停靠、可恢复的多阶段流水线；运行状态推送到 Pinel 面板。

## 安装

pi install <本包路径或 npm 源>
pi install git:github.com/obra/superpowers@v6.3.0   # 工作流按名引用这些技能
# rpiv-pi / rpiv-workflow / rpiv-ask-user-question 等随本包依赖自动安装
# 重启 pi

## 用法

/wf sp-build "给 export 命令加 --json 标志"   # 构建流程（默认工作流）
/wf sp-fix  "<bug 症状描述>"                    # 调试流程
/wf sp-review "<评审上下文>"                    # 评审流程

### 批准门（停靠提问）

gate-* 阶段会读上游产物（docs/superpowers/specs|plans/ 或诊断捕获），然后调
ask_user_question 提问。detached 运行中问题停靠在 lane 上——ctrl+q 打开 lane dock，
⏎ 内联回答：批准 / 要求修改（打回上游阶段重做）/ 中止。

### 产物布局

- superpowers 技能照常写 docs/superpowers/specs/ 与 docs/superpowers/plans/
- 门禁判决写 .rpiv/artifacts/gates/（frontmatter decision: approved|revise|abort）
- 运行轨迹 .rpiv/workflows/runs/<run-id>.jsonl；/wf @<run-id> 随时恢复

### 自定义

- 换执行方式（subagent-driven-development 需已装 pi-subagents）：
  项目 .rpiv/workflows/config.ts 里 skillAliases: { "executing-plans": "subagent-driven-development" }
- 覆盖内置工作流：项目 config.ts 里同名 defineWorkflow（合并层高于内置层）

### Pinel 面板 payload 契约（v:1）

pinel.workflow 状态行 / pinel.workflows 挂件，JSON：
{ v:1, runId, workflow, totalStages, status: running|awaiting-approval|done|failed, stage?, stageNumber?, message? }

### 排障

- /wf 报技能缺失：superpowers 未装或版本无该技能 → 装 git:github.com/obra/superpowers@v6.3.0
- 阶段卡在停靠提问没人答：ctrl+q 打开 lane dock 按 ⏎
- 门禁产物收集失败：模型宣告路径不含 docs/superpowers 前缀或文件没写盘 → 看 run JSONL 与 stage 转写
