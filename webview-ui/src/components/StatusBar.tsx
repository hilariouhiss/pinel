import { vscode } from "../index";
import type { ChatStatus } from "../types";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import settingsIcon from "../../../media/settings.svg";

interface Props {
  status: ChatStatus;
  /** 模型/思考等级下拉列表是否打开（aria-expanded）；由各自按钮触发。 */
  modelListOpen: boolean;
  thinkingListOpen: boolean;
  /** 设置面板是否打开（aria-expanded）。 */
  settingsOpen: boolean;
  onOpenModelList: () => void;
  onOpenThinkingList: () => void;
  onOpenSettings: () => void;
  /** 按钮元素引用（App 侧 ListPopover 锚定定位/焦点还原依赖）。 */
  modelBtnRef?: React.Ref<HTMLButtonElement>;
  thinkingBtnRef?: React.Ref<HTMLButtonElement>;
}

export function StatusBar({
  status,
  modelListOpen,
  thinkingListOpen,
  settingsOpen,
  onOpenModelList,
  onOpenThinkingList,
  onOpenSettings,
  modelBtnRef,
  thinkingBtnRef,
}: Props) {
  const queueCount = status.steering.length + status.followUp.length;
  // 进程运行中但无模型：自愈已耗尽，警告态 + 重启按钮（由现有字段推导，不新增协议）
  const modelMissing = status.processState === "running" && status.model === null;
  const modelLabel = status.model?.name ?? (modelMissing ? "无可用模型" : "未选择模型");

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
      if (status.isStreaming) {
        stateEl = (
          <span className="status-state">
            <span className="spinner" /> 运行中
            {status.isCompacting && " · 压缩中"}
          </span>
        );
      } else if (modelMissing) {
        stateEl = (
          <>
            <span
              className="status-state status-warn"
              title="pi 未提供模型信息。请检查 pi 认证（在终端运行 pi 验证），或查看 Pinel 输出面板。"
            >
              ⚠ 无可用模型
            </span>
            <button className="status-restart" onClick={() => vscode.postMessage({ type: "restart" })}>
              重启
            </button>
          </>
        );
      } else {
        stateEl = <span className="status-state status-ok">● 就绪</span>;
      }
      break;
    default:
      stateEl = <span className="status-state">未启动</span>;
  }

  return (
    <div className="statusbar">
      <span className="status-item">
        <button
          className="status-config-btn status-settings-btn"
          title="设置"
          aria-label="设置"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={onOpenSettings}
          dangerouslySetInnerHTML={{ __html: settingsIcon }}
        />
      </span>
      <span className="status-item">
        <button
          ref={modelBtnRef}
          className="status-config-btn"
          title="当前模型（点击选择切换模型）"
          aria-haspopup="listbox"
          aria-expanded={modelListOpen}
          onClick={onOpenModelList}
        >
          {modelLabel}
        </button>
      </span>
      {status.model && (
        <span className="status-item">
          <button
            ref={thinkingBtnRef}
            className="status-config-btn"
            title="思考强度（点击选择切换）"
            aria-haspopup="listbox"
            aria-expanded={thinkingListOpen}
            onClick={onOpenThinkingList}
          >
            {status.thinkingLevel}
          </button>
        </span>
      )}
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
