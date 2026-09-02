/**
 * extension-updates 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：更新态合并/行键/可升级筛选坏掉时编译即红。
 */
import assert from "node:assert";
import { extensionRowKey, mergeExtensionUpdates, updatableItems } from "./src/extension-updates.ts";

const item = (over) => ({
  id: "npm:foo", kind: "package", name: "foo", scope: "global", enabled: true, source: "npm:foo", ...over,
});

const base = [item({}), item({ id: "bar", source: "bar", name: "bar" })];

// 行键 = React key 同构（kind:scope:id）
assert.strictEqual(extensionRowKey(base[0]), "package:global:npm:foo");

// 合并：命中行附 update/latestVersion，未命中行不动
const merged = mergeExtensionUpdates(base, [
  { id: "npm:foo", kind: "package", scope: "global", status: "available", latestVersion: "2.0.0" },
  { id: "ghost", kind: "package", scope: "global", status: "current" },
]);
assert.strictEqual(merged[0].update, "available");
assert.strictEqual(merged[0].latestVersion, "2.0.0");
assert.strictEqual(merged[0].version, undefined); // 不伪造未下发的字段
assert.strictEqual(merged[1].update, undefined);

// 空条目 → 原样（浅拷贝）
assert.deepStrictEqual(mergeExtensionUpdates(base, []), base);

// 可升级筛选：仅 update=available
assert.deepStrictEqual(updatableItems(merged).map((i) => i.id), ["npm:foo"]);
assert.deepStrictEqual(updatableItems(base), []);

console.log("extension-updates check ok");
