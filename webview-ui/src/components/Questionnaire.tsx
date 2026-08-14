import { useEffect, useRef, useState } from "react";
import { vscode } from "../index";
import type { QuestionnaireAnswer, QuestionnaireQuestion, QuestionnaireView } from "../types";
import { Markdown } from "./Markdown";

interface Props {
  questionnaire: QuestionnaireView;
  /** 宿主每次广播问卷（含每次答题）都自增：仅作 effect 触发器，不做无条件重算。 */
  focusVersion: number;
}

/** 答案摘要（确认标签 Q&A 行显示）。 */
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

/** 标签文案：header 优先，无 header 用 Q题号。 */
function tabLabel(question: QuestionnaireQuestion, index: number): string {
  return question.header && question.header.trim().length > 0
    ? question.header
    : `Q${index + 1}`;
}

/**
 * 整卷问卷（ask_user_question）——标签式横向切换：
 * - 顶部横向标签栏（header 优先文案 + 已答 ✓ 标记）；确认标签仅在
 *   reviewing/submitting/submitted 阶段渲染
 * - 同一时刻只渲染当前激活题（条件渲染；drafts 在父级 state、答案在宿主权威，无丢失）
 * - 自动切换全部由点击处理器显式驱动：单选选项/自定义答案提交后切下一未答题
 *  （仅当前方存在未答题时前进，最后一题交给跃迁 effect）；多选勾选不切 +
 *   「下一题」按钮；reviewing 阶段修改重答不自动切回确认
 * - 确认标签自动切换仅发生在 answering→reviewing 单一跃迁（prevPhase ref）
 * - 聚焦：activeTab 变化聚焦对应目标；两个 effect 均 firstRun 门控（快照恢复
 *   不抢焦点）+ document.hasFocus 守卫
 * - 容器级 Esc = 放弃整卷（与 TUI 一致；与 Composer 的 Esc 分层）
 */
export function Questionnaire({ questionnaire: q, focusVersion }: Props) {
  const firstUnanswered = q.answers.findIndex((a) => a === null);
  const [activeTab, setActiveTab] = useState<number | "confirm">(() =>
    firstUnanswered >= 0 ? firstUnanswered : "confirm",
  );
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const prevPhase = useRef(q.phase);
  const lastQuestions = useRef(q.questions);
  const firstPhaseRun = useRef(true);
  const firstTabRun = useRef(true);
  /** 下一次 activeTab 变化后的聚焦目标（题 → 首选项；确认 → 确认按钮）。 */
  const pendingFocus = useRef<"question" | "confirm" | null>(null);
  const questionRef = useRef<HTMLDivElement | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

  const answeredCount = q.answers.filter((a) => a !== null).length;
  // 已提交/回填中：锁定答题控件（controller 已忽略入站，避免无反馈的无效点击）
  const locked = q.phase === "submitting" || q.phase === "submitted";
  const showConfirmTab = q.phase !== "answering";
  const activeQuestion =
    typeof activeTab === "number" ? (q.questions[activeTab] ?? null) : null;

  const focusActiveQuestion = () => {
    if (!document.hasFocus()) {
      return; // webview 不可见时不强抢焦点
    }
    const el = questionRef.current;
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

  // 跃迁/重入 effect：仅响应「questions 引用变化（重入替换）」与
  //「answering→reviewing 跃迁」；不得对每次广播无条件重算（否则多选勾选/
  // reviewing 修改会被拽走——H1）。
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = q.phase;
    if (firstPhaseRun.current) {
      firstPhaseRun.current = false;
      return; // 挂载即快照恢复：activeTab 初始值已正确，不抢焦点
    }
    if (q.questions !== lastQuestions.current) {
      // 重入替换新问卷：重置激活标签到首个未答题并聚焦
      lastQuestions.current = q.questions;
      const next = q.answers.findIndex((a) => a === null);
      setActiveTab(next >= 0 ? next : "confirm");
      pendingFocus.current = next >= 0 ? "question" : "confirm";
      return;
    }
    if (prev === "answering" && q.phase === "reviewing") {
      // 最后一题答完：切确认标签 + 聚焦确认按钮
      setActiveTab("confirm");
      pendingFocus.current = "confirm";
    }
    // 其余 phase 变化（reviewing→submitting→submitted）不动 activeTab
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 触发器语义，判定在分支内
  }, [q.phase, focusVersion]);

  // activeTab 变化后的聚焦（首帧跳过：挂载不抢焦点）
  useEffect(() => {
    if (firstTabRun.current) {
      firstTabRun.current = false;
      return;
    }
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === "question") {
      focusActiveQuestion();
    } else if (target === "confirm") {
      if (document.hasFocus()) {
        reviewRef.current?.scrollIntoView({ block: "nearest" });
        reviewRef.current?.querySelector<HTMLElement>("button.qna-confirm")?.focus();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 activeTab 变化时聚焦
  }, [activeTab]);

  const answer = (i: number, a: QuestionnaireAnswer) =>
    vscode.postMessage({ type: "questionnaireAnswer", questionIndex: i, answer: a });
  const confirm = () => vscode.postMessage({ type: "questionnaireConfirm" });
  const cancel = () => vscode.postMessage({ type: "questionnaireCancel" });

  const selectTab = (tab: number | "confirm", focus: "question" | "confirm" | null) => {
    setActiveTab(tab);
    pendingFocus.current = focus;
  };

  /**
   * 完整答案/「下一题」后的自动切换：仅 answering 阶段、且存在下一个未答题时
   * 前进（顺序向后找未答，回绕向前——乱序作答时拉回前方未答题）；
   * 不存在（最后一题）→ 交给跃迁 effect。
   * 不变式：所有 activeTab 写入路径都先写 pendingFocus 再 setActiveTab，
   * 残留值总在消费前被覆盖（同值 setActiveTab 不触发聚焦属有意漏发）。
   */
  const advanceToNext = (current: number) => {
    if (q.phase !== "answering") {
      return;
    }
    let next = q.answers.findIndex((a, j) => j > current && a === null);
    if (next === -1) {
      next = q.answers.findIndex((a, j) => j < current && a === null);
    }
    if (next >= 0) {
      selectTab(next, "question");
    }
  };

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
        {locked ? " · 已提交，等待 Pi 继续…" : ""}
      </div>
      <div className="qna-tabs" role="tablist">
        {q.questions.map((question, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={activeTab === i}
            className={`qna-tab${activeTab === i ? " active" : ""}`}
            onClick={() => selectTab(i, "question")}
          >
            <span className="qna-tab-label">{tabLabel(question, i)}</span>
            {q.answers[i] && <span className="qna-tab-check">✓</span>}
          </button>
        ))}
        {showConfirmTab && (
          <button
            role="tab"
            aria-selected={activeTab === "confirm"}
            className={`qna-tab qna-tab-confirm${activeTab === "confirm" ? " active" : ""}`}
            onClick={() => selectTab("confirm", "confirm")}
          >
            确认
          </button>
        )}
      </div>
      {activeQuestion ? (
        <QuestionCard
          question={activeQuestion}
          answer={q.answers[activeTab as number]}
          draft={drafts[activeTab as number] ?? ""}
          locked={locked}
          onDraftChange={(text) =>
            setDrafts((prev) => ({ ...prev, [activeTab as number]: text }))
          }
          onAnswer={(a, advance) => {
            answer(activeTab as number, a);
            if (advance) {
              advanceToNext(activeTab as number);
            }
          }}
          showNext={q.phase === "answering"}
          onNext={() => advanceToNext(activeTab as number)}
          refCallback={(el) => {
            questionRef.current = el;
          }}
        />
      ) : (
        <div className="qna-review" ref={reviewRef}>
          <div className="qna-review-title">
            {q.phase === "reviewing" ? "请确认你的回答（可修改后提交）" : "你的回答"}
          </div>
          {q.questions.map((question, i) => (
            <div key={i} className="qna-review-row">
              <span className="qna-review-q">{question.question}</span>
              <span className="qna-review-a">{answerSummary(question, q.answers[i])}</span>
              {q.phase === "reviewing" && (
                <button
                  className="uidialog-btn uidialog-btn-ghost"
                  onClick={() => selectTab(i, "question")}
                >
                  修改
                </button>
              )}
            </div>
          ))}
          {q.phase === "reviewing" && (
            <div className="qna-review-actions">
              <button className="uidialog-btn uidialog-btn-primary qna-confirm" onClick={confirm}>
                确认提交
              </button>
              <button className="uidialog-btn uidialog-btn-ghost" onClick={cancel}>
                取消问卷
              </button>
            </div>
          )}
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
  showNext,
  onDraftChange,
  onAnswer,
  onNext,
  refCallback,
}: {
  question: QuestionnaireQuestion;
  answer: QuestionnaireAnswer | null;
  draft: string;
  locked: boolean;
  /** 是否渲染「下一题」按钮（仅 answering 阶段；reviewing 下跳转由标签承担）。 */
  showNext: boolean;
  onDraftChange: (text: string) => void;
  /** advance 控制答题后是否自动切下一题（单选/自定义 true，多选勾选 false）。 */
  onAnswer: (a: QuestionnaireAnswer, advance: boolean) => void;
  onNext: () => void;
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
              onClick={() => {
                if (question.multiSelect) {
                  // 多选勾选不自动切题（防选到一半被跳走），由「下一题」按钮切走
                  onAnswer(
                    {
                      kind: "multi",
                      optionIndices: selected
                        ? selectedMulti.filter((x) => x !== oi)
                        : [...selectedMulti, oi],
                    },
                    false,
                  );
                } else {
                  onAnswer({ kind: "option", optionIndex: oi }, true);
                }
              }}
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
          onClick={() => onAnswer({ kind: "custom", text: draft }, true)}
        >
          使用自定义答案
        </button>
      </div>
      {question.multiSelect && showNext && (
        <div className="qna-next-row">
          <button className="uidialog-btn uidialog-btn-ghost qna-next" disabled={locked} onClick={onNext}>
            下一题 →
          </button>
        </div>
      )}
    </div>
  );
}
