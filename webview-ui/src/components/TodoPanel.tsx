import { useState } from "react";
import type { TodoTask } from "../types";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题/状态色）
import todoIcon from "lucide-static/icons/circle.svg";
import inProgressIcon from "lucide-static/icons/circle-dot.svg";
import doneIcon from "lucide-static/icons/circle-check-big.svg";
import chevronDownIcon from "lucide-static/icons/chevron-down.svg";
import chevronRightIcon from "lucide-static/icons/chevron-right.svg";

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
        <span className="todopanel-icon" dangerouslySetInnerHTML={{ __html: open ? chevronDownIcon : chevronRightIcon }} />
        {!open && activeSummary ? (
          <span className="todopanel-task" title={activeSummary}>
            <span className="todopanel-task-icon" dangerouslySetInnerHTML={{ __html: inProgressIcon }} />
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
            <div
              key={task.id}
              className={`todotask status-${task.status}`}
              title={task.description || undefined}
            >
              <span
                className="todotask-icon"
                dangerouslySetInnerHTML={{
                  __html:
                    task.status === "completed" ? doneIcon : task.status === "in_progress" ? inProgressIcon : todoIcon,
                }}
              />
              <span className="todotask-subject">
                {task.subject}
                {task.status === "in_progress" && task.activeForm ? ` · ${task.activeForm}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
