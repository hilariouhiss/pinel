/**
 * mode-groups 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：模式弹层的包归并分组/主勾选三态规则坏掉时编译即红。
 */
import assert from "node:assert";
import { groupPackageResources, groupCheckState } from "./src/mode-groups.ts";

const mk = (id, scope, pkg, identity) => ({ id, name: id, scope, package: pkg, identity });

// 包 skills + 包 extensions 按 identity 归并；组按 label 字母序
const groups = groupPackageResources(
  [
    mk("pkg|z|skills/a", "package", "zeta", "z"),
    mk("pkg|a|skills/b", "package", "alpha", "a"),
    mk("pkg|z|skills/c", "package", "zeta", "z"),
    mk("local|global|x", "global"), // 非包资源不入组
  ],
  [
    mk("pkg|z|exts/e1", "package", "zeta", "z"),
    mk("pkg|a|exts/e2", "package", "alpha", "a"),
    mk("local|global|e3", "global"),
  ],
);
assert.deepStrictEqual(
  groups.map((g) => [g.key, g.label, g.items.map((i) => `${i.kind}:${i.id}`)]),
  [
    ["a", "alpha", ["skill:pkg|a|skills/b", "extension:pkg|a|exts/e2"]],
    ["z", "zeta", ["skill:pkg|z|skills/a", "skill:pkg|z|skills/c", "extension:pkg|z|exts/e1"]],
  ],
  "包 skills/extensions 按 identity 归并，skill 在前 extension 在后，非包资源跳过",
);

// 仅一方有资源的包也成组
assert.deepStrictEqual(
  groupPackageResources([], [mk("pkg|z|exts/e1", "package", "zeta", "z")]).map((g) => g.key),
  ["z"],
  "仅扩展的包也成组",
);

// 包 identity 缺失时回退 package 名分组（防御路径）
assert.deepStrictEqual(
  groupPackageResources([mk("pkg|?|skills/b", "package", "alpha", undefined)], []).map((g) => g.key),
  ["alpha"],
  "identity 缺失回退 package 名",
);

// 第三参 prompts 归入同 identity 包组，排 skill/extension 之后
const withPrompts = groupPackageResources(
  [mk("pkg|z|skills/a", "package", "zeta", "z")],
  [mk("pkg|z|exts/e1", "package", "zeta", "z")],
  [mk("pkg|z|prompts/p.md", "package", "zeta", "z")],
);
assert.deepStrictEqual(
  withPrompts[0].items.map((i) => `${i.kind}:${i.id}`),
  ["skill:pkg|z|skills/a", "extension:pkg|z|exts/e1", "prompt:pkg|z|prompts/p.md"],
  "prompt 归入同 identity 包组，排 skill/extension 之后",
);

// 主勾选三态
const items = [{ id: "1" }, { id: "2" }];
assert.strictEqual(groupCheckState(items, new Set()), "none", "全未选 = none");
assert.strictEqual(groupCheckState(items, new Set(["1"])), "some", "部分 = some");
assert.strictEqual(groupCheckState(items, new Set(["1", "2"])), "all", "全选 = all");
assert.strictEqual(groupCheckState([], new Set()), "none", "空组 = none（防御）");

console.log("mode-groups check OK");
