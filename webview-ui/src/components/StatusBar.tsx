import { vscode } from "../index";
import type { ChatStatus } from "../types";

interface Props {
  status: ChatStatus;
}

export function StatusBar({ status }: Props) {
  const queueCount = status.steering.length + status.followUp.length;
  const modelLabel = status.model?.name ?? "未选择模型";

  let stateEl: React.ReactNode;
  switch (status.processState) {
    case "starting":
      stateEl = (
        <span className="status-state">
          <span className="spinner" /> 启动中…
        </span>
      );
      break;
    case "error":
      stateEl = (
        <>
          <span className="status-state status-error" title={status.error ?? ""}>
            ✕ pi 进程异常
          </span>
          <button className="status-restart" onClick={() => vscode.postMessage({ type: "restart" })}>
            重启
          </button>
        </>
      );
      break;
    case "no-workspace":
      stateEl = (
        <>
          <span className="status-state status-warn" title={status.error ?? ""}>
            ⚠ 未打开文件夹
          </span>
          <button className="status-restart" onClick={() => vscode.postMessage({ type: "restart" })}>
            重试
          </button>
        </>
      );
      break;
    case "running":
      stateEl = status.isStreaming ? (
        <span className="status-state">
          <span className="spinner" /> 运行中
          {status.isCompacting && " · 压缩中"}
        </span>
      ) : (
        <span className="status-state status-ok">● 就绪</span>
      );
      break;
    default:
      stateEl = <span className="status-state">未启动</span>;
  }

  return (
    <div className="statusbar">
      <span className="status-item" title="当前模型">
        {modelLabel}
      </span>
      <span className="status-item" title="思考等级">
        {status.thinkingLevel}
      </span>
      {queueCount > 0 && (
        <span className="status-item" title="待处理队列">
          队列 {queueCount}
        </span>
      )}
      <span className="status-spacer" />
      {stateEl}
    </div>
  );
}
