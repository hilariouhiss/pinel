/** li 列表标记切片（纯函数，供 ComposerMarkdown 的 li 渲染用）。 */

/** hast position 的宽松结构镜像（仅取 offset）。 */
export interface MdPosition {
  start?: { offset?: number } | undefined;
  end?: { offset?: number } | undefined;
}

/**
 * 从源文本切出 li 的列表标记：无序 -、*、+ → "• "；有序 1. /3) 原样保留
 * （多位数、start≠1 天然正确）。标记与原文等宽（等宽字体 1:1 对齐前提）；
 * 缩进不包含在标记内（由块间空白文本节点承载）；position 缺失（异常路径）退回 "• "。
 */
export function sliceLiMarker(content: string, position: MdPosition | null | undefined): string {
  if (position?.start?.offset == null || position?.end?.offset == null) {
    return "• ";
  }
  const m = content
    .slice(position.start.offset, position.end.offset)
    .split("\n")[0]
    .match(/^\s*([-+*]|\d+[.)])\s+/);
  if (!m) {
    return "• ";
  }
  return /^[-+*]$/.test(m[1]) ? "• " : `${m[1]} `;
}
