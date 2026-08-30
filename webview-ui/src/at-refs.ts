import type { FileItem } from "./types";

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
