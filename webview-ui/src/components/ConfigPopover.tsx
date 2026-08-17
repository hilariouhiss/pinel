import { useEffect, useRef, useState } from "react";
import { vscode } from "../index";
import type { ChatStatus } from "../types";

interface Props {
  status: ChatStatus;
  open: boolean;
  onClose: () => void;
}

/** 切换按钮防连点窗口：点击后短暂禁用，防双击风暴（本地状态，无需宿主参与）。 */
const COOLDOWN_MS = 500;

type ModeValue = "all" | "one-at-a-time";

/**
 * 状态栏弹出配置面板：模型/思考强度点击循环切换（cycle_model /
 * cycle_thinking_level），队列模式双值点选，自动压缩开关。
 * 点击外部/Esc 关闭（Esc 在 window capture 阶段拦截，让位于 Composer 的
 * abort/清空分支）；非 running 或无模型时切换区禁用。
 */
export function ConfigPopover({ status, open, onClose }: Props) {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const running = status.processState === "running";
  const modelMissing = status.model === null;

  // Esc 关闭：capture 阶段拦截 + stopPropagation，防止 Composer 的 Esc 分支
  //（流式中会 abort）同时触发——面板打开时 Esc 只关面板
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  // 打开时焦点移入面板首个按钮；关闭（open 变 false 触发 cleanup）时
  // 焦点还原到触发按钮（状态栏模型/思考等级按钮），键盘用户无需重新 Tab 定位
  useEffect(() => {
    if (!open) {
      return;
    }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
    return () => {
      if (trigger && trigger.isConnected) {
        trigger.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  /** 防连点包装：busy 期间忽略重复点击，COOLDOWN_MS 后解锁。 */
  const withCooldown = (key: string, fn: () => void) => {
    if (busyKeys.has(key)) {
      return;
    }
    setBusyKeys((prev) => new Set(prev).add(key));
    fn();
    setTimeout(() => {
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, COOLDOWN_MS);
  };

  const modeButton = (key: string, current: string, value: ModeValue, label: string, post: () => void) => (
    <button
      key={`${key}-${value}`}
      className={`config-popover-mode${current === value ? " active" : ""}`}
      aria-pressed={current === value}
      disabled={!running || busyKeys.has(key)}
      onClick={() =>
        withCooldown(key, () => {
          if (current !== value) {
            post();
          }
        })
      }
    >
      {label}
    </button>
  );

  return (
    <>
      <div className="config-popover-overlay" onClick={onClose} />
      <div className="config-popover" role="dialog" aria-label="Pi 配置面板" ref={panelRef}>
        <div className="config-popover-section">
          <div className="config-popover-title">模型</div>
          <div className="config-popover-row">
            <span className="config-popover-value" title={status.model?.name ?? ""}>
              {status.model?.name ?? "未选择模型"}
            </span>
            <button
              className="config-popover-cycle"
              title={modelMissing ? "无可用模型" : "切换到下一个模型"}
              disabled={!running || modelMissing || busyKeys.has("model")}
              onClick={() => withCooldown("model", () => vscode.postMessage({ type: "cycleModel" }))}
            >
              ↻ 切换
            </button>
          </div>
        </div>
        <div className="config-popover-section">
          <div className="config-popover-title">思考强度</div>
          <div className="config-popover-row">
            <span className="config-popover-value">{status.thinkingLevel}</span>
            <button
              className="config-popover-cycle"
              title={modelMissing ? "无可用模型" : "切换到下一思考强度"}
              disabled={!running || modelMissing || busyKeys.has("thinking")}
              onClick={() => withCooldown("thinking", () => vscode.postMessage({ type: "cycleThinking" }))}
            >
              ↻ 切换
            </button>
          </div>
        </div>
        <div className="config-popover-section">
          <div className="config-popover-title">队列模式（流式中发送）</div>
          <div className="config-popover-row">
            <span className="config-popover-label">steering</span>
            {modeButton("steering", status.steeringMode, "all", "全部投递", () =>
              vscode.postMessage({ type: "setSteeringMode", mode: "all" }),
            )}
            {modeButton("steering", status.steeringMode, "one-at-a-time", "一次一条", () =>
              vscode.postMessage({ type: "setSteeringMode", mode: "one-at-a-time" }),
            )}
          </div>
          <div className="config-popover-row">
            <span className="config-popover-label">跟进</span>
            {modeButton("followUp", status.followUpMode, "all", "全部投递", () =>
              vscode.postMessage({ type: "setFollowUpMode", mode: "all" }),
            )}
            {modeButton("followUp", status.followUpMode, "one-at-a-time", "一次一条", () =>
              vscode.postMessage({ type: "setFollowUpMode", mode: "one-at-a-time" }),
            )}
          </div>
        </div>
        <div className="config-popover-section">
          <div className="config-popover-title">自动压缩</div>
          <div className="config-popover-row">
            <span className="config-popover-value">上下文接近满时自动压缩</span>
            <button
              role="switch"
              aria-checked={status.autoCompactionEnabled}
              className={`config-popover-toggle${status.autoCompactionEnabled ? " on" : ""}`}
              disabled={!running || busyKeys.has("compaction")}
              onClick={() =>
                withCooldown("compaction", () =>
                  vscode.postMessage({ type: "setAutoCompaction", enabled: !status.autoCompactionEnabled }),
                )
              }
            >
              {status.autoCompactionEnabled ? "开" : "关"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
