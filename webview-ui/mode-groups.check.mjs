/**
 * mode-groups 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：模式弹层的包分组/主勾选三态规则坏掉时编译即红。
 */
import assert from "node:assert";
import { groupResources, groupCheckState } from "./src/mode-groups.ts";

const mk = (id, scope, pkg, identity) => ({
  id,
  name: id,
  scope,
  package: pkg,
  identity,
});

// 包组按 label 字母序、Local 恒在末位
const groups = groupResources([
  mk("pkg|z|skills/a", "package", "zeta", "z"),
  mk("pkg|a|skills/b", "package", "alpha", "a"),
  mk("pkg|z|skills/c", "package", "zeta", "z"),
  mk("local|global|x", "global"),
  mk("local|project|y", "project"),
]);
assert.deepStrictEqual(
  groups.map((g) => [g.key, g.label, g.items.map((i) => i.id)]),
  [
    ["a", "alpha", ["pkg|a|skills/b"]],
    ["z", "zeta", ["pkg|z|skills/a", "pkg|z|skills/c"]],
    ["local", "Local", ["local|global|x", "local|project|y"]],
  ],
  "包按 identity 归组排序，Local 组居末",
);

// 全包 scope 资源：无 Local 组
assert.deepStrictEqual(
  groupResources([mk("pkg|a|skills/b", "package", "alpha", "a")]).map((g) => g.key),
  ["a"],
  "无本地资源时不产出 Local 组",
);

// 包 identity 缺失时回退 package 名分组（防御路径）
assert.deepStrictEqual(
  groupResources([mk("pkg|?|skills/b", "package", "alpha", undefined)]).map((g) => g.key),
  ["alpha"],
  "identity 缺失回退 package 名",
);

// 主勾选三态
const items = [mk("1", "package", "p", "p"), mk("2", "package", "p", "p")];
assert.strictEqual(groupCheckState(items, new Set()), "none", "全未选 = none");
assert.strictEqual(groupCheckState(items, new Set(["1"])), "some", "部分 = some");
assert.strictEqual(groupCheckState(items, new Set(["1", "2"])), "all", "全选 = all");
assert.strictEqual(groupCheckState([], new Set()), "none", "空组 = none（防御）");

console.log("mode-groups check OK");
