import { promises as fs } from "node:fs";
import * as path from "node:path";
import ignore from "ignore";

/**
 * 工作区文件扫描纯函数模块（无 vscode 依赖，可单测）。
 *
 * 用途：输入框 @ 添加文件——弹出工作区文件补全列表。
 * 过滤规则：硬编码跳过 .git/node_modules + **逐层**加载 .gitignore/.ignore/.fdignore
 * （ignore 包，标准 gitignore 语义；对齐 pi addIgnoreRules 的逐层收集）：
 * - 每个目录若有忽略文件即入栈一层；判定从最深层的忽略文件向上回溯，
 *   第一层有意见即定（ignored → 忽略；unignored → 嵌套 `!` 否定命中 → 保留）；
 * - 目录剪枝：被忽略的目录不再下探（对齐 git：被排除目录内的否定规则不生效）。
 *
 * 注意（ignore 包语义，踩坑记录）：
 * - 目录剪枝必须传尾斜杠 `ig.ignores('dist/')`——裸目录名按「文件」判定为 false；
 * - 路径统一 `/` 分隔（Windows 反斜杠需规范化，绝对路径会 throw——各层相对自己的
 *   忽略文件目录取相对路径）。
 */

/** 扫描文件数上限（大仓库截断，避免卡顿）。 */
export const MAX_SCAN_FILES = 1000;
/** 并发遍历 worker 数（对齐 scanSessions 的并发模式）。 */
const SCAN_WORKERS = 8;
/** 硬编码跳过的目录。 */
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** 图片扩展名表（判定 isImage；pi 用内容嗅探，此处简化——明示限制）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
/** 逐层收集的忽略文件名（对齐 pi IGNORE_FILE_NAMES）。 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;

/** 按文件名/路径扩展名判定是否图片（controller 发送拼装共用）。 */
export function isImageFile(nameOrPath: string): boolean {
  const ext = path.extname(nameOrPath).slice(1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** 图片扩展名 → mimeType（发送附件用）。 */
export function imageMimeType(nameOrPath: string): string {
  const ext = path.extname(nameOrPath).slice(1).toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    default:
      return "image/png";
  }
}

/** 文件列表项（webview 协议镜像）。 */
export interface FileItem {
  /** 相对 workspace 根路径（/ 分隔，webview 显示与发送时 resolve）。 */
  path: string;
  /** 图片文件（发送时走图片附件链路）。 */
  isImage: boolean;
}

/** 扫描结果。 */
export interface ScanResult {
  items: FileItem[];
  /** 是否因超上限截断（调用方 notice 提示）。 */
  truncated: boolean;
}

/** 一层忽略规则（该层忽略文件所在绝对目录 + 匹配器）。 */
interface IgnoreLevel {
  dir: string;
  ig: ReturnType<typeof ignore>;
}

/** 读目录内全部忽略文件（任一存在即成层；全缺 → null）。 */
async function loadIgnoreLevel(dirAbs: string): Promise<IgnoreLevel | null> {
  const ig = ignore({ allowRelativePaths: true });
  let found = false;
  for (const name of IGNORE_FILE_NAMES) {
    try {
      const content = await fs.readFile(path.join(dirAbs, name), "utf8");
      ig.add(content.split(/\r?\n/).filter((l) => l.trim()));
      found = true;
    } catch {
      // 无该忽略文件：跳过
    }
  }
  return found ? { dir: dirAbs, ig } : null;
}

/**
 * 扫描工作区文件列表（逐层 gitignore 过滤 + 上限截断）。
 * @param root 工作区根目录（不存在/无权限 → 空列表）
 * @returns 相对路径文件列表（按目录深度优先序）
 */
export async function scanWorkspaceFiles(root: string): Promise<ScanResult> {
  const results: FileItem[] = [];
  let truncated = false;

  /**
   * 相对某层忽略文件目录的路径是否被忽略（目录判定带尾斜杠）。
   * 最深层优先：ignored → 忽略；unignored（嵌套 `!` 否定命中）→ 保留；
   * 本层无意见 → 上溯父层；全部无意见 → 保留。
   */
  const isIgnored = (levels: IgnoreLevel[], abs: string, isDir: boolean): boolean => {
    for (let i = levels.length - 1; i >= 0; i--) {
      const rel = path.relative(levels[i].dir, abs).replace(/\\/g, "/");
      const t = levels[i].ig.test(isDir ? `${rel}/` : rel);
      if (t.ignored) {
        return true;
      }
      if (t.unignored) {
        return false;
      }
    }
    return false;
  };

  /** 递归遍历（异步并发 worker 池；levels = 根到当前目录的忽略规则链）。 */
  const walkDir = async (dirAbs: string, levels: IgnoreLevel[]): Promise<void> => {
    const level = await loadIgnoreLevel(dirAbs);
    const nextLevels = level ? [...levels, level] : levels;
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    const subDirs: string[] = [];
    for (const entry of entries) {
      if (results.length >= MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || isIgnored(nextLevels, abs, true)) {
          continue;
        }
        subDirs.push(abs);
      } else if (entry.isFile()) {
        if (isIgnored(nextLevels, abs, false)) {
          continue;
        }
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        results.push({
          path: path.relative(root, abs).replace(/\\/g, "/"),
          isImage: IMAGE_EXTENSIONS.has(ext),
        });
      }
    }
    // 并发遍历子目录（worker 池；各子目录的规则链独立，无共享 matcher 顺序问题）
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < subDirs.length && results.length < MAX_SCAN_FILES) {
        const d = subDirs[next++];
        await walkDir(d, nextLevels);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_WORKERS, subDirs.length) }, () => worker()));
  };

  await walkDir(root, []);
  return { items: results, truncated };
}
