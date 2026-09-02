/**
 * 模式弹层资源分组纯函数（无 React 依赖，可被 node 自检脚本直接跑）。
 * 包 scope 的 skills + extensions 按 identity 归并为一个包组（模式编辑器
 * 的 Extensions 区按整包开关）；非包资源不入组。
 */

/** 可分组资源的最小形状（ModeSkill / ModeExtension 均可结构赋值）。 */
export interface PackageResource {
  id: string;
  name: string;
  scope: "global" | "project" | "package";
  package?: string;
  identity?: string;
}

/** 包组内的单条资源（skill 在前、extension 在后，各保持传入序）。 */
export interface PackageGroupItem {
  id: string;
  name: string;
  kind: "skill" | "extension";
}

export interface PackageGroup {
  /** 分组键：包 identity（缺省回退 package 名）。 */
  key: string;
  /** 组头展示名（包显示名）。 */
  label: string;
  items: PackageGroupItem[];
}

/** 包 skills + 包 extensions → 按包归并分组（组按 label 字母序；非包资源跳过）。 */
export function groupPackageResources(
  skills: readonly PackageResource[],
  extensions: readonly PackageResource[],
): PackageGroup[] {
  const map = new Map<string, PackageGroup>();
  const push = (item: PackageResource, kind: PackageGroupItem["kind"]) => {
    if (item.scope !== "package") {
      return;
    }
    const key = item.identity ?? item.package ?? item.id;
    let group = map.get(key);
    if (!group) {
      group = { key, label: item.package ?? key, items: [] };
      map.set(key, group);
    }
    group.items.push({ id: item.id, name: item.name, kind });
  };
  for (const s of skills) {
    push(s, "skill");
  }
  for (const e of extensions) {
    push(e, "extension");
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** 组主勾选三态：all = 全选（checked）；some = 部分（indeterminate）；none = 未选。 */
export function groupCheckState(
  items: readonly { id: string }[],
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
