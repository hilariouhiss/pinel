import { useEffect, useRef, useState } from "react";
import checkSquareIcon from "lucide-static/icons/check-square.svg";
import squareIcon from "lucide-static/icons/square.svg";
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
    return "Unanswered";
  }
  if (answer.kind === "custom") {
    return `Custom: ${answer.text}`;
  }
  if (answer.kind === "option") {
    return question.options[answer.optionIndex]?.label ?? "None";
  }
  const labels = answer.optionIndices
    .map((i) => question.options[i]?.label ?? "")
    .filter((l) => l.length > 0);
  return labels.length > 0 ? labels.join(", ") : "None selected";
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
 * - 重入判定按问卷实例 id 比较（postMessage 结构化克隆使 questions 引用比较
 *   恒为真——每次广播都会误判重入，多选勾选后被拽到首个未答题）
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
  const lastQuestionnaireId = useRef<string | null>(null);
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

  // 新问卷替换旧问卷：清空草稿（问卷实例 id 变化即重入）
  useEffect(() => {
    setDrafts({});
  }, [q.id]);

  // 跃迁/重入 effect：仅响应「问卷实例 id 变化（重入替换）」与
  //「answering→reviewing 跃迁」；不得对每次广播无条件重算（否则多选勾选/
  // reviewing 修改会被拽走——H1）。
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = q.phase;
    if (firstPhaseRun.current) {
      firstPhaseRun.current = false;
      lastQuestionnaireId.current = q.id; // 挂载即快照恢复：同 id 后续广播不重置
      return;
    }
    if (q.id !== lastQuestionnaireId.current) {
      // 重入替换新问卷：更新 id 并重置激活标签到首个未答题 + 聚焦
      lastQuestionnaireId.current = q.id;
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

  // 提交后（提交中/已提交）：收起为一行状态条。用户交互已完成，剩余帧由宿主
  // 自动回填，无需展示题卡/确认区；不带容器级 Esc（提交后取消无意义，且防
  // 误触把 walker 后续帧甩入逐卡路径）。App 按 qnaFlowIndex 将其插入消息流
  // 原位——后续消息（toolResult/流式回复）落在其下方，随消息流上移。
  if (q.phase === "submitting" || q.phase === "submitted") {
    return (
      <div className="qna qna-collapsed">
        <span className="qna-collapsed-check">✓</span>
        Questionnaire answered
      </div>
    );
  }

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
        <div>
          Questionnaire
          {locked ? " · Submitted, waiting for Pi…" : ""}
        </div>
        <div
          className="qna-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={q.questions.length}
          aria-valuenow={answeredCount}
        >
          {/* 分段进度条：每题一段，已答段高亮（乱序作答按实际位置逐段判断） */}
          {q.questions.map((_, i) => (
            <span
              key={i}
              className={`qna-progress-seg${q.answers[i] !== null ? " filled" : ""}`}
            />
          ))}
        </div>
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
            Confirm
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
            {q.phase === "reviewing" ? "Please confirm your answers (edit before submit)" : "Your answers"}
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
                  Edit
                </button>
              )}
            </div>
          ))}
          {q.phase === "reviewing" && (
            <div className="qna-review-actions">
              <button className="uidialog-btn uidialog-btn-primary qna-confirm" onClick={confirm}>
                Submit
              </button>
              <button className="uidialog-btn uidialog-btn-ghost" onClick={cancel}>
                Cancel
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
              <span className="qna-option-row">
                {question.multiSelect && (
                  <span
                    className="qna-check"
                    dangerouslySetInnerHTML={{ __html: selected ? checkSquareIcon : squareIcon }}
                  />
                )}
                <span className="qna-option-label">{opt.label}</span>
              </span>
              {opt.description && <span className="qna-option-desc">{opt.description}</span>}
            </button>
          );
        })}
      </div>
      {selectedPreview && (
        <details className="qna-preview">
          <summary>Option preview</summary>
          <Markdown content={selectedPreview} />
        </details>
      )}
      <div className="qna-custom">
        <input
          className="uidialog-input"
          value={draft}
          placeholder="Or type a custom answer"
          disabled={locked}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        <button
          className="uidialog-btn"
          disabled={locked || draft.trim().length === 0}
          onClick={() => onAnswer({ kind: "custom", text: draft }, true)}
        >
          Custom
        </button>
      </div>
      {question.multiSelect && showNext && (
        <div className="qna-next-row">
          <button className="uidialog-btn uidialog-btn-ghost qna-next" disabled={locked} onClick={onNext}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
