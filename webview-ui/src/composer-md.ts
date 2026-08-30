/** li 列表标记切片与空项预处理（纯函数，供 ComposerMarkdown 渲染用）。 */

/** hast position 的宽松结构镜像（仅取 offset）。 */
export interface MdPosition {
  start?: { offset?: number } | undefined;
  end?: { offset?: number } | undefined;
}

/**
 * 从源文本切出 li 的列表标记：无序 -、*、+ → "•"（有尾空白时 "• "）；
 * 有序 1. /3) 原样保留（多位数、start≠1 天然正确）。行首缩进原样保留
 * （嵌套列表对齐），标记与原文等宽（等宽字体 1:1 对齐前提）；
 * 标记后无空白的裸标记（"1."、"-"）也返回标记本身（不再回退 • ）；
 * position 缺失（异常路径）退回 "• "。
 */
export function sliceLiMarker(content: string, position: MdPosition | null | undefined): string {
  if (position?.start?.offset == null || position?.end?.offset == null) {
    return "• ";
  }
  // position.start 指向标记本身而非行首：回扫到行首，把嵌套缩进一并纳入切片
  const lineStart = content.lastIndexOf("\n", position.start.offset - 1) + 1;
  const firstLine = content.slice(lineStart, position.end.offset).split("\n")[0];
  const m = firstLine.match(/^(\s*)([-+*]|\d+[.)])(\s*)/);
  if (!m) {
    return "• ";
  }
  const [, indent, marker, trailing] = m;
  return /^[-+*]$/.test(marker)
    ? indent + "•" + (trailing.length > 0 ? " " : "")
    : indent + marker + trailing;
}

/** 整行仅含一个列表标记（可带缩进/尾空白）——「裸标记行」。 */
const BARE_MARKER_LINE = /^(\s*)([-+*]|\d+[.)])\s*$/;

/**
 * 空列表项补零宽字符：CommonMark 中空列表项不能打断段落（"x\n1." 整段按
 * 普通文本解析，换行后输入裸标记无反应），行尾补 U+200B（零宽、不可见、
 * 0 宽度）使其成为非空项，裸标记行处处可解析成列表。
 * 仅作用于渲染层输入（发送/复制仍是原文）；围栏内的裸标记行同样会补，
 * 但 ZWSP 不可见且 0 宽，无视觉副作用。
 */
export function supportEmptyListItems(content: string): string {
  if (!content) {
    return content;
  }
  return content
    .split("\n")
    .map((line) => {
      if (!BARE_MARKER_LINE.test(line)) {
        return line;
      }
      // 行尾已有空白：补 ZWSP 即可；裸标记（"1."/"-"）需先补空格——
      // CommonMark 要求标记后跟空白或行尾，"1.\u200b" 不算列表
      return /\s$/.test(line) ? line + "\u200b" : line + " \u200b";
    })
    .join("\n");
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
