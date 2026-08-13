import { useState } from "react";
import type { TodoTask } from "../types";

interface Props {
  todos: TodoTask[];
}

/**
 * 待办列表面板：聊天流顶部固定、可折叠。
 *
 * 数据源：宿主从 todo 工具执行结果（details.tasks 全量快照）解析维护，
 * 空列表自动隐藏（App 层控制不渲染）。
 */
export function TodoPanel({ todos }: Props) {
  const [open, setOpen] = useState(true);
  const visible = todos.filter((t) => t.status !== "deleted");
  const done = visible.filter((t) => t.status === "completed").length;

  return (
    <div className="todopanel">
      <button className="todopanel-head" onClick={() => setOpen(!open)}>
        <span className="todopanel-icon">{open ? "▾" : "▸"}</span>
        <span className="todopanel-title">待办</span>
        <span className="todopanel-count">
          {done}/{visible.length}
        </span>
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
