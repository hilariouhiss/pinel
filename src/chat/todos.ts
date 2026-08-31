/**
 * todo 工具结果解析（纯函数，无 vscode 依赖）。
 *
 * 数据源：`tool_execution_end`（toolName === "todo"）的 `result.details.tasks`。
 * 这是 pi 未写入官方 rpc.md 的未文档化字段（实测 0.84.1：create/update 每次
 * 执行后返回全量任务快照）。解析必须防御：结构不符静默返回 null（调用方
 * 降级为不更新面板，不影响工具卡片显示）。
 *
 * 迁移路径：若 pi 未来在 RPC 模式支持字符串数组 widget 或提供 todo 专用
 * 事件，应迁移到官方通道（见 AGENTS.md 踩坑记录）。
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoTask {
  id: number;
  subject: string;
  status: TodoStatus;
  description?: string;
  activeForm?: string;
}

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "deleted"]);

/** 逐条防御解析：跳过损坏条目；至少 1 条有效才返回，否则 null。 */
function parseOne(raw: unknown): TodoTask | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== "number" || typeof t.subject !== "string" || typeof t.status !== "string") {
    return null;
  }
  if (!TODO_STATUSES.has(t.status)) {
    return null;
  }
  const task: TodoTask = { id: t.id, subject: t.subject, status: t.status as TodoStatus };
  if (typeof t.description === "string") {
    task.description = t.description;
  }
  if (typeof t.activeForm === "string") {
    task.activeForm = t.activeForm;
  }
  return task;
}

/**
 * 从 todo 工具的 `tool_execution_end.result` 解析全量任务快照。
 * 结构不符/非空但全部条目损坏时返回 null；空数组（合法空快照）返回 []。
 */
export function parseTodoTasks(result: unknown): TodoTask[] | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const tasks = (details as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks)) {
    return null;
  }
  const parsed: TodoTask[] = [];
  for (const raw of tasks) {
    const task = parseOne(raw);
    if (task) {
      parsed.push(task);
    }
  }
  // 空数组 = 合法空快照（用户删光了任务）→ 返回 [] 清空面板；
  // 非空但全部损坏 = 数据可疑 → null 保留旧状态
  if (parsed.length === 0 && tasks.length > 0) {
    return null;
  }
  return parsed;
}

/** 防御解析 details.nextId（会话内单调递增的任务计数器；clear 后归 1）。 */
export function parseTodoNextId(result: unknown): number | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const nextId = (details as Record<string, unknown>).nextId;
  return typeof nextId === "number" && Number.isFinite(nextId) && nextId >= 1 ? nextId : null;
}

/** 回合任务视图：只保留 id > 基线的新任务（上一回合任务即便在快照中也不回流）。 */
export function selectRoundTasks(tasks: TodoTask[], baseline: number): TodoTask[] {
  return tasks.filter((t) => t.id > baseline);
}

/**
 * 回合基线解析：快照 nextId ≤ 基线 ⇒ 会话内发生 clear（计数器归 1，
 * 后续新任务 id 从头计）⇒ 基线归零；否则保持（nextId 会话内单调）。
 */
export function resolveRoundBaseline(prev: number, nextId: number | null): number {
  return nextId !== null && nextId <= prev ? 0 : prev;
}
