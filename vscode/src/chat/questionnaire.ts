/**
 * ask_user_question 问卷的防御解析与回填映射（纯函数，无 vscode 依赖）。
 *
 * 背景（实测插件 @juicesharp/rpiv-ask-user-question 的 rpc-fallback.ts）：
 * - 插件在 RPC 模式逐题串行走 ctx.ui.select()/ctx.ui.input()，每题阻塞等待回复；
 *   已提交的回复被 pi 消费后不可撤回。
 * - 但 tool_execution_start（toolName "ask_user_question"）的 args 一次性携带
 *   全部题目（question/header/options[{label,description,preview}]/multiSelect）。
 * - pinel 借此在本地渲染整卷问卷、用户确认后按序回填串行对话框，
 *   从而支持「确认前修改任一题」。
 */

/** 问卷题目（防御解析后的内部表示）。 */
export interface QuestionnaireQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect: boolean;
}

/** 用户对一题的回答。 */
export type QuestionnaireAnswer =
  | { kind: "option"; optionIndex: number }
  | { kind: "multi"; optionIndices: number[] }
  | { kind: "custom"; text: string };

export type QuestionnairePhase = "answering" | "reviewing" | "submitting" | "submitted";

/** 广播给 webview 的问卷视图（不含回填游标等宿主内部状态）。
 * id：本次问卷实例的稳定标识（ask_user_question 的 toolCallId）。webview 端每条
 * postMessage 都是结构化克隆的新对象，questions 引用比较恒为真，重入判定必须
 * 按 id 比较而非引用比较。 */
export interface QuestionnaireView {
  id: string;
  questions: QuestionnaireQuestion[];
  answers: Array<QuestionnaireAnswer | null>;
  phase: QuestionnairePhase;
}

/**
 * 防御解析 tool_execution_start 的 args：
 * 结构不符/无有效题目 → null（调用方回退逐卡对话框路径）。
 */
export function parseQuestionnaireArgs(args: unknown): QuestionnaireQuestion[] | null {
  if (typeof args !== "object" || args === null) {
    return null;
  }
  const rawQuestions = (args as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) {
    return null;
  }
  const questions: QuestionnaireQuestion[] = [];
  for (const item of rawQuestions) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    const question = entry.question;
    if (typeof question !== "string" || question.trim().length === 0) {
      continue; // 缺题面：跳过该题
    }
    const options: QuestionnaireQuestion["options"] = [];
    if (Array.isArray(entry.options)) {
      for (const opt of entry.options) {
        if (typeof opt !== "object" || opt === null) {
          continue;
        }
        const o = opt as Record<string, unknown>;
        if (typeof o.label === "string" && o.label.trim().length > 0) {
          const parsed: QuestionnaireQuestion["options"][number] = { label: o.label };
          if (typeof o.description === "string") {
            parsed.description = o.description;
          }
          if (typeof o.preview === "string") {
            parsed.preview = o.preview;
          }
          options.push(parsed);
        }
      }
    }
    const parsedQuestion: QuestionnaireQuestion = {
      question,
      options,
      multiSelect: entry.multiSelect === true,
    };
    if (typeof entry.header === "string") {
      parsedQuestion.header = entry.header;
    }
    questions.push(parsedQuestion);
  }
  return questions.length > 0 ? questions : null;
}

/**
 * 防御校验用户回答（webview 入站）：形状/索引范围不符 → null（忽略）。
 * 多选索引去重；自定义文本须非空（多选空选择用 kind:"multi" + [] 表达）。
 */
export function parseQuestionnaireAnswer(
  answer: unknown,
  question: QuestionnaireQuestion,
): QuestionnaireAnswer | null {
  if (typeof answer !== "object" || answer === null) {
    return null;
  }
  const a = answer as Record<string, unknown>;
  const inRange = (i: number): boolean =>
    Number.isInteger(i) && i >= 0 && i < question.options.length;
  if (a.kind === "option" && inRange(a.optionIndex as number)) {
    return { kind: "option", optionIndex: a.optionIndex as number };
  }
  if (a.kind === "multi" && Array.isArray(a.optionIndices)) {
    const indices = a.optionIndices.filter((i) => typeof i === "number") as number[];
    if (indices.every(inRange)) {
      return { kind: "multi", optionIndices: [...new Set(indices)] };
    }
  }
  if (a.kind === "custom" && typeof a.text === "string" && a.text.length > 0) {
    return { kind: "custom", text: a.text };
  }
  return null;
}

/**
 * select 帧的回填响应。
 * - 答选项 → 回 requestOptions[optionIndex] 原行，无需跟进
 * - 答自定义 → 回哨兵行（requestOptions 末项，插件无条件在末尾追加，不硬编码
 *   文案以兼容插件 i18n），并标记需要跟进 input（回填自定义文本）
 * - 无答案/索引越界/请求异常 → null（调用方回 cancelled 防御）
 */
export function selectResponseFor(
  question: QuestionnaireQuestion,
  answer: QuestionnaireAnswer | null,
  requestOptions: string[],
): { value: string; needsFollowup: boolean } | null {
  if (!answer || requestOptions.length === 0) {
    return null;
  }
  if (answer.kind === "custom") {
    return { value: requestOptions[requestOptions.length - 1], needsFollowup: true };
  }
  if (answer.kind === "option") {
    if (answer.optionIndex >= Math.min(question.options.length, requestOptions.length)) {
      return null;
    }
    return { value: requestOptions[answer.optionIndex], needsFollowup: false };
  }
  return null; // 多选题不应出现 select 帧（防御）
}

/**
 * input 帧的回填响应（多选数字串/空串/自定义文本）。
 * 数字为 1 基升序逗号连接（插件对空串视为 deliberate empty commit）。
 */
export function inputResponseFor(
  question: QuestionnaireQuestion,
  answer: QuestionnaireAnswer | null,
): string | null {
  if (!answer) {
    return null;
  }
  if (answer.kind === "custom") {
    return answer.text;
  }
  if (answer.kind === "multi") {
    return [...answer.optionIndices]
      .sort((a, b) => a - b)
      .map((i) => String(i + 1))
      .join(",");
  }
  return null; // 单选项不应出现 input 帧（防御）
}

/** 标题归属：对话框标题含题面文本（或 header）即认为属于该题（缓冲门控用）。 */
export function titleMatchesQuestion(title: string | undefined, question: QuestionnaireQuestion): boolean {
  if (typeof title !== "string" || title.trim().length === 0) {
    return false;
  }
  if (title.includes(question.question)) {
    return true;
  }
  if (question.header && title.includes(question.header)) {
    return true;
  }
  return false;
}
