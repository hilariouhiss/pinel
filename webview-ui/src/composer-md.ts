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

/** 严格列表语法：仅 "数字. " 有序与 "- " 无序是列表；"* "、"+"、"N) " 逐行转义为
 *  字面文本（渲染输出与原文等宽——反斜杠被 remark 消费不占位）。
 *  围栏代码块内不动（字面契约）；仅空格缩进 ≤3 是列表候选（tab=4 列，按
 *  缩进代码块处理不转义）；块引用前缀（> / > > ）后同样转义。 */
export function strictListSyntax(content: string): string {
  let fence: string | null = null;
  return content
    .split("\n")
    .map((line) => {
      const fm = line.match(/^([ ]{0,3})(`{3,}|~{3,})/);
      if (fm) {
        fence = fence === null ? fm[2][0] : fence === fm[2][0] ? null : fence;
        return line;
      }
      if (fence !== null) return line;
      // 组1=块引用前缀，组2=空格缩进，组3=非严格标记（* / + / 数字+闭括号），
      // 后随空白/行尾/非标记字符（*b 强调、*** HR、**bold** 均按此区分：仅紧邻
      // * 或 + 的星号不转义）
      return line.replace(/^((?:[ ]{0,3}> )*)([ ]{0,3})([*+]|\d+\))(?=\s|$|[^*+])/, (_m, prefix: string, indent: string, marker: string) => {
        return prefix + indent + marker.replace(/[*+)]/g, (c) => `\\${c}`);
      });
    })
    .join("\n");
}

/** 间隙注入的「块」集合（li 同块：每个列表项都始于新行；表格整表按源码切片
 *  渲染、thead/tbody/tr 子层注入不可见，不在此列）。 */
const GAP_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "blockquote", "table", "hr", "li"]);

/** 两相邻块间的源文精确切片（含全部空行）；position 缺失退回单个换行。 */
function gapBetween(content: string, a: any, b: any): string {
  const ae = a?.position?.end?.offset;
  const bs = b?.position?.start?.offset;
  return typeof ae === "number" && typeof bs === "number" ? content.slice(ae, bs) : "\n";
}

/**
 * rehype 插件：让渲染层行数与 textarea 原文严格一致。
 * 1) 剔除所有空白纯文本子（remark-rehype 的合成 "\n" 分隔符——单个换行
 *    只能让下一块另起一行，源文的 N 个空行会塌缩成 0）；
 * 2) 相邻块元素之间注入 gapBetween 源间隙（含精确空行数）；
 * 3) 根级首尾：源文以空行开头/结尾时补足前缀/后缀（光标停在首尾空行不飘）。
 */
export function composerGapAlign(content: string) {
  return (tree: any): void => {
    const fix = (node: any): void => {
      const children: any[] = node.children ?? [];
      const kids = children.filter((c: any) => !(c.type === "text" && /^[\n ]*$/.test(c.value)));
      const out: any[] = [];
      for (const c of kids) {
        const prev = out[out.length - 1];
        // c 为块元素且 prev 为块元素或内容文本（li 内裸文本后嵌嵌套列表的
        // 源换行同样注入——否则嵌套项与父项内容坍缩到同一行）；空白文本
        // 已被上方过滤，不会双注入
        if (prev && GAP_BLOCKS.has(c.tagName) && (prev.type === "text" || GAP_BLOCKS.has(prev.tagName))) {
          let gap = gapBetween(content, prev, c);
          // 列表容器/项自带的 sliceLiMarker 已含行首缩进：间隙只保留换行，
          // 否则嵌套列表缩进双计（"  - b" 渲染成 "    • b"，光标错位）。
          // 块引用嵌套（间隙尾段含 ">"）不在本修正范围（既有偏差）。
          if ((c.tagName === "ul" || c.tagName === "ol" || c.tagName === "li") &&
              !gap.slice(gap.lastIndexOf("\n") + 1).includes(">")) {
            gap = gap.replace(/[ \t]+$/, "");
          }
          out.push({ type: "text", value: gap });
        }
        out.push(c);
      }
      if (node.type === "root" && out.length > 0 && GAP_BLOCKS.has(out[0].tagName)) {
        const s = out[0]?.position?.start?.offset;
        if (typeof s === "number" && s > 0 && /^[\n ]+$/.test(content.slice(0, s))) {
          out.unshift({ type: "text", value: content.slice(0, s) });
        }
        const last = out[out.length - 1];
        const e = last?.position?.end?.offset;
        if (typeof e === "number" && e < content.length && /^[\n ]+$/.test(content.slice(e))) {
          out.push({ type: "text", value: content.slice(e) });
        }
      }
      node.children = out;
      for (const c of out) {
        if (c.type === "element") fix(c);
      }
    };
    fix(tree);
  };
}
