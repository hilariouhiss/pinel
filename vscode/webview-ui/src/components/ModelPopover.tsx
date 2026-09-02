import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelInfo } from "../types";
// SVG 图标原始文本（esbuild text loader 内联 lucide-static；stroke=currentColor 随容器 color 自适应主题）
import checkIcon from "lucide-static/icons/check.svg";

interface Props {
  /** 锚定元素（footer chip 按钮）；null 不渲染（组件常驻挂载，开关由 App 弹层枚举驱动）。 */
  anchor: HTMLElement | null;
  /** 列表种类（实例固定：模型列表 / 思考等级列表）。 */
  kind: "model" | "thinking";
  models: ModelInfo[];
  modelLoading: boolean;
  thinkingLevels: string[];
  thinkingLoading: boolean;
  /** 当前模型复合键（provider:id；null=无模型）。 */
  currentModelKey: string | null;
  currentThinkingLevel: string;
  onSelectModel: (provider: string, modelId: string) => void;
  onSelectThinkingLevel: (level: string) => void;
  onClose: () => void;
}

/** 模型项复合键（Model.id 跨 provider 可能重复）。 */
function modelKey(m: ModelInfo): string {
  return `${m.provider ?? ""}:${m.id ?? ""}`;
}

/**
 * 模型/思考 chip 锚定下拉（单组件双实例，kind 固定）：
 * - 定位：chip 上方弹出（footer 在视口底部，与 SessionListPopover 向下定位不同——
 *   bottom 锚定）；水平左对齐 chip 左缘、超右缘右对齐回退；窗口 resize 重算
 * - 交互：Esc / 点击外部关闭（Esc window capture 拦截 stopPropagation，让位
 *   Composer 的中断/清空分支）；选中即发 set 消息并关闭（状态回读刷新由宿主
 *   set_model → get_state 链路负责）
 * - 空数组失败信号：宿主已 notice，App 消息 handler 按枚举关弹层；此处同规则兜底
 * - 列表项复用 config-popover-option 全局样式；loading 态对齐其 hint
 */
export function ModelPopover({
  anchor,
  kind,
  models,
  modelLoading,
  thinkingLevels,
  thinkingLoading,
  currentModelKey,
  currentThinkingLevel,
  onSelectModel,
  onSelectThinkingLevel,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ bottom?: number; left?: number; right?: number }>({});

  // 锚定定位：chip 上方（bottom 锚定）；左对齐、弹层宽于右缘距离时右对齐回退
  useLayoutEffect(() => {
    if (!anchor) {
      return;
    }
    const compute = () => {
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const leftAligned = rect.left + 240 <= vw - 8;
      setPos({
        bottom: window.innerHeight - rect.top + 4,
        left: leftAligned ? rect.left : undefined,
        right: leftAligned ? undefined : vw - rect.right,
      });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [anchor]);

  // Esc 关闭：capture 阶段拦截 + stopPropagation，防止 Composer 的 Esc 分支
  //（流式中会 abort）同时触发——弹层打开时 Esc 只关弹层
  useEffect(() => {
    if (!anchor) {
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
  }, [anchor, onClose]);

  // 打开时焦点移入弹层；关闭（anchor 变 null 触发 cleanup）时焦点还原到触发 chip
  useEffect(() => {
    if (!anchor) {
      return;
    }
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (triggerRef.current && triggerRef.current.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [anchor]);

  // 空数组失败信号兜底：loading 结束后列表仍为空 → 关闭（与 App handler 同规则）
  useEffect(() => {
    if (!anchor) {
      return;
    }
    const empty =
      kind === "model"
        ? !modelLoading && models.length === 0
        : !thinkingLoading && thinkingLevels.length === 0;
    if (empty) {
      onClose();
    }
  }, [anchor, kind, modelLoading, models.length, thinkingLoading, thinkingLevels.length, onClose]);

  if (!anchor) {
    return null;
  }

  const loading = kind === "model" ? modelLoading : thinkingLoading;
  return (
    <>
      <div className="session-popover-overlay" onClick={onClose} />
      <div
        className="model-popover"
        role="listbox"
        aria-label={kind === "model" ? "Model" : "Thinking effort"}
        tabIndex={-1}
        ref={panelRef}
        style={pos}
      >
        {loading ? (
          <div className="config-popover-hint">Loading…</div>
        ) : kind === "model" ? (
          models.map((m) => {
            const key = modelKey(m);
            const selected = key === currentModelKey;
            return (
              <button
                key={key}
                role="option"
                aria-selected={selected}
                className={`config-popover-option${selected ? " selected" : ""}`}
                title={m.provider && m.id ? `${m.provider}/${m.id}` : undefined}
                onClick={() => {
                  if (m.provider && m.id) {
                    onSelectModel(m.provider, m.id);
                  }
                }}
              >
                <span className="config-popover-option-label">{m.name ?? m.id ?? ""}</span>
                {selected && (
                  <span className="config-popover-check" dangerouslySetInnerHTML={{ __html: checkIcon }} />
                )}
                {m.provider && <span className="config-popover-option-detail">{m.provider}</span>}
              </button>
            );
          })
        ) : (
          thinkingLevels.map((level) => (
            <button
              key={level}
              role="option"
              aria-selected={level === currentThinkingLevel}
              className={`config-popover-option${level === currentThinkingLevel ? " selected" : ""}`}
              onClick={() => onSelectThinkingLevel(level)}
            >
              <span className="config-popover-option-label">{level}</span>
              {level === currentThinkingLevel && (
                <span className="config-popover-check" dangerouslySetInnerHTML={{ __html: checkIcon }} />
              )}
            </button>
          ))
        )}
      </div>
    </>
  );
}
