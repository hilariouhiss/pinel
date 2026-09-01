import type { FileItem } from "./types";

/** 渲染层 @file 高亮切分：反引号包裹形态（与 parseAtRefs 语法一致），
 *  split 捕获组保留分隔段 → 偶数下标为普通文本、奇数下标为高亮引用。 */
const AT_REF_RE = /(`@(?:"[^"]*"|[^`\s]*)`)/g;

export function splitAtRefs(content: string): string[] {
  return content.split(AT_REF_RE);
}

/** 保守尾随标点集（. 除外：防 @README.md 整 token 未命中时被剥坏）。 */
const TRAILING_PUNCT = ",;:!?)]}。、）】";

/**
 * 尾随标点剥离匹配：先整 token 精确匹配，失败后逐字符剥离保守标点重试；
 * 最后回退剥离点号（仅极端情况，如文件无扩展名被标点紧跟）。
 * 命中返回 fileList 原始 path（保持大小写），未命中返回空串。
 */
function stripAndMatch(token: string, paths: Map<string, string>): string {
  if (paths.has(token.toLowerCase())) {
    return paths.get(token.toLowerCase()) as string;
  }
  let t = token;
  while (t.length > 0 && TRAILING_PUNCT.includes(t[t.length - 1])) {
    t = t.slice(0, -1);
    if (paths.has(t.toLowerCase())) {
      return paths.get(t.toLowerCase()) as string;
    }
  }
  while (t.length > 0 && t[t.length - 1] === ".") {
    t = t.slice(0, -1);
    if (paths.has(t.toLowerCase())) {
      return paths.get(t.toLowerCase()) as string;
    }
  }
  return "";
}

/**
 * 末 token 的 @ 弹窗触发判定（纯函数，供 Composer 与自检共用）。
 * - 裸 @ 开头（含仅 @）：手打进行中 → 触发，query 为 @ 后部分
 * - 反引号形式仅未闭合时触发（`@foo，中间无闭合 `）；闭合态 `@foo`
 *   不触发（列表选中后的规范形态，后续击键不再重开弹窗，
 *   因此 acceptFile 无需插入真实尾空格——保持原文 1:1，渲染层不错位）
 */
export function matchAtToken(token: string): { trigger: boolean; query: string } {
  if (token.startsWith("@")) {
    return { trigger: true, query: token.slice(1) };
  }
  if (token.startsWith("`@") && !token.slice(2).includes("`")) {
    return { trigger: true, query: token.slice(2) };
  }
  return { trigger: false, query: "" };
}

/**
 * 从发送文本解析 @ 文件引用（纯函数）。
 * - 语法：`@path` 或 `@"path with spaces"`——仅反引号包裹的 @file 才被解析，
 *   未包裹的 @ 提及视为普通文本（邮箱/聊天 @ 不误伤）；列表选择由 acceptFile
 *   统一以反引号插入，手打需带反引号才生效
 * - 与 fileList path 匹配（Windows 大小写不敏感，返回原始 path）；去重保序
 * - 未匹配的 `@token 保留为普通文本（不返回、不报错）
 * - 未闭合反引号（`@foo）无闭合定界符，不解析，视为普通文本
 */
export function parseAtRefs(text: string, fileList: FileItem[]): string[] {
  if (!text || fileList.length === 0) {
    return [];
  }
  const paths = new Map<string, string>();
  for (const f of fileList) {
    const key = f.path.toLowerCase();
    if (!paths.has(key)) {
      paths.set(key, f.path);
    }
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  const re = /`(@)(?:"([^"]+)"|([^`\s]+))`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[2] ?? m[3] ?? "";
    const hit = stripAndMatch(raw, paths);
    if (hit && !seen.has(hit)) {
      seen.add(hit);
      refs.push(hit);
    }
  }
  return refs;
}
