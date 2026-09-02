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
 * ⚙ 设置面板（footer 卡片下半按钮触发）：标题栏 + 队列模式分段控件、自动压缩/
 * 会话信息滑动开关。模型/思考切换入口在输入框按钮行 chip（ModelPopover 锚定下拉）。
 * 点击外部/Esc 关闭（Esc 在 window capture 阶段拦截，让位于 Composer 的
 * abort/清空分支）；非 running 时切换区禁用。
 */
export function ConfigPopover({ status, open, onClose }: Props) {
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const running = status.processState === "running";

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
  // 焦点还原到触发按钮（footer 卡片 ⚙ 设置按钮），键盘用户无需重新 Tab 定位
  useEffect(() => {
    if (!open) {
      return;
    }
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panelRef.current?.querySelector<HTMLButtonElement>(".config-popover-section button:not(:disabled)");
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

  /** 阈值提交：1–99 校验后发宿主（宿主二次校验）；非法值不提交。 */
  const commitThreshold = (raw: string) => {
    const pct = Math.round(Number(raw));
    if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
      return;
    }
    vscode.postMessage({ type: "setCompactionThreshold", percent: pct });
  };

  return (
    <>
      <div className="config-popover-overlay" onClick={onClose} />
      <div className="config-popover" role="dialog" aria-label="Pi settings" ref={panelRef}>
        <div className="popover-titlebar">
          <span className="popover-titlebar-title">Settings</span>
          <button className="popover-close" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </div>
        {/* 内容独立滚动区：关闭按钮行留在滚动区外（见 styles.css .popover-body） */}
        <div className="popover-body">
        <div className="config-popover-section">
          <div className="config-popover-title">Queue mode (send while streaming)</div>
          <div className="config-popover-row">
            <span className="config-popover-label">steering</span>
            <div className="config-popover-seg" role="group" aria-label="Steering mode">
              {modeButton("steering", status.steeringMode, "all", "Deliver all", () =>
                vscode.postMessage({ type: "setSteeringMode", mode: "all" }),
              )}
              {modeButton("steering", status.steeringMode, "one-at-a-time", "One at a time", () =>
                vscode.postMessage({ type: "setSteeringMode", mode: "one-at-a-time" }),
              )}
            </div>
          </div>
          <div className="config-popover-row">
            <span className="config-popover-label">Follow-up</span>
            <div className="config-popover-seg" role="group" aria-label="Follow-up mode">
              {modeButton("followUp", status.followUpMode, "all", "Deliver all", () =>
                vscode.postMessage({ type: "setFollowUpMode", mode: "all" }),
              )}
              {modeButton("followUp", status.followUpMode, "one-at-a-time", "One at a time", () =>
                vscode.postMessage({ type: "setFollowUpMode", mode: "one-at-a-time" }),
              )}
            </div>
          </div>
        </div>
        <div className="config-popover-section">
          <div className="config-popover-title">Auto compaction</div>
          <div className="config-popover-row">
            <span className="config-popover-value">Auto compact when context is nearly full</span>
            <button
              role="switch"
              aria-checked={status.autoCompactionEnabled}
              aria-label="Auto compact when context is nearly full"
              title={status.autoCompactionEnabled ? "On" : "Off"}
              className={`config-popover-switch${status.autoCompactionEnabled ? " on" : ""}`}
              disabled={!running || busyKeys.has("compaction")}
              onClick={() =>
                withCooldown("compaction", () =>
                  vscode.postMessage({ type: "setAutoCompaction", enabled: !status.autoCompactionEnabled }),
                )
              }
            />
          </div>
          <div className="config-popover-row">
            <span className="config-popover-label">Threshold</span>
            <input
              className="config-popover-input"
              type="number"
              min={1}
              max={99}
              step={1}
              defaultValue={status.autoCompactPercent ?? ""}
              placeholder={status.autoCompactPercent === null ? "—" : undefined}
              aria-label="Auto compaction threshold (percent of context window)"
              title="Compress when context usage reaches this percent (Enter or blur to save)"
              disabled={!running || busyKeys.has("threshold")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitThreshold(e.currentTarget.value);
                  e.currentTarget.blur(); // 提交后失焦，防重复 Enter
                }
              }}
              onBlur={(e) => commitThreshold(e.currentTarget.value)}
            />
            <span className="config-popover-unit">%</span>
          </div>
          <div className="config-popover-row">
            <button
              className="config-popover-compact"
              disabled={!running || status.isCompacting || busyKeys.has("compactNow")}
              onClick={() =>
                withCooldown("compactNow", () => vscode.postMessage({ type: "compact" }))
              }
            >
              {status.isCompacting ? "Compacting…" : "Compact now"}
            </button>
          </div>
        </div>
        <div className="config-popover-section">
          <div className="config-popover-title">Auto commit</div>
          <div className="config-popover-row">
            {/* 纯设置写（pi settings.json）：不设 running 门控，下一轮起生效 */}
            <span className="config-popover-value">Commit finished work automatically</span>
            <button
              role="switch"
              aria-checked={status.autoCommitEnabled}
              aria-label="Commit finished work automatically"
              title={status.autoCommitEnabled ? "On" : "Off"}
              className={`config-popover-switch${status.autoCommitEnabled ? " on" : ""}`}
              disabled={busyKeys.has("autoCommit")}
              onClick={() =>
                withCooldown("autoCommit", () =>
                  vscode.postMessage({ type: "setAutoCommit", enabled: !status.autoCommitEnabled }),
                )
              }
            />
          </div>
        </div>
        <div className="config-popover-section">
          <div className="config-popover-title">Session info</div>
          <div className="config-popover-row">
            {/* UI 偏好开关：不设 running 门控（不依赖 pi 进程，开启时首拉失败静默） */}
            <span className="config-popover-value">Show token/cost/context usage</span>
            <button
              role="switch"
              aria-checked={Boolean(status.showSessionStats)}
              aria-label="Show token/cost/context usage"
              title={status.showSessionStats ? "On" : "Off"}
              className={`config-popover-switch${status.showSessionStats ? " on" : ""}`}
              disabled={busyKeys.has("sessionStats")}
              onClick={() =>
                withCooldown("sessionStats", () =>
                  vscode.postMessage({ type: "toggleSessionStats" }),
                )
              }
            />
          </div>
        </div>
        </div>{/* /popover-body */}
      </div>
    </>
  );
}
