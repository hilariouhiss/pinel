import type { PinelWorkflow } from "../types";
import loaderIcon from "lucide-static/icons/loader-circle.svg";
import alertIcon from "lucide-static/icons/triangle-alert.svg";
import checkIcon from "lucide-static/icons/circle-check.svg";
import failIcon from "lucide-static/icons/circle-x.svg";

interface Props {
  /** 工作流运行状态（插件 pinel.workflow 推送；null=无运行）。 */
  workflow: PinelWorkflow | null;
}

/** 工作流状态条：名称 + 状态（running 旋转 / awaiting-approval / done / failed）+ 阶段位置。 */
export function WorkflowBar({ workflow }: Props) {
  if (!workflow) {
    return null;
  }
  const icon =
    workflow.status === "running"
      ? loaderIcon
      : workflow.status === "awaiting-approval"
        ? alertIcon
        : workflow.status === "done"
          ? checkIcon
          : failIcon;
  const stageText =
    workflow.stage && workflow.totalStages > 0
      ? ` · ${workflow.stageNumber ?? "?"}/${workflow.totalStages} ${workflow.stage}`
      : "";
  const statusLabel =
    workflow.status === "awaiting-approval" ? "awaiting approval" : workflow.status;
  const errorText = workflow.status === "failed" && workflow.message ? ` · ${workflow.message}` : "";
  return (
    <div className={`workflow-bar workflow-${workflow.status}`}>
      <span className="workflow-icon" dangerouslySetInnerHTML={{ __html: icon }} />
      <span className="workflow-text" title={`run ${workflow.runId}`}>
        <span className="workflow-name">{workflow.workflow}</span>
        {" "}
        {statusLabel}
        {stageText}
        {errorText}
      </span>
    </div>
  );
}
