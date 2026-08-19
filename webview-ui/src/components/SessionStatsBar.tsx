import type { SessionStats } from "../types";

interface Props {
  /** 会话统计（宿主 parseSessionStats 结果）；null = 尚未拉取（占位）。 */
  stats: SessionStats | null;
}

/**
 * 缓存命中率（对齐 pi CLI /session-info：cacheRead/(input+cacheRead+cacheWrite)）。
 * 无缓存活动（cacheRead==0 && cacheWrite==0）时返回 null——显示层隐藏命中率
 * （对齐 CLI 显示条件）。
 */
function cacheHitRate(s: SessionStats): number | null {
  const { input, cacheRead, cacheWrite } = s.tokens;
  const promptTokens = input + cacheRead + cacheWrite;
  if (promptTokens <= 0 || (cacheRead <= 0 && cacheWrite <= 0)) {
    return null;
  }
  return (cacheRead / promptTokens) * 100;
}

function percentClass(p: number): string {
  if (p > 90) {
    return " danger";
  }
  if (p >= 70) {
    return " warn";
  }
  return "";
}

function fmt(n: number): string {
  return n.toLocaleString();
}

/**
 * 会话信息条（输入框上方；设置面板「显示会话信息」开关开启时显示）。
 * 内容：上下文占用进度条 + token（总量 + 输入/输出/缓存读/缓存写四项细分）+
 * 缓存命中率（无缓存活动隐藏）+ 成本（cost>0 才显示，对齐 CLI）。
 * 纯展示组件，数据来自宿主 get_session_stats 推送。
 */
export function SessionStatsBar({ stats }: Props) {
  if (!stats) {
    return (
      <div className="session-stats-bar">
        <span className="session-stats-empty">加载中…</span>
      </div>
    );
  }
  const cu = stats.contextUsage;
  const hitRate = cacheHitRate(stats);
  const { total, input, output, cacheRead, cacheWrite } = stats.tokens;
  return (
    <div className="session-stats-bar">
      <div className="session-stats-row">
        <span className="session-stats-label">上下文</span>
        {cu && cu.percent !== null ? (
          <div className="session-stats-context">
            <div className="session-stats-progress">
              <div
                className={`session-stats-progress-fill${percentClass(cu.percent)}`}
                style={{ width: `${Math.min(100, cu.percent)}%` }}
              />
            </div>
            <span className="session-stats-value">{cu.percent.toFixed(0)}%</span>
          </div>
        ) : (
          // 压缩后无新响应：percent null（估算不可信），占位待下次响应恢复
          <span className="session-stats-value session-stats-dim">压缩后待更新</span>
        )}
      </div>
      <div className="session-stats-row session-stats-tokens">
        <span className="session-stats-label">Token</span>
        <span className="session-stats-item">
          总量 <span className="session-stats-value">{fmt(total)}</span>
        </span>
        <span className="session-stats-item">输入 {fmt(input)}</span>
        <span className="session-stats-item">输出 {fmt(output)}</span>
        <span className="session-stats-item">
          缓存读 {fmt(cacheRead)}
          {hitRate !== null && <span className="session-stats-dim"> ({hitRate.toFixed(1)}%)</span>}
        </span>
        <span className="session-stats-item">缓存写 {fmt(cacheWrite)}</span>
        {typeof stats.cost === "number" && stats.cost > 0 && (
          <span className="session-stats-item">
            成本 <span className="session-stats-value">${stats.cost.toFixed(3)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
