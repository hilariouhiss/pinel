import type { SessionListItem } from "./types";

/** 树行：条目 + 祖先深度（根 0）；depth 仅用于渲染缩进。 */
export interface SessionTreeRow {
  item: SessionListItem;
  depth: number;
}

/** 路径归一：反斜杠→斜杠 + 小写（Windows 盘符/目录大小写实测存在漂移）。 */
export function normalizeSessionPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/**
 * 会话文件树 → 全展开行序列（DFS 先序）。
 *
 * 父解析（header.parentSession 原始值，两种形态实测并存）：
 * - 常规 fork：父会话文件绝对路径（pi createBranchedSession 落盘）
 * - 任务/子代理会话：父会话 header.id
 * 先按归一化路径匹配，再退回 id 匹配。
 *
 * 排序：根按「子树内最大 modified」倒序——刚 fork 出的活跃会话所在树浮顶，
 * 父会话紧邻可见、一键点回；同级子节点按 modified 倒序。
 *
 * 脏数据防御：父不在列表（已删/跨 cwd）→ 根；自指 → 根；父环（A↔B）→
 * visited 断链 + 不可达条目以根行兜底，不死循环、不丢条目。
 */
export function buildSessionTree(items: SessionListItem[]): SessionTreeRow[] {
  const byPath = new Map<string, SessionListItem>();
  const byId = new Map<string, SessionListItem>();
  for (const it of items) {
    byPath.set(normalizeSessionPath(it.path), it);
    byId.set(it.id, it);
  }
  const childrenOf = new Map<SessionListItem, SessionListItem[]>();
  const roots: SessionListItem[] = [];
  for (const it of items) {
    const raw = it.parentSession;
    const hit = raw ? (byPath.get(normalizeSessionPath(raw)) ?? byId.get(raw)) : undefined;
    const parent = hit && hit !== it ? hit : undefined; // 自指/未解析到 → 根
    if (parent) {
      const list = childrenOf.get(parent);
      if (list) {
        list.push(it);
      } else {
        childrenOf.set(parent, [it]);
      }
    } else {
      roots.push(it);
    }
  }
  const byNewestDesc = (a: SessionListItem, b: SessionListItem) => b.modified - a.modified;
  for (const list of childrenOf.values()) {
    list.sort(byNewestDesc);
  }
  // 根排序键 = 子树最大 modified（环防御：memo 先写自身再递归，环上取到已写值即返回）
  const newestMemo = new Map<SessionListItem, number>();
  const subtreeNewest = (it: SessionListItem): number => {
    const memo = newestMemo.get(it);
    if (memo !== undefined) {
      return memo;
    }
    newestMemo.set(it, it.modified);
    let max = it.modified;
    for (const c of childrenOf.get(it) ?? []) {
      max = Math.max(max, subtreeNewest(c));
    }
    newestMemo.set(it, max);
    return max;
  };
  roots.sort((a, b) => subtreeNewest(b) - subtreeNewest(a));
  const rows: SessionTreeRow[] = [];
  const visited = new Set<SessionListItem>();
  const walk = (it: SessionListItem, depth: number): void => {
    if (visited.has(it)) {
      return; // 环断链
    }
    visited.add(it);
    rows.push({ item: it, depth });
    for (const c of childrenOf.get(it) ?? []) {
      walk(c, depth + 1);
    }
  };
  for (const r of roots) {
    walk(r, 0);
  }
  // 不在任何根可达集内的条目（环上节点）兜底为根行，保证列表不丢条目
  for (const it of items) {
    if (!visited.has(it)) {
      walk(it, 0);
    }
  }
  return rows;
}
