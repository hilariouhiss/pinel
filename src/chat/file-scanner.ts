import { promises as fs } from "node:fs";
import * as path from "node:path";
import ignore from "ignore";

/**
 * 工作区文件扫描纯函数模块（无 vscode 依赖，可单测）。
 *
 * 用途：输入框 @ 添加文件——弹出工作区文件补全列表。
 * 过滤规则：硬编码跳过 .git/node_modules + 根目录 .gitignore（ignore 包，
 * 标准 gitignore 语义；嵌套 .gitignore 不支持——明示限制）。
 *
 * 注意（ignore 包语义，踩坑记录）：
 * - 目录剪枝必须传尾斜杠 `ig.ignores('dist/')`——裸目录名按「文件」判定为 false；
 * - 路径统一 `/` 分隔（Windows 反斜杠需规范化，绝对路径会 throw）。
 */

/** 扫描文件数上限（大仓库截断，避免卡顿）。 */
export const MAX_SCAN_FILES = 1000;
/** 并发遍历 worker 数（对齐 scanSessions 的并发模式）。 */
const SCAN_WORKERS = 8;
/** 硬编码跳过的目录。 */
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** 图片扩展名表（判定 isImage；pi 用内容嗅探，此处简化——明示限制）。 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

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

/**
 * 扫描工作区文件列表（gitignore 过滤 + 上限截断）。
 * @param root 工作区根目录（不存在/无权限 → 空列表）
 * @returns 相对路径文件列表（按目录深度优先序）
 */
export async function scanWorkspaceFiles(root: string): Promise<ScanResult> {
  let ig: ReturnType<typeof ignore> | null = null;
  try {
    const gitignorePath = path.join(root, ".gitignore");
    const content = await fs.readFile(gitignorePath, "utf8");
    ig = ignore({ allowRelativePaths: true }).add(content.split(/\r?\n/).filter((l) => l.trim()));
  } catch {
    // 无 .gitignore：不过滤（除硬编码跳过）
  }

  const results: FileItem[] = [];
  let truncated = false;

  /** 相对路径（/ 分隔）是否被忽略（目录判定带尾斜杠）。 */
  const isIgnored = (rel: string, isDir: boolean): boolean => {
    if (!ig) {
      return false;
    }
    return ig.ignores(isDir ? `${rel}/` : rel);
  };

  /** 递归遍历（异步并发 worker 池）。 */
  const walkDir = async (dirAbs: string): Promise<void> => {
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
      const rel = path.relative(root, path.join(dirAbs, entry.name)).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || isIgnored(rel, true)) {
          continue;
        }
        subDirs.push(path.join(dirAbs, entry.name));
      } else if (entry.isFile()) {
        if (isIgnored(rel, false)) {
          continue;
        }
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        results.push({ path: rel, isImage: IMAGE_EXTENSIONS.has(ext) });
      }
    }
    // 并发遍历子目录（worker 池）
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < subDirs.length && results.length < MAX_SCAN_FILES) {
        const d = subDirs[next++];
        await walkDir(d);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_WORKERS, subDirs.length) }, () => worker()));
  };

  await walkDir(root);
  return { items: results, truncated };
}
