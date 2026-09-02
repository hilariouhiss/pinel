import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  collectLocalExtensions,
  installedPackageRoot,
  packageDisplayName,
  packageIdentity,
  scanLocalExtensions,
  type ExtensionScope,
  type SettingsObject,
} from "./extensions";

/**
 * 智能体模式纯函数模块（无 vscode 依赖，可单测）。
 *
 * 模式 = 一组启用的本地/包 skills 与扩展。切换模式把「不在激活模式里的资源」写成
 * 排除段（重启 pi 后生效）：
 * - 本地 skills：全局/项目 settings `skills` 数组 `!<目录名|文件名>`（SKILL.md 父目录名
 *   特例匹配，任意深度命中）；
 * - 本地扩展：同数组机制 `extensions` 键 `!<相对 baseDir 的 posix 路径>`（目录式扩展
 *   basename 恒为 index.ts，必须完整 rel 路径防碰撞）；
 * - 包 skills/扩展：包条目对象形式 `{source, skills:["!skills/foo"], extensions:["!x.ts"]}`
 *   （实测 applyPatterns：空 includes = 全启用、`!` 相对包根排除；省略键 = 该类型全量）。
 *
 * 模式定义存全局 settings 的 `pinel.modes`（复用 pinel.autoCommit 先例）：
 * { active, modes: [{name, skills, extensions}], packageBaseline? }。
 * active = null 即内置 Default（无排除 = 全部生效）。packageBaseline = identity →
 * Pinel 覆写前的包条目快照（Default/免过滤时还原，防吞用户手配）。
 *
 * ponytail ceilings：
 * - 包资源只扫约定目录（<pkgRoot>/skills、<pkgRoot>/extensions），pi manifest 自定义路径不扫；
 * - 扩展弹层的包启停（字符串↔全空对象）会覆盖模式过滤，下次切模式重算；
 * - autoload:false 项目 delta 包不管理；
 * - 激活模式期间用户手改 Pinel 已覆写的包过滤，会在还原时被基线覆盖。
 */

/** 排除范围（package = 包提供，排除写进包条目对象过滤）。 */
export type ModeResourceScope = "global" | "project" | "package";

/** 扫描出的 skill 条目（webview 协议镜像见 webview-ui/src/types.ts）。 */
export interface ModeSkill {
  /** 不透明复合键（模式配置存此键）：local|<scope>|<名> 或 pkg|<identity>|<包根相对路径>。 */
  id: string;
  /** 排除模式体（local skill = 目录名/文件名；pkg = 包根相对 posix 路径）。 */
  pattern: string;
  /** 展示名（frontmatter name ?? 目录名）。 */
  name: string;
  description?: string;
  scope: ModeResourceScope;
  /** 包展示名（scope = package 时）。 */
  package?: string;
  /** 包 identity（scope = package 时；过滤分组键）。 */
  identity?: string;
}

/** 扫描出的扩展条目。 */
export interface ModeExtension {
  id: string;
  /** 排除模式体（local = baseDir 相对 posix 路径；pkg = 包根相对 posix 路径）。 */
  pattern: string;
  name: string;
  scope: ModeResourceScope;
  package?: string;
  identity?: string;
}

/** 扫描清单（本地 + 包资源的 skills/扩展全集）。 */
export interface ModeInventory {
  skills: ModeSkill[];
  extensions: ModeExtension[];
}

/** 模式配置（pinel.modes.modes 条目）。skills/extensions = 资源 id 集。 */
export interface AgentMode {
  name: string;
  skills: string[];
  extensions: string[];
}

/** 模式状态（pinel.modes 防御解析产物）。active = null 即 Default。 */
export interface ModesState {
  active: string | null;
  modes: AgentMode[];
  /** 包条目基线（identity → Pinel 覆写前原值；还原后清除）。 */
  packageBaseline?: Record<string, unknown>;
}

/** 空状态（读失败/未配置）。 */
export function emptyModesState(): ModesState {
  return { active: null, modes: [] };
}

/**
 * 防御解析 settings.pinel.modes：形状不符逐层容缺（不抛错——配置损坏时
 * 模式功能降级为空态，绝不影响其他 settings 键的读写）。
 */
export function readModesState(settings: SettingsObject): ModesState {
  const pinel = settings.pinel;
  if (!pinel || typeof pinel !== "object" || Array.isArray(pinel)) {
    return emptyModesState();
  }
  const raw = (pinel as Record<string, unknown>).modes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyModesState();
  }
  const o = raw as Record<string, unknown>;
  const active = typeof o.active === "string" && o.active.trim() ? o.active : null;
  const modes: AgentMode[] = [];
  if (Array.isArray(o.modes)) {
    for (const m of o.modes) {
      if (!m || typeof m !== "object" || Array.isArray(m)) {
        continue;
      }
      const name = (m as Record<string, unknown>).name;
      if (typeof name !== "string" || !name.trim()) {
        continue;
      }
      const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
      modes.push({
        name,
        skills: strings((m as Record<string, unknown>).skills),
        extensions: strings((m as Record<string, unknown>).extensions),
      });
    }
  }
  const rawBaseline = o.packageBaseline;
  const packageBaseline =
    rawBaseline && typeof rawBaseline === "object" && !Array.isArray(rawBaseline)
      ? (rawBaseline as Record<string, unknown>)
      : undefined;
  return { active, modes, packageBaseline };
}

/** 写回 settings.pinel.modes（保留 pinel 节其余键，如 autoCommit；基线一并写入）。 */
export function writeModesState(settings: SettingsObject, state: ModesState): void {
  const raw = settings.pinel;
  const pinel =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  pinel.modes = {
    active: state.active,
    modes: state.modes,
    ...(state.packageBaseline ? { packageBaseline: state.packageBaseline } : {}),
  };
  settings.pinel = pinel;
}

/**
 * 解析 SKILL.md / 根 .md 的 frontmatter（首个 `---` 块内的 name/description 行）。
 * 无块或字段缺省 → 对应键 undefined（pi 校验比这严，这里只做展示用宽解析）。
 */
export function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) {
    return {};
  }
  const result: { name?: string; description?: string } = {};
  const nameMatch = /^name:[ \t]*(.+)$/m.exec(m[1]);
  if (nameMatch) {
    result.name = nameMatch[1].trim();
  }
  const descMatch = /^description:[ \t]*(.+)$/m.exec(m[1]);
  if (descMatch) {
    result.description = descMatch[1].trim();
  }
  return result;
}

// -------------------------------------------------------------------------
// 扫描（本地 + 包）
// -------------------------------------------------------------------------

/** pi 式 skill 根内单层收集定义。style: pi = 根 .md 也算 skill；agents = 仅 SKILL.md 目录。 */
interface SkillRoot {
  dir: string;
  scope: Exclude<ModeResourceScope, "package">;
  style: "pi" | "agents";
}

/** 扫描深度上限（防循环/超深目录；分组文件夹布局两层足矣）。 */
const MAX_WALK_DEPTH = 6;

/**
 * 扫描全部可配置资源（本地 + 包）：
 * - 本地 skills：全局 <agentDir>/skills + ~/.agents/skills，项目 <root>/.pi/skills +
 *   <root>/.agents/skills（无 root 跳过项目根）；
 * - 本地扩展：<agentDir>/extensions + <root>/.pi/extensions（复用 scanLocalExtensions）；
 * - 包资源：每个（dedupe 后）包条目按 scope 解析安装根，扫约定目录 skills/ 与 extensions/
 *   （未安装/目录缺失 → 该包零贡献）。
 * 结果按 name 字母序排序；同 id 首见优先。
 */
export async function scanModeInventory(
  agentDir: string,
  homeDir: string,
  projectRoot: string | undefined,
  packages: ReadonlyArray<{ source: string; scope: ExtensionScope }>,
): Promise<ModeInventory> {
  const skills: ModeSkill[] = [];
  const extensions: ModeExtension[] = [];
  const seen = new Set<string>();

  // 本地 skills（v1 四根逻辑，id/pattern 升级为复合键/排除体）
  const skillRoots: SkillRoot[] = [
    { dir: path.join(agentDir, "skills"), scope: "global", style: "pi" },
    { dir: path.join(homeDir, ".agents", "skills"), scope: "global", style: "agents" },
  ];
  if (projectRoot) {
    skillRoots.push(
      { dir: path.join(projectRoot, ".pi", "skills"), scope: "project", style: "pi" },
      { dir: path.join(projectRoot, ".agents", "skills"), scope: "project", style: "agents" },
    );
  }
  for (const root of skillRoots) {
    await collectLocalSkills(root, skills, seen);
  }

  // 本地扩展（复用扩展弹层同款扫描；pattern = baseDir 相对 posix 路径）
  const projectConfigDirPath = projectRoot ? path.join(projectRoot, ".pi") : undefined;
  const localExts = await scanLocalExtensions(
    path.join(agentDir, "extensions"),
    projectConfigDirPath ? path.join(projectConfigDirPath, "extensions") : undefined,
  );
  for (const item of localExts) {
    const baseDir = item.scope === "global" ? agentDir : projectConfigDirPath;
    if (!baseDir) {
      continue;
    }
    pushUnique(extensions, seen, {
      id: `local|${item.scope}|${posixRel(baseDir, item.id)}`,
      pattern: posixRel(baseDir, item.id),
      name: item.name,
      scope: item.scope,
    });
  }

  // 包资源（约定目录；未安装/缺目录 → 零贡献）
  for (const pkg of packages) {
    const identity = packageIdentity(pkg.source, pkg.scope === "project" ? projectConfigDirPath : agentDir);
    const rootDir = installedPackageRoot(pkg.source, pkg.scope, agentDir, projectRoot);
    if (!rootDir) {
      continue;
    }
    const display = packageDisplayName(pkg.source);
    await collectPackageSkills(path.join(rootDir, "skills"), identity, display, skills, seen);
    const pkgExts = await collectLocalExtensions(path.join(rootDir, "extensions"), "global");
    for (const item of pkgExts) {
      pushUnique(extensions, seen, {
        id: `pkg|${identity}|${posixRel(rootDir, item.id)}`,
        pattern: posixRel(rootDir, item.id),
        name: item.name,
        scope: "package",
        package: display,
        identity,
      });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  extensions.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { skills, extensions };
}

/** 本地 skill 根扫描（pi 式根 .md + SKILL.md 目录递归；agents 式仅目录）。 */
async function collectLocalSkills(root: SkillRoot, out: ModeSkill[], seen: Set<string>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root.dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在/不可读：正常（未配置该项目/目录）
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || name === "node_modules" || entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isFile() && root.style === "pi" && name.endsWith(".md")) {
      const fm = parseSkillFrontmatter(await readFileOrEmpty(path.join(root.dir, name)));
      if (fm.description) {
        pushUnique(out, seen, {
          id: `local|${root.scope}|${name}`,
          pattern: name,
          name: fm.name ?? name,
          description: fm.description,
          scope: root.scope,
        });
      }
    }
  }
  await walkSkillDirs(root.dir, root, out, seen, 1);
}

/** 递归找含 SKILL.md 的目录（命中即收录并停止下探）。 */
async function walkSkillDirs(
  dir: string,
  root: SkillRoot,
  out: ModeSkill[],
  seen: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) {
    return;
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const sub = path.join(dir, entry.name);
    if (await fileExists(path.join(sub, "SKILL.md"))) {
      const fm = parseSkillFrontmatter(await readFileOrEmpty(path.join(sub, "SKILL.md")));
      pushUnique(out, seen, {
        id: `local|${root.scope}|${entry.name}`,
        pattern: entry.name,
        name: fm.name ?? entry.name,
        description: fm.description,
        scope: root.scope,
      });
      continue; // 命中即停（skill 目录内不再发现嵌套 skill）
    }
    await walkSkillDirs(sub, root, out, seen, depth + 1);
  }
}

/** 包 skills 约定目录扫描：SKILL.md 子目录（pattern = 包根相对目录路径）+ 根 .md。 */
async function collectPackageSkills(
  skillsDir: string,
  identity: string,
  display: string,
  out: ModeSkill[],
  seen: Set<string>,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return; // 无约定 skills 目录：该包零 skill 贡献
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      const sub = path.join(skillsDir, entry.name);
      if (await fileExists(path.join(sub, "SKILL.md"))) {
        const fm = parseSkillFrontmatter(await readFileOrEmpty(path.join(sub, "SKILL.md")));
        pushUnique(out, seen, {
          id: `pkg|${identity}|skills/${entry.name}`,
          pattern: `skills/${entry.name}`, // 包根相对路径（applyPatterns 的 parentRel 命中）
          name: fm.name ?? entry.name,
          description: fm.description,
          scope: "package",
          package: display,
          identity,
        });
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const fm = parseSkillFrontmatter(await readFileOrEmpty(path.join(skillsDir, entry.name)));
      if (fm.description) {
        pushUnique(out, seen, {
          id: `pkg|${identity}|skills/${entry.name}`,
          pattern: `skills/${entry.name}`,
          name: fm.name ?? entry.name,
          description: fm.description,
          scope: "package",
          package: display,
          identity,
        });
      }
    }
  }
}

function pushUnique<T extends { id: string }>(out: T[], seen: Set<string>, item: T): void {
  if (seen.has(item.id)) {
    return;
  }
  seen.add(item.id);
  out.push(item);
}

/** posix 相对路径（toPosixPath(relative(base, p))，对齐 pi 匹配前的归一）。 */
function posixRel(base: string, p: string): string {
  return path.relative(base, p).split(path.sep).join("/");
}

async function readFileOrEmpty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------
// 应用计划（纯决策层；写盘在 controller）
// -------------------------------------------------------------------------

/** 应用计划：本地排除组（按 scope，写入 settings skills/extensions 数组）+ 包排除（按 identity）。 */
export interface ModeApplyPlan {
  localSkills: { global: string[]; project: string[] };
  localExtensions: { global: string[]; project: string[] };
  /** identity → 该包需排除的 skills/extensions 模式体（空数组项不出现在键里）。 */
  packageExclusions: Map<string, { skills: string[]; extensions: string[] }>;
}

/**
 * 模式状态 → 应用计划：Default（active = null 或指向已删模式）= 全空；
 * 否则本地资源按 scope 分组排除、包资源按 identity 分组排除。
 */
export function modeApplyPlan(state: ModesState, scan: ModeInventory): ModeApplyPlan {
  const plan: ModeApplyPlan = {
    localSkills: { global: [], project: [] },
    localExtensions: { global: [], project: [] },
    packageExclusions: new Map(),
  };
  const active = state.active ? state.modes.find((m) => m.name === state.active) : undefined;
  if (!active) {
    return plan; // Default：无排除（全部生效）
  }
  const selectedSkills = new Set(active.skills);
  for (const s of scan.skills) {
    if (selectedSkills.has(s.id)) {
      continue;
    }
    if (s.scope === "package") {
      groupPackage(plan.packageExclusions, s.identity, s.pattern, "skills");
    } else {
      plan.localSkills[s.scope].push(s.pattern);
    }
  }
  const selectedExts = new Set(active.extensions);
  for (const e of scan.extensions) {
    if (selectedExts.has(e.id)) {
      continue;
    }
    if (e.scope === "package") {
      groupPackage(plan.packageExclusions, e.identity, e.pattern, "extensions");
    } else {
      plan.localExtensions[e.scope].push(e.pattern);
    }
  }
  return plan;
}

function groupPackage(
  map: ModeApplyPlan["packageExclusions"],
  identity: string | undefined,
  pattern: string,
  kind: "skills" | "extensions",
): void {
  if (!identity) {
    return; // 防御：包条目缺 identity 不可能（scan 恒填），跳过
  }
  let bucket = map.get(identity);
  if (!bucket) {
    bucket = { skills: [], extensions: [] };
    map.set(identity, bucket);
  }
  bucket[kind].push(pattern);
}

/**
 * 包条目数组应用过滤计划（单 settings 文件；纯函数）：
 * - 需要过滤的 identity：首次覆写前快照原条目进基线；新条目 = 原对象浅拷贝
 *   （保留 prompts/themes 等用户自定义键）+ source + 非空的 skills/extensions `!` 排除段；
 * - 免过滤的 identity：基线有 → 还原基线（并出基线）；否则原样保留；
 * - 基线中已不在 packages 里的 identity 修剪。
 */
export function planPackageEntries(
  packages: readonly unknown[],
  exclusions: ReadonlyMap<string, { skills: string[]; extensions: string[] }>,
  baseline: Readonly<Record<string, unknown>>,
  baseDir: string,
): { packages: unknown[]; baseline: Record<string, unknown> } {
  const out: unknown[] = [];
  const nextBaseline: Record<string, unknown> = {};
  for (const entry of packages) {
    const source =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? ((entry as Record<string, unknown>).source as string | undefined)
          : undefined;
    if (typeof source !== "string" || !source) {
      out.push(entry); // 损坏条目原样保留（不放大问题）
      continue;
    }
    const identity = packageIdentity(source, baseDir);
    const ex = exclusions.get(identity);
    const needed = !!ex && (ex.skills.length > 0 || ex.extensions.length > 0);
    if (!needed) {
      // 免过滤：优先还原基线（含基线中陈旧 identity 的隐式修剪）
      out.push(baseline[identity] !== undefined ? baseline[identity] : entry);
      continue;
    }
    nextBaseline[identity] = baseline[identity] !== undefined ? baseline[identity] : entry;
    const base = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const next: Record<string, unknown> = { ...base, source };
    if (ex.skills.length > 0) {
      next.skills = ex.skills.map((p) => `!${p}`);
    } else {
      delete next.skills; // 该类型无排除 = 全量加载（省略键语义）
    }
    if (ex.extensions.length > 0) {
      next.extensions = ex.extensions.map((p) => `!${p}`);
    } else {
      delete next.extensions;
    }
    out.push(next);
  }
  return { packages: out, baseline: nextBaseline };
}

/**
 * 合并 settings `skills`/`extensions` 数组：保留全部非 `!` 字符串条目（用户手配
 * 路径/目录），`!` 段整体替换为本轮 exclusions（Pinel 托管段）。非字符串条目丢弃。
 */
export function mergeSkillsEntries(rawEntries: unknown, exclusionIds: readonly string[]): string[] {
  const kept: string[] = [];
  if (Array.isArray(rawEntries)) {
    for (const e of rawEntries) {
      if (typeof e === "string" && !e.startsWith("!")) {
        kept.push(e);
      }
    }
  }
  return [...kept, ...exclusionIds.map((id) => `!${id}`)];
}
