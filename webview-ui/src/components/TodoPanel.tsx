import { useState } from "react";
import type { TodoTask } from "../types";

interface Props {
  todos: TodoTask[];
}

/**
 * 待办列表面板：输入框上方固定、可折叠（限高 30vh 内部滚动）。
 *
 * 数据源：宿主从 todo 工具执行结果（details.tasks 全量快照）解析维护，
 * 空列表自动隐藏（App 层控制不渲染）。
 */
export function TodoPanel({ todos }: Props) {
  const [open, setOpen] = useState(true);
  const visible = todos.filter((t) => t.status !== "deleted");
  const done = visible.filter((t) => t.status === "completed").length;
  // 折叠态单行：进行中任务优先（第一个 + 多余 +N），无则回落计数
  const active = visible.filter((t) => t.status === "in_progress");
  const activeSummary =
    active.length > 0
      ? `${active[0].subject}${active[0].activeForm ? ` · ${active[0].activeForm}` : ""}${
          active.length > 1 ? ` +${active.length - 1}` : ""
        }`
      : null;

  return (
    <div className="todopanel">
      <button className="todopanel-head" onClick={() => setOpen(!open)}>
        <span className="todopanel-icon">{open ? "▾" : "▸"}</span>
        {!open && activeSummary ? (
          <span className="todopanel-task">
            <span className="todopanel-task-icon">●</span>
            <span className="todopanel-task-text">{activeSummary}</span>
          </span>
        ) : (
          <>
            <span className="todopanel-title">Todos</span>
            <span className="todopanel-count">
              {done}/{visible.length}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className="todopanel-body">
          {visible.map((task) => (
            <div key={task.id} className={`todotask status-${task.status}`}>
              <span className="todotask-icon">
                {task.status === "completed" ? "✓" : task.status === "in_progress" ? "●" : "○"}
              </span>
              <span className="todotask-subject">
                {task.subject}
                {task.status === "in_progress" && task.activeForm ? ` · ${task.activeForm}` : ""}
              </span>
              {task.description && <span className="todotask-desc">{task.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
