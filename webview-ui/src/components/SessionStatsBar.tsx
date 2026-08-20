import type { SessionEnv, SessionStats } from "../types";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import upArrowIcon from "../../../media/up-arrow.svg";
import downArrowIcon from "../../../media/down-arrow.svg";
import dollarIcon from "../../../media/dollar.svg";
import cacheIcon from "../../../media/cache.svg";

interface Props {
  /** 会话统计（宿主 parseSessionStats 结果）；null = 尚未拉取（占位）。 */
  stats: SessionStats | null;
  /** 会话信息条环境段（folderName + git 状态）；null = 尚未广播。 */
  env: SessionEnv | null;
}

/**
 * 缓存命中率（对齐 pi CLI /session-info：cacheRead/(input+cacheRead+cacheWrite)）。
 * 无缓存活动（cacheRead==0 && cacheWrite==0）或 promptTokens<=0 时回 0（常显）。
 */
function cacheHitRate(s: SessionStats): number {
  const { input, cacheRead, cacheWrite } = s.tokens;
  const promptTokens = input + cacheRead + cacheWrite;
  if (promptTokens <= 0 || (cacheRead <= 0 && cacheWrite <= 0)) {
    return 0;
  }
  return (cacheRead / promptTokens) * 100;
}

/** 紧凑数字（K/M/B，1 位小数）：1,000,000 → "1.0M"、200,000 → "200.0K"。 */
function compact(n: number): string {
  if (n >= 1e9) {
    return (n / 1e9).toFixed(1) + "B";
  }
  if (n >= 1e6) {
    return (n / 1e6).toFixed(1) + "M";
  }
  if (n >= 1e3) {
    return (n / 1e3).toFixed(1) + "K";
  }
  return n.toLocaleString();
}

function fmt(n: number): string {
  return n.toLocaleString();
}

/** git 状态符号串 `[!?↑↓]`（仅在有指示时返回，否则空串）。 */
function gitMarkers(git: NonNullable<SessionEnv["git"]>): string {
  const parts: string[] = [];
  if (git.trackedChanges) {
    parts.push("!");
  }
  if (git.untracked) {
    parts.push("?");
  }
  if (git.ahead > 0) {
    parts.push("↑");
  }
  if (git.behind > 0) {
    parts.push("↓");
  }
  return parts.length > 0 ? `[${parts.join("")}]` : "";
}

/**
 * 会话信息条（输入卡正后方、从背后探出；设置面板「显示会话信息」开关开启时显示）。
 * 左侧环境段（Maple Mono NF）：`folderName on  branch [!?↑↓]`（p10k 风格）；
 * 右侧指标段：上下文占用/窗口、缓存读↑、缓存写↓、缓存命中率、成本$。
 * 纯展示组件；各元素经 title 提供悬浮语义。
 */
export function SessionStatsBar({ stats, env }: Props) {
  if (!stats) {
    return (
      <div className="session-stats-bar">
        <span className="session-stats-empty">Loading…</span>
      </div>
    );
  }
  const cu = stats.contextUsage;
  const hitRate = cacheHitRate(stats);
  const { cacheRead, cacheWrite } = stats.tokens;
  const contextText = cu
    ? `${cu.percent !== null ? cu.percent.toFixed(1) + "%" : "—"}/${compact(cu.contextWindow)}`
    : "—";
  const git = env?.git ?? null;
  const folderName = env?.folderName ?? null;
  const markers = git ? gitMarkers(git) : "";
  const envTitle = git
    ? `${git.branch}${markers ? ` ${markers}` : ""}`
    : folderName ?? undefined;
  return (
    <div className="session-stats-bar">
      <div className="session-stats-row">
        <span className="session-stats-env" title={envTitle}>
          {folderName}
          {git && (
            <>
              {" on "}
              <span className="session-stats-branch-icon">{"\uF418"}</span>
              {" "}
              {git.branch}
              {markers && <> {markers}</>}
            </>
          )}
        </span>
        <span className="session-stats-metrics">
          <span className="session-stats-value" title="Context usage / window">
            {contextText}
          </span>
          <span className="session-stats-item" title="Cache read">
            <span className="session-stats-icon" dangerouslySetInnerHTML={{ __html: upArrowIcon }} />{" "}
            {fmt(cacheRead)}
          </span>
          <span className="session-stats-item" title="Cache write">
            <span className="session-stats-icon" dangerouslySetInnerHTML={{ __html: downArrowIcon }} />{" "}
            {fmt(cacheWrite)}
          </span>
          <span className="session-stats-item" title="Cache hit rate">
            <span className="session-stats-icon" dangerouslySetInnerHTML={{ __html: cacheIcon }} />{" "}
            {hitRate.toFixed(1)}%
          </span>
          {typeof stats.cost === "number" && stats.cost > 0 && (
            <span className="session-stats-item" title="Cost">
              <span className="session-stats-icon" dangerouslySetInnerHTML={{ __html: dollarIcon }} />{" "}
              <span className="session-stats-value">{stats.cost.toFixed(3)}</span>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
