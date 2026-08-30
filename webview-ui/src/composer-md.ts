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

/**
 * 去掉块容器子节点开头的合成换行（mdast-util-to-hast 为块子元素添加的格式
 * "\n"）：块间换行已由父级分隔文本承担，保留会使容器首块多渲染一个空行、
 * 整个渲染层相对原文下移（光标停在空行、文本显示在下一行的错位）。
 * 纯数组操作（ReactNode 数组的文本子为字符串，"\n" 即合成换行）。
 */
export function stripLeadingNewline<T>(children: readonly T[] | T): readonly T[] | T {
  return Array.isArray(children) && children[0] === "\n" ? children.slice(1) : children;
}
