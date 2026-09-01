import type { ExtensionItem, ExtensionUpdateEntry } from "./types";

/**
 * 扩展更新态 webview 纯逻辑：行键（与 ExtensionPopover React key 同构）、
 * 列表合并（App 双状态 extensions + updateEntries 的 useMemo 产物）、可升级筛选。
 */

/** 行键（kind:scope:id，与 ExtensionPopover 渲染 key 一致）。 */
export function extensionRowKey(item: Pick<ExtensionItem, "kind" | "scope" | "id">): string {
  return `${item.kind}:${item.scope}:${item.id}`;
}

/** 合并更新态到列表（返回新数组；无匹配条目的行保持原状）。 */
export function mergeExtensionUpdates(
  items: ExtensionItem[],
  entries: ExtensionUpdateEntry[],
): ExtensionItem[] {
  const byKey = new Map(entries.map((e) => [extensionRowKey(e), e]));
  return items.map((i) => {
    const e = byKey.get(extensionRowKey(i));
    return e ? { ...i, update: e.status, latestVersion: e.latestVersion } : i;
  });
}

/** 有更新可升级的行（Update all 目标）。 */
export function updatableItems(items: ExtensionItem[]): ExtensionItem[] {
  return items.filter((i) => i.update === "available");
}
