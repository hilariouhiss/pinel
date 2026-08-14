import { useEffect, useRef, useState } from "react";
import { vscode } from "../index";
import type { QuestionnaireAnswer, QuestionnaireQuestion, QuestionnaireView } from "../types";
import { Markdown } from "./Markdown";

interface Props {
  questionnaire: QuestionnaireView;
  /** 宿主每次推送新问卷（非快照）时自增：同阶段重入替换也触发重新聚焦。 */
  focusVersion: number;
}

/** 答案摘要（确认面板行显示）。 */
function answerSummary(question: QuestionnaireQuestion, answer: QuestionnaireAnswer | null): string {
  if (!answer) {
    return "（未回答）";
  }
  if (answer.kind === "custom") {
    return `自定义：${answer.text}`;
  }
  if (answer.kind === "option") {
    return question.options[answer.optionIndex]?.label ?? "（无）";
  }
  const labels = answer.optionIndices
    .map((i) => question.options[i]?.label ?? "")
    .filter((l) => l.length > 0);
  return labels.length > 0 ? labels.join("、") : "（未选择）";
}

/**
 * 整卷问卷（ask_user_question）：
 * - 题目一次性本地渲染（pi 的串行对话框由宿主缓冲/回填，不展示）
 * - 答完最后一题 → 确认面板（可「修改」任一题重答）→ 确认提交/取消问卷
 * - 容器级 Esc = 放弃整卷（与 TUI 一致；与 Composer 的 Esc 分层）
 * - 阶段变化自动聚焦：answering → 首个未答题；reviewing → 确认按钮
 */
export function Questionnaire({ questionnaire: q, focusVersion }: Props) {
  const questionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const reviewRef = useRef<HTMLDivElement>(null);
  const firstRun = useRef(true);
  // 每题的「自定义答案」草稿
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const answeredCount = q.answers.filter((a) => a !== null).length;
  // 已提交/回填中：锁定答题控件（controller 已忽略入站，避免无反馈的无效点击）
  const locked = q.phase === "submitting" || q.phase === "submitted";

  const focusQuestion = (index: number) => {
    if (!document.hasFocus()) {
      return; // webview 不可见时不强抢焦点
    }
    const el = questionRefs.current[index];
    if (!el) {
      return;
    }
    el.scrollIntoView({ block: "nearest" });
    const target =
      el.querySelector<HTMLElement>("button.qna-option") ??
      el.querySelector<HTMLElement>("input");
    target?.focus();
  };

  // 新问卷替换旧问卷：清空草稿（题目引用变化即重入）
  useEffect(() => {
    setDrafts({});
  }, [q.questions]);

  // 阶段变化/新问卷推送聚焦：answering → 首个未答题；reviewing → 确认按钮。
  // 首帧跳过（挂载即快照恢复，不抢焦点）；focusVersion 覆盖同阶段重入替换。
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (q.phase === "answering") {
      const firstUnanswered = q.answers.findIndex((a) => a === null);
      if (firstUnanswered >= 0) {
        focusQuestion(firstUnanswered);
      }
    } else if (q.phase === "reviewing") {
      reviewRef.current?.scrollIntoView({ block: "nearest" });
      reviewRef.current?.querySelector<HTMLElement>("button.qna-confirm")?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅阶段变化/新问卷推送时聚焦
  }, [q.phase, focusVersion]);

  const answer = (i: number, a: QuestionnaireAnswer) =>
    vscode.postMessage({ type: "questionnaireAnswer", questionIndex: i, answer: a });
  const confirm = () => vscode.postMessage({ type: "questionnaireConfirm" });
  const cancel = () => vscode.postMessage({ type: "questionnaireCancel" });

  return (
    <div
      className="qna"
      onKeyDown={(e) => {
        // 容器级 Esc = 放弃整卷（选项按钮/输入框聚焦时 keydown 冒泡到此）
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div className="qna-head">
        提问问卷（已答 {answeredCount}/{q.questions.length}）
        {q.phase === "submitting" || q.phase === "submitted" ? " · 已提交，等待 Pi 继续…" : ""}
      </div>
      {q.questions.map((question, i) => (
        <QuestionCard
          key={i}
          question={question}
          answer={q.answers[i]}
          draft={drafts[i] ?? ""}
          locked={locked}
          onDraftChange={(text) => setDrafts((prev) => ({ ...prev, [i]: text }))}
          onAnswer={(a) => answer(i, a)}
          refCallback={(el) => {
            questionRefs.current[i] = el;
          }}
        />
      ))}
      {q.phase === "reviewing" && (
        <div className="qna-review" ref={reviewRef}>
          <div className="qna-review-title">请确认你的回答（可修改后提交）</div>
          {q.questions.map((question, i) => (
            <div key={i} className="qna-review-row">
              <span className="qna-review-q">{question.question}</span>
              <span className="qna-review-a">{answerSummary(question, q.answers[i])}</span>
              <button className="uidialog-btn uidialog-btn-ghost" onClick={() => focusQuestion(i)}>
                修改
              </button>
            </div>
          ))}
          <div className="qna-review-actions">
            <button className="uidialog-btn uidialog-btn-primary qna-confirm" onClick={confirm}>
              确认提交
            </button>
            <button className="uidialog-btn uidialog-btn-ghost" onClick={cancel}>
              取消问卷
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  question,
  answer,
  draft,
  locked,
  onDraftChange,
  onAnswer,
  refCallback,
}: {
  question: QuestionnaireQuestion;
  answer: QuestionnaireAnswer | null;
  draft: string;
  locked: boolean;
  onDraftChange: (text: string) => void;
  onAnswer: (a: QuestionnaireAnswer) => void;
  refCallback: (el: HTMLDivElement | null) => void;
}) {
  const selectedIndex = answer?.kind === "option" ? answer.optionIndex : -1;
  const selectedMulti = answer?.kind === "multi" ? answer.optionIndices : [];
  const selectedPreview =
    answer?.kind === "option" ? question.options[answer.optionIndex]?.preview : undefined;

  return (
    <div className="qna-question" ref={refCallback}>
      <div className="qna-question-title">
        {question.header && <span className="qna-question-header">[{question.header}]</span>}
        <Markdown content={question.question} />
      </div>
      <div className="qna-options">
        {question.options.map((opt, oi) => {
          const selected = question.multiSelect ? selectedMulti.includes(oi) : selectedIndex === oi;
          return (
            <button
              key={oi}
              className={`qna-option${selected ? " selected" : ""}`}
              disabled={locked}
              onClick={() =>
                onAnswer(
                  question.multiSelect
                    ? {
                        kind: "multi",
                        optionIndices: selected
                          ? selectedMulti.filter((x) => x !== oi)
                          : [...selectedMulti, oi],
                      }
                    : { kind: "option", optionIndex: oi },
                )
              }
            >
              {question.multiSelect && (
                <span className="qna-check">{selected ? "☑" : "☐"}</span>
              )}
              <span className="qna-option-label">{opt.label}</span>
              {opt.description && <span className="qna-option-desc">{opt.description}</span>}
            </button>
          );
        })}
      </div>
      {selectedPreview && (
        <details className="qna-preview">
          <summary>选项预览</summary>
          <Markdown content={selectedPreview} />
        </details>
      )}
      <div className="qna-custom">
        <input
          className="uidialog-input"
          value={draft}
          placeholder="或输入自定义答案（Type something）"
          disabled={locked}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <button
          className="uidialog-btn"
          disabled={locked || draft.trim().length === 0}
          onClick={() => onAnswer({ kind: "custom", text: draft })}
        >
          使用自定义答案
        </button>
      </div>
    </div>
  );
}
