/**
 * mode-counts 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：ContextBar 模式感知计数规则坏掉时编译即红。
 */
import assert from "node:assert";
import { modeResourceView } from "./src/mode-counts.ts";

const mkSkill = (id, name) => ({ id, name, description: `${name} desc`, scope: "global" });
const mkExt = (id, name) => ({ id, name, scope: "global" });

const state = (active, modes, skills, extensions) => ({ active, modes, skills, extensions });

// Default（active = null）→ null（回退 live/磁盘源）
assert.strictEqual(modeResourceView(null), null, "未加载 → null");
assert.strictEqual(
  modeResourceView(state(null, [{ name: "m", skills: ["s1"], extensions: [] }], [], [])),
  null,
  "Default（active null）→ null",
);

// active 指向已删模式 → null（视为 Default）
assert.strictEqual(
  modeResourceView(state("gone", [], [mkSkill("s1", "a")], [])),
  null,
  "active 指向已删模式 → null",
);

// 自定义模式：只取勾选的 skills（按 inventory 序 + 保留 description）与扩展名
const view = modeResourceView(
  state(
    "m",
    [{ name: "m", skills: ["s2", "s1"], extensions: ["e1"] }],
    [mkSkill("s1", "alpha"), mkSkill("s2", "beta"), mkSkill("s3", "gamma")],
    [mkExt("e1", "ext-one"), mkExt("e2", "ext-two")],
  ),
);
assert.deepStrictEqual(
  view.skills.map((s) => s.name),
  ["alpha", "beta"],
  "勾选 2 个 skill，按 inventory 字母序返回",
);
assert.strictEqual(view.skills[0].description, "alpha desc", "skill description 保留");
assert.deepStrictEqual(view.extensions, ["ext-one"], "勾选 1 个扩展返回其名");

// 陈旧 id（已卸载）经 inventory 交集剔除
const stale = modeResourceView(
  state(
    "m",
    [{ name: "m", skills: ["s1", "gone"], extensions: [] }],
    [mkSkill("s1", "alpha")],
    [],
  ),
);
assert.deepStrictEqual(stale.skills.map((s) => s.name), ["alpha"], "陈旧 skill id 被交集剔除");

// 空勾选 → 空视图（minimal 模式未勾选任何资源的场景）
const empty = modeResourceView(
  state("minimal", [{ name: "minimal", skills: [], extensions: [] }], [mkSkill("s1", "alpha")], [mkExt("e1", "ext")]),
);
assert.deepStrictEqual(empty.skills, [], "空勾选 skills → []");
assert.deepStrictEqual(empty.extensions, [], "空勾选 extensions → []");

console.log("mode-counts check OK");
