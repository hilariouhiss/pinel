import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SettingsObject } from "./extensions";

/**
 * 智能体模式纯函数模块（无 vscode 依赖，可单测）。
 *
 * 模式 = 一组启用的本地 SKILL。切换模式把「不在激活模式里的本地 skill」写成
 * settings.json `skills` 数组的 `!id` 排除段（重启 pi 后生效）。
 *
 * 生效原理（实测 pi 0.84.2 dist/core/package-manager.js isEnabledByOverrides）：
 * - `!p` 排除按 minimatch(rel)、basename、绝对 posix 路径、SKILL.md 父目录
 *   rel/目录名/posix 路径任一命中 ⇒ `!foo` 禁用任意深度的 foo skill 目录与根文件 foo.md；
 * - 用户 scope 自动发现 skills 只受全局 settings `skills` overrides 影响，
 *   项目 scope（.pi/skills、.agents/skills）只受项目 settings 影响 ⇒ 排除须写两个文件；
 * - 包 skills 走包对象过滤，与 skills overrides 无交集 ⇒ 模式不管包 skills。
 *
 * 模式定义存全局 settings 的 `pinel.modes`（复用 pinel.autoCommit 的
 * settings.pinel 节先例）：{ active: string|null, modes: [{name, skills}] }。
 * active = null 即内置 Default 模式（无排除 = 全部本地 skills 生效）。
 * ponytail: Pinel 托管 skills 数组的整个 `!` 前缀段——用户手写的自定义排除
 * 会被模式切换重算覆盖（切回 Default 即清空）；非 `!` 条目（手配路径）恒保留。
 */

/** 模式配置（pinel.modes.modes 条目）。skills = 排除键 id 集（见 scanLocalSkills）。 */
export interface AgentMode {
  name: string;
  skills: string[];
}

/** 模式状态（pinel.modes 防御解析产物）。active = null 即 Default。 */
export interface ModesState {
  active: string | null;
  modes: AgentMode[];
}

/** 扫描出的本地 skill 条目（webview 协议镜像见 webview-ui/src/types.ts）。 */
export interface ModeSkill {
  /** 排除键：目录名（SKILL.md 所在目录）或根 .md 文件名（含 .md）——对齐 pi 匹配规则。 */
  id: string;
  /** 展示名：frontmatter name ?? id。 */
  name: string;
  description?: string;
  /** 排除项写入哪个 scope 的 settings.json。 */
  scope: "global" | "project";
}

/** 空状态（读失败/未配置）。 */
export const EMPTY_MODES_STATE: ModesState = { active: null, modes: [] };

/**
 * 防御解析 settings.pinel.modes：形状不符逐层容缺（不抛错——配置损坏时
 * 模式功能降级为空态，绝不影响其他 settings 键的读写）。
 */
export function readModesState(settings: SettingsObject): ModesState {
  const pinel = settings.pinel;
  if (!pinel || typeof pinel !== "object" || Array.isArray(pinel)) {
    return { ...EMPTY_MODES_STATE, modes: [] };
  }
  const raw = (pinel as Record<string, unknown>).modes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_MODES_STATE, modes: [] };
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
      const rawSkills = (m as Record<string, unknown>).skills;
      const skills = Array.isArray(rawSkills)
        ? rawSkills.filter((s): s is string => typeof s === "string")
        : [];
      modes.push({ name, skills });
    }
  }
  return { active, modes };
}

/** 写回 settings.pinel.modes（保留 pinel 节其余键，如 autoCommit）。 */
export function writeModesState(settings: SettingsObject, state: ModesState): void {
  const raw = settings.pinel;
  const pinel =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  pinel.modes = { active: state.active, modes: state.modes };
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

/** 单根扫描定义。style: pi = 根 .md 也算 skill；agents = 仅 SKILL.md 目录。 */
interface SkillRoot {
  dir: string;
  scope: "global" | "project";
  style: "pi" | "agents";
}

/** 扫描深度上限（防循环/超深目录；分组文件夹布局两层足矣）。 */
const MAX_WALK_DEPTH = 6;

/**
 * 扫描本地 skills（四根：全局 <agentDir>/skills + ~/.agents/skills，
 * 项目 <root>/.pi/skills + <root>/.agents/skills；无 projectRoot 跳过项目根）。
 * 目录含 SKILL.md 即 skill（id = 目录名，不再下探）；pi 式根的 .md 文件有
 * frontmatter description 即 skill（id = 文件名）；跳过 dotfiles/node_modules/
 * 符号链接目录。结果按 name 字母序排序。
 */
export async function scanLocalSkills(
  agentDir: string,
  homeDir: string,
  projectRoot?: string,
): Promise<ModeSkill[]> {
  const roots: SkillRoot[] = [
    { dir: path.join(agentDir, "skills"), scope: "global", style: "pi" },
    { dir: path.join(homeDir, ".agents", "skills"), scope: "global", style: "agents" },
  ];
  if (projectRoot) {
    roots.push(
      { dir: path.join(projectRoot, ".pi", "skills"), scope: "project", style: "pi" },
      { dir: path.join(projectRoot, ".agents", "skills"), scope: "project", style: "agents" },
    );
  }
  const seen = new Set<string>();
  const skills: ModeSkill[] = [];
  for (const root of roots) {
    await collectRoot(root, skills, seen);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return skills;
}

/** 扫描单根（根不存在/不可读 → 空贡献）。同 scope 同 id 首见优先。 */
async function collectRoot(root: SkillRoot, out: ModeSkill[], seen: Set<string>): Promise<void> {
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
      const p = path.join(root.dir, name);
      const fm = parseSkillFrontmatter(await readFileOrEmpty(p));
      if (fm.description) {
        pushSkill(out, seen, {
          id: name,
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
      pushSkill(out, seen, {
        id: entry.name,
        name: fm.name ?? entry.name,
        description: fm.description,
        scope: root.scope,
      });
      continue; // 命中即停（skill 目录内不再发现嵌套 skill）
    }
    await walkSkillDirs(sub, root, out, seen, depth + 1);
  }
}

function pushSkill(out: ModeSkill[], seen: Set<string>, skill: ModeSkill): void {
  const key = `${skill.scope}:${skill.id}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  out.push(skill);
}

/** 激活模式的排除项：未选中的本地 skills 按 scope 分组（id → 写 `!id`）。 */
export function computeExclusions(
  skills: readonly ModeSkill[],
  activeIds: ReadonlySet<string>,
): { global: string[]; project: string[] } {
  const result: { global: string[]; project: string[] } = { global: [], project: [] };
  for (const s of skills) {
    if (!activeIds.has(s.id)) {
      result[s.scope].push(s.id);
    }
  }
  return result;
}

/**
 * 模式状态 → 排除项（applyActiveMode 的纯决策层）：
 * Default（active = null 或指向已删模式）= 无排除（全部本地 skills 生效）；
 * 否则 = computeExclusions(未选中项)。
 */
export function modeExclusions(
  state: ModesState,
  skills: readonly ModeSkill[],
): { global: string[]; project: string[] } {
  const active = state.active ? state.modes.find((m) => m.name === state.active) : undefined;
  return active ? computeExclusions(skills, new Set(active.skills)) : { global: [], project: [] };
}

/**
 * 合并 settings `skills` 数组：保留全部非 `!` 字符串条目（用户手配路径/目录），
 * `!` 段整体替换为本轮 exclusions（Pinel 托管段）。非字符串/损坏条目丢弃。
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
