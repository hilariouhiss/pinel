/**
 * 插件目录纯函数模块（无 vscode 依赖，可单测）。
 *
 * 静态清单：pi-packages（@gotgenes，9）+ rpiv-mono（@juicesharp，11）= 20 项，
 * 零网络请求（ponytail: 需要版本/下载量展示时再改 registry fetch，见计划 §2.1）。
 * compat 判定来自 spike 实测（plan-plugin-catalog-integration-20260829 §7.5）：
 * - ok：RPC 模式下加载 + 交互面均可用（Pinel 既有渲染覆盖）
 * - limited：核心功能可用，部分 TUI 专属面（ctx.ui.custom picker）在 RPC 静默
 * - tui-only：交互面为 TUI overlay，RPC 下不可用（上游 issue #78 范畴）
 *
 * 安装态检测复用 extensions.ts 的 readSettings/packageIdentity：目录项 installSpec
 * 的 identity 与 settings.json packages 条目 identity 比对（npm: 去版本号）。
 */

import { packageIdentity } from "./extensions";

/** 兼容性判定（目录标注徽标）。 */
export type CatalogCompat = "ok" | "limited" | "tui-only";
/** 目录分组（对应两仓）。 */
export type CatalogGroup = "pi-packages" | "rpiv-mono";

/** 目录条目（webview 协议镜像；字段定义见 webview-ui/src/types.ts）。 */
export interface CatalogEntry {
  /** 稳定 id = 包名。 */
  id: string;
  /** 展示名（包名）。 */
  name: string;
  group: CatalogGroup;
  /** 一句话描述（对齐两仓 README）。 */
  description: string;
  /** pi install 参数（npm: 规范格式）。 */
  installSpec: string;
  compat: CatalogCompat;
  /** limited/tui-only 的一句话说明（UI 置灰标注用）。 */
  compatNote?: string;
  /** 组默认安装集成员（rpiv 三包由用户指定；见计划 §1 澄清）。 */
  defaultSet?: boolean;
}

/** 静态清单（顺序 = 目录展示顺序）。 */
export const CATALOG: readonly CatalogEntry[] = [
  // ---- pi-packages（@gotgenes）----
  { id: "pi-permission-system", name: "pi-permission-system", group: "pi-packages", installSpec: "npm:@gotgenes/pi-permission-system", compat: "ok", description: "Permission enforcement for the Pi coding agent" },
  { id: "pi-permission-model-judge", name: "pi-permission-model-judge", group: "pi-packages", installSpec: "npm:@gotgenes/pi-permission-model-judge", compat: "ok", description: "Deny-first typo-path model judge for pi-permission-system" },
  { id: "pi-subagents", name: "pi-subagents", group: "pi-packages", installSpec: "npm:@gotgenes/pi-subagents", compat: "ok", description: "Focused, in-process autonomous sub-agent core for Pi" },
  { id: "pi-github-tools", name: "pi-github-tools", group: "pi-packages", installSpec: "npm:@gotgenes/pi-github-tools", compat: "ok", description: "Deterministic GitHub CI, release, and issue tools" },
  { id: "pi-autoformat", name: "pi-autoformat", group: "pi-packages", installSpec: "npm:@gotgenes/pi-autoformat", compat: "ok", description: "Prompt-end auto-formatting (Biome, Prettier, etc.)" },
  { id: "pi-colgrep", name: "pi-colgrep", group: "pi-packages", installSpec: "npm:@gotgenes/pi-colgrep", compat: "ok", description: "Semantic code search via ColGrep as an agent tool" },
  { id: "pi-session-tools", name: "pi-session-tools", group: "pi-packages", installSpec: "npm:@gotgenes/pi-session-tools", compat: "ok", description: "Session naming and context bridge for multi-session workflows" },
  { id: "pi-subagents-worktrees", name: "pi-subagents-worktrees", group: "pi-packages", installSpec: "npm:@gotgenes/pi-subagents-worktrees", compat: "ok", description: "Git worktree isolation WorkspaceProvider for pi-subagents" },
  { id: "pi-nocd", name: "pi-nocd", group: "pi-packages", installSpec: "npm:@gotgenes/pi-nocd", compat: "ok", description: "System-prompt guard against cd-prefixing the working directory" },
  // ---- rpiv-mono（@juicesharp）——默认安装集在前（用户指定：todo/ask-user-question/voice）----
  { id: "rpiv-todo", name: "rpiv-todo", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-todo", compat: "ok", defaultSet: true, description: "Live task overlay surviving /reload" },
  { id: "rpiv-ask-user-question", name: "rpiv-ask-user-question", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-ask-user-question", compat: "ok", defaultSet: true, description: "Structured questionnaire to the user" },
  { id: "rpiv-voice", name: "rpiv-voice", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-voice", compat: "tui-only", defaultSet: true, compatNote: "Dictation overlay is TUI-only — /voice has no effect in the panel", description: "Local voice dictation (/voice overlay, on-device Whisper)" },
  { id: "rpiv-pi", name: "rpiv-pi", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-pi", compat: "ok", description: "Pipeline (skills + subagents); ships /rpiv-setup" },
  { id: "rpiv-args", name: "rpiv-args", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-args", compat: "ok", description: "$1 / $ARGUMENTS placeholders and command substitution in skills" },
  { id: "rpiv-advisor", name: "rpiv-advisor", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-advisor", compat: "limited", compatNote: "/advisor config picker is TUI-only; escalation and notify work in the panel", description: "Escalate to a stronger reviewer model" },
  { id: "rpiv-web-tools", name: "rpiv-web-tools", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-web-tools", compat: "ok", description: "Web search + fetch with pluggable providers" },
  { id: "rpiv-i18n", name: "rpiv-i18n", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-i18n", compat: "limited", compatNote: "/languages picker is TUI-only; --set flag path works", description: "Localization SDK for sibling extensions" },
  { id: "rpiv-workflow", name: "rpiv-workflow", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-workflow", compat: "ok", description: "/wf runner — chain skills into typed multi-stage pipelines" },
  { id: "rpiv-btw", name: "rpiv-btw", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-btw", compat: "tui-only", compatNote: "Side conversation uses a TUI overlay — unavailable in the panel", description: "/btw side conversation slash command" },
  { id: "rpiv-warp", name: "rpiv-warp", group: "rpiv-mono", installSpec: "npm:@juicesharp/rpiv-warp", compat: "limited", compatNote: "Notifies the Warp terminal — needs Warp running", description: "Warp terminal notification integration" },
];

/** 目录（副本，防外部修改）。 */
export function getCatalog(): CatalogEntry[] {
  return CATALOG.map((e) => ({ ...e }));
}

/** 按 id 查条目。 */
export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

/** 按组取条目（保持目录顺序）。 */
export function getCatalogGroup(group: CatalogGroup): CatalogEntry[] {
  return CATALOG.filter((e) => e.group === group);
}

/** pi-packages 整仓安装 spec（README 官方批量路径）。 */
export const PI_PACKAGES_ALL_SPEC = "git:github.com/gotgenes/pi-packages";

/** 组默认安装集 install spec 列表（按目录顺序）。 */
export function defaultInstallSpecs(group: CatalogGroup): string[] {
  return CATALOG.filter((e) => e.group === group && e.defaultSet).map((e) => e.installSpec);
}

/** 组批量安装 spec 列表：pi-packages = git 整仓 9 包；rpiv-mono = 默认集三包（用户指定）。 */
export function installSpecsForGroup(group: CatalogGroup): string[] {
  return group === "pi-packages" ? [PI_PACKAGES_ALL_SPEC] : defaultInstallSpecs("rpiv-mono");
}

/**
 * settings.json packages 条目 → 已装 identity 集合（复用 extensions.ts 归一规则：
 * npm: 去版本号）。损坏条目（非字符串/对象缺 source）忽略不抛错。
 */
export function installedIdentities(packages: unknown): Set<string> {
  const result = new Set<string>();
  if (!Array.isArray(packages)) {
    return result;
  }
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
    try {
      result.add(packageIdentity(source));
    } catch {
      // identity 归一失败（极端 URL 拼写）：原样兜底
      result.add(source);
    }
  }
  return result;
}

/** 目录项安装态（已装 = identity 命中；已装优先于 compat 标注）。 */
export function catalogInstallState(entry: CatalogEntry, installed: Set<string>): "installed" | "available" {
  return installed.has(packageIdentity(entry.installSpec)) ? "installed" : "available";
}
