import { useEffect, useRef, useState } from "react";
import { vscode } from "../index";
import type { ChatStatus, ModelInfo } from "../types";

interface Props {
  status: ChatStatus;
  open: boolean;
  onClose: () => void;
  /** 模型列表（getModels 响应；空数组=失败信号，App 已收起展开区）。 */
  models: ModelInfo[];
  modelLoading: boolean;
  /** 思考强度列表（getThinkingLevels 响应）。 */
  thinkingLevels: string[];
  thinkingLoading: boolean;
  /** 当前展开的内嵌列表（模型/思考）；null=收起。 */
  expandedSection: "model" | "thinking" | null;
  onToggleSection: (section: "model" | "thinking" | null) => void;
  onSelectModel: (provider: string, modelId: string) => void;
  onSelectThinkingLevel: (level: string) => void;
}

/** 切换按钮防连点窗口：点击后短暂禁用，防双击风暴（本地状态，无需宿主参与）。 */
const COOLDOWN_MS = 500;

type ModeValue = "all" | "one-at-a-time";

/** 模型项复合键（Model.id 跨 provider 可能重复，与 App 侧 modelItemId 一致）。 */
function modelItemId(m: ModelInfo): string {
  return `${m.provider}:${m.id}`;
}

/**
 * ⚙ 设置面板（footer 卡片下半按钮触发）：队列模式双值点选、自动压缩开关、
 * 模型/思考强度内嵌展开列表（复用 get_available_models/set_model 等链路）。
 * 点击外部/Esc 关闭（Esc 在 window capture 阶段拦截，让位于 Composer 的
 * abort/清空分支）；非 running 时切换区禁用。
 */
export function ConfigPopover({
  status,
  open,
  onClose,
  models,
  modelLoading,
  thinkingLevels,
  thinkingLoading,
  expandedSection,
  onToggleSection,
  onSelectModel,
  onSelectThinkingLevel,
}: Props) {
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

  /** 内嵌展开区行（模型/思考）：标题行 + 展开列表。 */
  const expandableRow = (
    section: "model" | "thinking",
    label: string,
    currentLabel: string,
    selectedId: string | null,
    loading: boolean,
    options: Array<{ id: string; label: string; detail?: string }>,
    onPick: (id: string) => void,
  ) => {
    const expanded = expandedSection === section;
    return (
      <div className="config-popover-section">
        <button
          className="config-popover-expand-row"
          aria-expanded={expanded}
          onClick={() => onToggleSection(expanded ? null : section)}
        >
          <span className="config-popover-label">{label}</span>
          <span className="config-popover-value">{currentLabel}</span>
          <span className={`config-popover-arrow${expanded ? " open" : ""}`} aria-hidden="true">
            ▸
          </span>
        </button>
        {expanded && (
          <div className="config-popover-options">
            {loading ? (
              <div className="config-popover-hint">加载中…</div>
            ) : options.length === 0 ? (
              <div className="config-popover-hint">无可用选项</div>
            ) : (
              options.map((opt) => (
                <button
                  key={opt.id}
                  className={`config-popover-option${opt.id === selectedId ? " selected" : ""}`}
                  onClick={() => onPick(opt.id)}
                >
                  <span className="config-popover-option-label">{opt.label}</span>
                  {opt.id === selectedId && <span className="config-popover-check">✓</span>}
                  {opt.detail && <span className="config-popover-option-detail">{opt.detail}</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    );
  };

  const modelLabel = status.model?.name ?? (running ? "未选择模型" : "—");
  const modelSelectedId = status.model ? modelItemId(status.model) : null;
  const modelOptions = models.map((m) => ({
    id: modelItemId(m),
    label: m.name ?? m.id ?? "",
    detail: m.provider,
  }));
  const thinkingOptions = thinkingLevels.map((level) => ({ id: level, label: level }));

  return (
    <>
      <div className="config-popover-overlay" onClick={onClose} />
      <div className="config-popover" role="dialog" aria-label="Pi 配置面板" ref={panelRef}>
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
        {expandableRow(
          "model",
          "模型",
          modelLabel,
          modelSelectedId,
          modelLoading,
          modelOptions,
          (id) => {
            const selected = models.find((m) => modelItemId(m) === id);
            if (selected && typeof selected.provider === "string" && typeof selected.id === "string") {
              onSelectModel(selected.provider, selected.id);
            }
          },
        )}
        {/* 无可用模型时思考强度无意义（对齐原状态栏行为：model 为空不显示思考按钮） */}
        {status.model !== null &&
          expandableRow(
            "thinking",
            "思考强度",
            status.thinkingLevel,
            status.thinkingLevel,
            thinkingLoading,
            thinkingOptions,
            (id) => {
              onSelectThinkingLevel(id);
            },
          )}
      </div>
    </>
  );
}
