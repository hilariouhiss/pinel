/**
 * 模式弹层资源分组纯函数（无 React 依赖，可被 node 自检脚本直接跑）。
 * 包 scope 资源按 identity 归组（组头显示包名），非包资源归入单个 Local 组。
 */

/** 可分组资源的最小形状（ModeSkill / ModeExtension 均可结构赋值）。 */
export interface GroupableResource {
  id: string;
  name: string;
  scope: "global" | "project" | "package";
  package?: string;
  identity?: string;
}

export interface ResourceGroup {
  /** 分组键：包 identity（package scope）；"local" = 全部非包资源。 */
  key: string;
  /** 组头展示名：包显示名 / "Local"。 */
  label: string;
  items: GroupableResource[];
}

/** 资源清单 → 分组（包组按 label 字母序在前，Local 组恒在末位）。 */
export function groupResources(items: readonly GroupableResource[]): ResourceGroup[] {
  const pkgGroups = new Map<string, ResourceGroup>();
  const local: GroupableResource[] = [];
  for (const item of items) {
    if (item.scope === "package") {
      const key = item.identity ?? item.package ?? item.id;
      let group = pkgGroups.get(key);
      if (!group) {
        group = { key, label: item.package ?? key, items: [] };
        pkgGroups.set(key, group);
      }
      group.items.push(item);
    } else {
      local.push(item);
    }
  }
  const groups = [...pkgGroups.values()].sort((a, b) => a.label.localeCompare(b.label));
  if (local.length > 0) {
    groups.push({ key: "local", label: "Local", items: local });
  }
  return groups;
}

/** 组主勾选三态：all = 全选（checked）；some = 部分（indeterminate）；none = 未选。 */
export function groupCheckState(
  items: readonly GroupableResource[],
  selected: ReadonlySet<string>,
): "all" | "some" | "none" {
  let count = 0;
  for (const item of items) {
    if (selected.has(item.id)) {
      count += 1;
    }
  }
  if (count === 0) {
    return "none";
  }
  return count === items.length ? "all" : "some";
}
