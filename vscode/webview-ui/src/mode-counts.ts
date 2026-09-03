import type { ModeState } from "./types";

/**
 * ContextBar 模式感知资源视图（纯函数，无 React 依赖，可被 node 自检脚本直接跑）。
 * 激活自定义模式（active 非空且命中）→ 该模式勾选的 skills（name/description）与
 * 扩展名列表；Default / 未加载 / active 指向已删模式 → null（调用方回退 live/磁盘源）。
 */
export interface ModeResourceView {
  /** 生效 skill 展示项（name = frontmatter name ?? 目录名，与 live SlashCommand 同形）。 */
  skills: { name: string; description?: string }[];
  /** 生效扩展展示名列表。 */
  extensions: string[];
}

export function modeResourceView(state: ModeState | null): ModeResourceView | null {
  if (!state || !state.active) {
    return null; // Default 或未加载：回退 live commands / 磁盘启用项
  }
  const mode = state.modes.find((m) => m.name === state.active);
  if (!mode) {
    return null; // active 指向已删模式：视为 Default
  }
  const skillIds = new Set(mode.skills);
  const extIds = new Set(mode.extensions);
  return {
    // 按 inventory 序过滤（scanModeInventory 已按 name 排序）；交集防御已卸载的陈旧 id
    skills: state.skills
      .filter((s) => skillIds.has(s.id))
      .map((s) => ({ name: s.name, description: s.description })),
    // ponytail: 扩展计数 = 模式勾选清单项（与模式扩展 id 集合交集），可能含已选但磁盘 .disabled 的本地扩展；
    // 包内扩展按包内粒度计数且无 enabled 态（scanModeInventory 丢了 enabled 标记）。
    // 需要精确时：scanModeInventory 按 enabled 过滤并重新对齐包粒度。
    extensions: state.extensions.filter((e) => extIds.has(e.id)).map((e) => e.name),
  };
}
