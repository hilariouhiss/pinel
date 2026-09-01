import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";
import ignore from "ignore";

/**
 * pi 智能体扩展管理纯函数模块（无 vscode 依赖，可单测）。
 *
 * 数据源说明：pi RPC 协议无「列出/启停/卸载扩展」命令，扩展管理由宿主
 * 直接操作文件与 settings.json 完成（薄客户端不扩 RPC）。
 *
 * 扩展两种来源（对齐 pi 0.84.2 dist/core/package-manager.js）：
 * - 本地自动发现：`<agentDir>/extensions` 下的 `*.ts|.js` 与子目录 `index.ts|.js`（全局）；
 *   `.pi/extensions/` 同规则（项目）。发现逻辑 collectAutoExtensionEntries：
 *   顶层 *.ts/*.js 文件 + 含 index.ts/index.js 的子目录；跳过 dotfiles/node_modules，
 *   经 .gitignore/.ignore/.fdignore 过滤。
 * - 包：settings.json 的 packages 数组（npm:/git:/本地路径）。字符串 = 全量加载；
 *   对象形式可过滤；applyPackageFilter 语义「空数组显式禁用该类型全部资源」；
 *   autoload:false 仅项目 scope 的 delta。
 *
 * 关键设计（见 .pi/plans/feat-extension-manager-20260821.md）：
 * - 本地扩展启停用「文件重命名 .ts/.js ↔ 追加 .disabled」——幂等可逆零 schema 耦合
 *   （pi 只自动发现 *.ts/index.ts，重命名即脱离发现范围）。
 *   ponytail: 覆盖不了 settings.json extensions 显式路径与 package.json 清单的扩展。
 * - 包启停写 settings.json：字符串 ↔ 对象空数组 {source, extensions:[], skills:[],
 *   prompts:[], themes:[]}（applyPackageFilter 空数组 = 全禁用）。
 *   ponytail: 已含过滤的对象形式 toggle 时丢失自定义过滤（罕见）；autoload:false
 *   项目包空数组是 no-op（applyPackageDeltaFilter 空数组早退），显示层按「禁用」处理。
 * - settings.json 严格 JSON.parse（pi 无 JSONC 容错）：损坏时中止并抛错，绝不覆盖；
 *   写入原子（temp + rename）。
 */

/** 项目配置目录名（pi 的 CONFIG_DIR_NAME，默认 .pi；rebrand 可覆盖）。 */
const CONFIG_DIR_NAME = ".pi";

/** pi 读取的 ignore 文件名（对齐 package-manager.js IGNORE_FILE_NAMES）。 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** 包过滤的资源类型（对齐 RESOURCE_TYPES）。 */
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;

/** 扩展作用域。 */
export type ExtensionScope = "global" | "project";
/** 扩展类型。 */
export type ExtensionKind = "local" | "package";
/** 弹层视图（对齐 pi config 的全局/项目切换）。 */
export type ExtensionView = "all" | "global" | "project";

/** 扩展列表项（webview 协议镜像；字段定义见 types.ts）。 */
export interface ExtensionItem {
  /** 唯一键：本地 = 入口文件绝对路径（不含 .disabled 后缀）；包 = source spec。 */
  id: string;
  kind: ExtensionKind;
  /** 展示名（本地 = 文件名/目录名；包 = 包名）。 */
  name: string;
  scope: ExtensionScope;
  /** 全资源类型禁用 = false，其余 = true；对象形式部分过滤时另设 filtered。 */
  enabled: boolean;
  /** 包对象形式仅部分过滤（部分资源类型禁用/白名单）。 */
  filtered?: boolean;
  /** 来源类型徽标（包 = npm/git/path；本地散文件扩展无）。 */
  sourceKind?: PackageSourceKind;
  /** 已装版本（安装目录 package.json 的 version；本地散文件扩展无）。 */
  version?: string;
  /** 卸载目标：本地 = 文件或目录绝对路径；包 = source spec。 */
  source: string;
  /** project 视图中的继承行：真实来源全局、项目未覆盖；scope 已重写为 project（开关写项目 settings）。 */
  inherited?: boolean;
}

/**
 * 解析 pi agent 目录：优先 PI_CODING_AGENT_DIR env，默认 `~/.pi/agent`。
 * env 缺省取 process.env（测试可显式传入隔离环境）。
 */
export function resolveAgentDir(
  homeDir: string,
  env: { PI_CODING_AGENT_DIR?: string } = process.env,
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured ? configured : path.join(homeDir, ".pi", "agent");
}

/** 默认 agent 目录（真实环境：os.homedir + process.env）。 */
export function defaultAgentDir(): string {
  return resolveAgentDir(os.homedir());
}

/**
 * 包身份归一（对齐 pi getPackageIdentity）：npm = 包名去版本；git/URL = host/path 去 ref、
 * 用户、端口与 .git 后缀；其余 = 本地路径按 baseDir 绝对化。
 * baseDir = settings 文件目录（global=agentDir、project=workspace/.pi），对齐 pi scope baseDir。
 * ponytail: scp 形式（git@host:path）与极端 URL 拼写不归一（pi 侧 last-wins 自愈，见计划风险 4）。
 */
export function packageIdentity(source: string, baseDir?: string): string {
  if (source.startsWith("npm:")) {
    return `npm:${source.slice(4).replace(/@[^@/]*$/, "")}`;
  }
  const urlLike = source.startsWith("git:")
    ? `git://${source.slice(4)}`
    : /^(https?|ssh|git):\/\//.test(source)
      ? source
      : null;
  if (urlLike) {
    try {
      const u = new URL(urlLike);
      const p = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/@[^/]*$/, "");
      return `git:${u.hostname}/${p}`;
    } catch {
      // URL 解析失败：罕见拼写，原样作为 local 处理（归一失败不抛错）
    }
  }
  return `local:${baseDir ? path.resolve(baseDir, source) : path.resolve(source)}`;
}

/** 来源类型（行内徽标）。 */
export type PackageSourceKind = "npm" | "git" | "path";

/** 来源 spec → 类型徽标。 */
export function packageSourceKind(source: string): PackageSourceKind {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:") || /^(https?|ssh|git):\/\//.test(source)) return "git";
  return "path";
}

/** npm spec 拆解：npm:pkg / npm:pkg@1.0.0 / npm:@scope/pkg@2.0.0 → name(+version/range)。 */
export function parseNpmSpec(source: string): { name: string; version?: string } {
  const s = source.slice(4);
  const scoped = s.startsWith("@");
  const rest = scoped ? s.slice(1) : s;
  const at = rest.lastIndexOf("@");
  if (at > 0 && rest.slice(at + 1)) {
    return { name: (scoped ? "@" : "") + rest.slice(0, at), version: rest.slice(at + 1) };
  }
  return { name: s };
}

/** npm spec 是否 pinned 精确版本（无 range 修饰符）→ 更新检查跳过（对齐 pi）。 */
export function isPinnedNpmSpec(source: string): boolean {
  const { version } = parseNpmSpec(source);
  return version !== undefined && !/["\^~><*|\s]/.test(version);
}

/** git/URL spec 的 @ref（git:host/path@v1 → v1）；无 ref → undefined。 */
export function gitRef(source: string): string | undefined {
  const s = source.startsWith("git:") ? source.slice(4) : source;
  const at = s.lastIndexOf("@");
  if (at > 0 && s.indexOf("/") < at && !s.slice(at + 1).includes("/")) {
    return s.slice(at + 1) || undefined;
  }
  return undefined;
}

/** git/URL spec → host/path（去 .git、去 ref；镜像 packageIdentity 的 URL 归一）。 */
export function gitHostPath(source: string): { host: string; path: string } | undefined {
  let u: URL;
  try {
    u = source.startsWith("git:") ? new URL(`git://${source.slice(4)}`) : new URL(source);
  } catch {
    return undefined;
  }
  const p = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/@[^/]*$/, "");
  if (!u.hostname || !p) return undefined;
  return { host: u.hostname, path: p };
}

/**
 * 包安装根目录（镜像 pi package-manager 布局）：
 * npm = <base>/npm/node_modules/<name>；git = <base>/git/<host>/<path>；本地路径 = base 相对解析。
 * base：global = agentDir；project = <projectRoot>/.pi（无 projectRoot → undefined）。
 */
export function installedPackageRoot(
  source: string,
  scope: ExtensionScope,
  agentDir: string,
  projectRoot?: string,
): string | undefined {
  const base = scope === "project" ? (projectRoot ? path.join(projectRoot, ".pi") : undefined) : agentDir;
  if (!base) return undefined;
  const kind = packageSourceKind(source);
  if (kind === "npm") {
    return path.join(base, "npm", "node_modules", ...parseNpmSpec(source).name.split("/"));
  }
  if (kind === "git") {
    const hp = gitHostPath(source);
    return hp ? path.join(base, "git", hp.host, ...hp.path.split("/")) : undefined;
  }
  return path.resolve(base, source);
}

/** 读包目录 package.json 的 version；缺失/损坏 → undefined。 */
export async function readPackageVersion(pkgDir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(pkgDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** 包 source spec → 展示名（纯函数便于单测）。 */
export function packageDisplayName(source: string): string {
  if (source.startsWith("npm:")) {
    // npm:@scope/pkg@1.0.0 / npm:pkg@1.0.0 → pkg
    const s = source.slice(4).replace(/@[^@/]*$/, "");
    return s.replace(/^@/, "").split("/").filter(Boolean).pop() ?? s;
  }
  if (source.startsWith("git:")) {
    // git:host/user/repo@ref → repo
    const s = source.slice(4).split("@")[0];
    return s.split("/").filter(Boolean).pop() ?? s;
  }
  if (/^https?:\/\//.test(source) || /^ssh:\/\//.test(source) || /^git:\/\//.test(source)) {
    // URL 形式（无 ref）：取末段；带 @ref 先剥离
    const s = source.split("@")[0];
    return s.split("/").filter(Boolean).pop() ?? s;
  }
  // 本地路径（绝对/相对）→ basename
  return path.basename(source) || source;
}

/**
 * 扫描本地自动发现的扩展（全局 + 项目目录）。
 * @param globalExtDir 全局扩展目录（`<agentDir>/extensions`）
 * @param projectExtDir 项目扩展目录（`<workspaceRoot>/.pi/extensions`；无 workspace 省略）
 */
export async function scanLocalExtensions(
  globalExtDir: string,
  projectExtDir?: string,
): Promise<ExtensionItem[]> {
  const items: ExtensionItem[] = [];
  items.push(...(await collectLocalExtensions(globalExtDir, "global")));
  if (projectExtDir) {
    items.push(...(await collectLocalExtensions(projectExtDir, "project")));
  }
  return items;
}

/** 扫描单个扩展目录（镜像 pi collectAutoExtensionEntries 的硬跳过 + ignore 过滤）。 */
async function collectLocalExtensions(dir: string, scope: ExtensionScope): Promise<ExtensionItem[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在/不可读
  }
  const ig = await loadIgnoreRules(dir);
  const items: ExtensionItem[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || name === "node_modules") {
      continue; // 对齐 pi collectAutoExtensionEntries 硬跳过
    }
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = await fs.stat(path.join(dir, name));
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    // ignore 过滤：目录判定带尾斜杠（踩坑：裸目录名按文件判定为 false）
    if (ig.ignores(isDir ? `${name}/` : name)) {
      continue;
    }
    if (isFile) {
      const info = entryFileInfo(name);
      if (!info) {
        continue;
      }
      const id = path.join(dir, info.base);
      items.push({
        id,
        kind: "local",
        name: info.base.slice(0, -3), // 去 .ts/.js 扩展名
        scope,
        enabled: info.enabled,
        source: id, // 文件样式：卸载目标 = 文件本身
      });
    } else if (isDir) {
      const item = await resolveDirExtension(dir, name, scope);
      if (item) {
        items.push(item);
      }
    }
  }
  return items;
}

/** 顶层文件条目：foo.ts/.js → 启用；foo.ts.disabled/.js.disabled → 禁用。 */
function entryFileInfo(name: string): { base: string; enabled: boolean } | null {
  const disabled = name.endsWith(".disabled");
  const base = disabled ? name.slice(0, -".disabled".length) : name;
  if (!(base.endsWith(".ts") || base.endsWith(".js"))) {
    return null;
  }
  return { base, enabled: !disabled };
}

/** 子目录条目：index.ts/.js（+ .disabled）。package.json 清单形式不在 v1 覆盖（ponytail）。 */
async function resolveDirExtension(
  parentDir: string,
  dirName: string,
  scope: ExtensionScope,
): Promise<ExtensionItem | null> {
  const dir = path.join(parentDir, dirName);
  for (const ext of [".ts", ".js"]) {
    const index = path.join(dir, `index${ext}`);
    if (await fileExists(index)) {
      return { id: index, kind: "local", name: dirName, scope, enabled: true, source: dir };
    }
    if (await fileExists(`${index}.disabled`)) {
      return { id: index, kind: "local", name: dirName, scope, enabled: false, source: dir };
    }
  }
  return null;
}

/** 扫描 settings.json 的 packages 数组（全局 + 项目）并富化来源类型与已装版本。 */
export async function scanPackages(
  globalSettingsPath: string,
  projectSettingsPath?: string,
  opts?: { agentDir: string; projectRoot?: string },
): Promise<ExtensionItem[]> {
  const items: ExtensionItem[] = [];
  items.push(...(await scanPackagesIn(globalSettingsPath, "global")));
  if (projectSettingsPath) {
    items.push(...(await scanPackagesIn(projectSettingsPath, "project")));
  }
  const agentDir = opts?.agentDir;
  if (agentDir) {
    for (const item of items) {
      item.sourceKind = packageSourceKind(item.source);
      const root = installedPackageRoot(item.source, item.scope, agentDir, opts?.projectRoot);
      if (root) {
        item.version = await readPackageVersion(root);
      }
    }
  }
  return items;
}

async function scanPackagesIn(settingsPath: string, scope: ExtensionScope): Promise<ExtensionItem[]> {
  const settings = await readSettings(settingsPath);
  const packages = settings.packages;
  if (!Array.isArray(packages)) {
    return [];
  }
  const items: ExtensionItem[] = [];
  for (const pkg of packages) {
    const source =
      typeof pkg === "string"
        ? pkg
        : pkg && typeof pkg === "object"
          ? ((pkg as Record<string, unknown>).source as string | undefined)
          : undefined;
    if (typeof source !== "string" || !source) {
      continue;
    }
    const state = packageState(pkg);
    items.push({
      id: source,
      kind: "package",
      name: packageDisplayName(source),
      scope,
      enabled: state.enabled,
      filtered: state.filtered || undefined,
      source,
    });
  }
  return items;
}

/** 包条目状态：字符串=启用；对象全类型空数组/autoload:false=禁用；其余=启用（部分过滤）。 */
function packageState(pkg: unknown): { enabled: boolean; filtered: boolean } {
  if (typeof pkg === "string") {
    return { enabled: true, filtered: false };
  }
  if (!pkg || typeof pkg !== "object") {
    return { enabled: true, filtered: false };
  }
  const o = pkg as Record<string, unknown>;
  if (o.autoload === false) {
    // 项目 scope delta：空数组 no-op，显示层按禁用处理（ponytail 标注）
    return { enabled: false, filtered: false };
  }
  const present = RESOURCE_TYPES.filter((t) => o[t] !== undefined);
  if (present.length === 0) {
    return { enabled: true, filtered: false }; // 对象但无过滤键：全量加载
  }
  const allEmpty =
    present.length === RESOURCE_TYPES.length &&
    RESOURCE_TYPES.every((t) => Array.isArray(o[t]) && (o[t] as unknown[]).length === 0);
  if (allEmpty) {
    return { enabled: false, filtered: false };
  }
  return { enabled: true, filtered: true };
}

/**
 * 按视图过滤/合成扩展列表（纯函数）：
 * - all：本地扩展不去重（双 scope 是不同文件）；包按 identity 去重（project 条目优先，对齐 pi dedupe）
 * - global：仅全局条目
 * - project：项目条目 + 全局包中未被项目同 identity 覆盖者（inherited，scope 重写为
 *   project——开关操作经 setExtensionEnabled 天然写项目 settings，H1 路由机制）
 * identity 基准：global 条目 = globalBase；project 条目 = projectBase（对齐 pi scope baseDir）。
 */
export function filterExtensionView(
  items: ExtensionItem[],
  view: ExtensionView,
  globalBase: string,
  projectBase?: string,
): ExtensionItem[] {
  const identity = (i: ExtensionItem): string =>
    packageIdentity(i.id, i.scope === "project" ? projectBase : globalBase);
  if (view === "global") {
    return items.filter((i) => i.scope === "global");
  }
  if (view === "project") {
    const projectItems = items.filter((i) => i.scope === "project");
    const covered = new Set(
      projectItems.filter((i) => i.kind === "package").map((i) => packageIdentity(i.id, projectBase)),
    );
    const inherited = items
      .filter(
        (i) => i.scope === "global" && i.kind === "package" && !covered.has(packageIdentity(i.id, globalBase)),
      )
      .map((i) => ({ ...i, scope: "project" as const, inherited: true }));
    return [...projectItems, ...inherited];
  }
  // all：本地不动；包按 identity 去重（project 优先）
  const locals = items.filter((i) => i.kind === "local");
  const pkgs = new Map<string, ExtensionItem>();
  for (const i of items) {
    if (i.kind !== "package") {
      continue;
    }
    const key = identity(i);
    const existing = pkgs.get(key);
    if (!existing || (existing.scope !== "project" && i.scope === "project")) {
      pkgs.set(key, i);
    }
  }
  return [...locals, ...pkgs.values()];
}

/**
 * 启停本地扩展：重命名入口文件（.ts/.js ↔ 追加 .disabled）。
 * @param id 入口文件绝对路径（不含 .disabled；文件样式 = 文件本身，目录样式 = 目录/index.ts）
 */
export async function setLocalExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  const from = enabled ? `${id}.disabled` : id;
  const to = enabled ? id : `${id}.disabled`;
  await fs.rename(from, to);
}

/** 卸载本地扩展：目录样式递归删除；文件样式删除文件及其 .disabled 变体。 */
export async function uninstallLocalExtension(source: string): Promise<void> {
  try {
    const st = await fs.stat(source);
    if (st.isDirectory()) {
      await fs.rm(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    }
  } catch {
    // source 不存在：文件样式且已禁用（.disabled 存在），继续走文件删除
  }
  await Promise.all([
    fs.rm(source, { force: true, maxRetries: 5, retryDelay: 100 }),
    fs.rm(`${source}.disabled`, { force: true, maxRetries: 5, retryDelay: 100 }),
  ]);
}

/**
 * 启停包：settings.json packages 数组字符串 ↔ 对象空数组。
 * 已含过滤的对象形式在禁用时被对象空数组覆盖（丢失自定义过滤，ponytail 标注）。
 * 无同 identity 条目时 append 覆盖条目（upsert：项目级覆盖全局包的主路径），
 * append 前按 packageIdentity 查重（对齐 pi dedupe，防 ssh/https 同 repo 不同拼写重复）。
 */
export async function setPackageEnabled(
  settingsPath: string,
  source: string,
  enabled: boolean,
): Promise<void> {
  const settings = await readSettings(settingsPath);
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const baseDir = path.dirname(settingsPath);
  const identity = packageIdentity(source, baseDir);
  const idx = packages.findIndex((p) => {
    const s = typeof p === "string" ? p : (p as Record<string, unknown> | null)?.source;
    return typeof s === "string" && packageIdentity(s, baseDir) === identity;
  });
  if (idx === -1) {
    packages.push(
      enabled ? source : { source, extensions: [], skills: [], prompts: [], themes: [] },
    );
  } else if (enabled) {
    packages[idx] = source;
  } else {
    packages[idx] = { source, extensions: [], skills: [], prompts: [], themes: [] };
  }
  settings.packages = packages;
  await writeSettings(settingsPath, settings);
}

/** 卸载本地路径包：从 settings.json packages 数组移除条目（本地路径不产生 npm/git 产物）。 */
export async function removePackageFromSettings(
  settingsPath: string,
  source: string,
): Promise<void> {
  const settings = await readSettings(settingsPath);
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const idx = packages.findIndex(
    (p) =>
      (typeof p === "string" ? p : (p as Record<string, unknown> | null)?.source) === source,
  );
  if (idx === -1) {
    throw new Error(`Package not found in settings: ${source}`);
  }
  packages.splice(idx, 1);
  settings.packages = packages;
  await writeSettings(settingsPath, settings);
}

// -------------------------------------------------------------------------
// settings.json 读写（严格 JSON + 原子写；见模块头注释）
// -------------------------------------------------------------------------

type SettingsObject = Record<string, unknown>;

/** 读 settings.json：不存在 → 空对象；损坏 JSON → 抛错（绝不覆盖，调用方 notice）。 */
export async function readSettings(settingsPath: string): Promise<SettingsObject> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {}; // 文件不存在 → 空设置（无 packages）
    }
    throw new Error(`Failed to read settings: ${settingsPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // pi 严格 JSON.parse（无 JSONC 容错）：损坏文件绝不覆盖，抛错交由调用方 notice
    throw new Error(`Settings file is not valid JSON: ${settingsPath}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Settings file has unexpected shape: ${settingsPath}`);
  }
  return parsed as SettingsObject;
}

/** 写 settings.json：临时文件 + rename 原子替换；目录不存在时 mkdir recursive。 */
export async function writeSettings(settingsPath: string, settings: SettingsObject): Promise<void> {
  const tmp = `${settingsPath}.pinel-tmp`;
  const body = `${JSON.stringify(settings, null, 2)}\n`;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true }); // 全新 workspace 无 .pi/ 时不 ENOENT
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, settingsPath); // 原子替换
}

// -------------------------------------------------------------------------
// 工具函数
// -------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** 读取目录内 ignore 文件（.gitignore/.ignore/.fdignore），对齐 pi addIgnoreRules。 */
async function loadIgnoreRules(dir: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore({ allowRelativePaths: true });
  for (const filename of IGNORE_FILE_NAMES) {
    try {
      const content = await fs.readFile(path.join(dir, filename), "utf8");
      ig.add(content.split(/\r?\n/).filter((l) => l.trim()));
    } catch {
      // 无该 ignore 文件：忽略
    }
  }
  return ig;
}

/** 项目配置目录（CONFIG_DIR_NAME）。 */
export function projectConfigDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, CONFIG_DIR_NAME);
}
