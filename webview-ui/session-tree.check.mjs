/**
 * session-tree 自检（node --experimental-strip-types 直接跑 TS 纯函数模块）。
 * 挂入 npm run compile 门：会话树构建（血缘解析/排序/防环）坏掉时编译即红。
 */
import assert from "node:assert";
import { buildSessionTree, normalizeSessionPath } from "./src/session-tree.ts";

const mk = (path, id, modified, parentSession) => ({
  path, id, modified, name: id, preview: "", truncated: false, parentSession,
});

// 1) 归一化：反斜杠→斜杠 + 小写（Windows 盘符/目录大小写实测漂移）
assert.strictEqual(normalizeSessionPath("C:\\A\\B.JSONL"), "c:/a/b.jsonl");

// 2) 父子嵌套：C 指向 A → C 缩进挂 A 下；B 无父为根
{
  const A = mk("/s/a.jsonl", "a", 100);
  const B = mk("/s/b.jsonl", "b", 300);
  const C = mk("/s/c.jsonl", "c", 200, "/s/a.jsonl");
  const rows = buildSessionTree([A, B, C]);
  assert.deepStrictEqual(
    rows.map((r) => [r.item.id, r.depth]),
    [["b", 0], ["a", 0], ["c", 1]],
    "B(300) 与 A 子树(max 200) 按子树最大 modified 倒序；C 是 A 的子节点",
  );
}

// 3) 根排序键 = 子树最大 modified：旧根 A(100) 带新子 C(900) 浮到独立新根 B(500) 之上
{
  const rows = buildSessionTree([
    mk("/s/a.jsonl", "a", 100),
    mk("/s/b.jsonl", "b", 500),
    mk("/s/c.jsonl", "c", 900, "/s/a.jsonl"),
  ]);
  assert.deepStrictEqual(rows.map((r) => r.item.id), ["a", "c", "b"], "活跃 fork 所在树浮顶");
}

// 4) 同级子节点 modified 倒序 + 多级 depth
{
  const rows = buildSessionTree([
    mk("/s/a.jsonl", "a", 100),
    mk("/s/c1.jsonl", "c1", 200, "/s/a.jsonl"),
    mk("/s/c2.jsonl", "c2", 300, "/s/a.jsonl"),
    mk("/s/gc.jsonl", "gc", 400, "/s/c2.jsonl"),
  ]);
  assert.deepStrictEqual(
    rows.map((r) => [r.item.id, r.depth]),
    [["a", 0], ["c2", 1], ["gc", 2], ["c1", 1]],
  );
}

// 5) 大小写/分隔符漂移仍可匹配父（两侧同为绝对路径，仅大小写/斜杠不同）
{
  const rows = buildSessionTree([
    mk("C:\\s\\A.jsonl", "a", 100),
    mk("C:\\s\\child.jsonl", "c", 200, "C:\\S\\a.JSONL"),
  ]);
  assert.deepStrictEqual(rows.map((r) => [r.item.id, r.depth]), [["a", 0], ["c", 1]]);
}

// 6) parentSession 为父会话 id（任务会话形态）→ id 兜底匹配
{
  const rows = buildSessionTree([
    mk("/s/a.jsonl", "01a0-a", 100),
    mk("/s/t.jsonl", "01a0-t", 200, "01a0-a"),
  ]);
  assert.deepStrictEqual(rows.map((r) => [r.item.id, r.depth]), [["01a0-a", 0], ["01a0-t", 1]]);
}

// 7) 父缺失（已删/跨 cwd）→ 根；自指 → 根
{
  const rows = buildSessionTree([
    mk("/s/x.jsonl", "x", 100, "/s/gone.jsonl"),
    mk("/s/y.jsonl", "y", 50, "/s/y.jsonl"),
  ]);
  assert.deepStrictEqual(rows.map((r) => [r.item.id, r.depth]), [["x", 0], ["y", 0]]);
}

// 8) 父环（A↔B 脏数据）：不死循环、不丢条目（环上节点以根兜底出现）
{
  const rows = buildSessionTree([
    mk("/s/a.jsonl", "a", 100, "/s/b.jsonl"),
    mk("/s/b.jsonl", "b", 200, "/s/a.jsonl"),
  ]);
  assert.strictEqual(rows.length, 2, "环上两个条目都在");
  assert.deepStrictEqual(
    rows.map((r) => [r.item.id, r.depth]),
    [["a", 0], ["b", 1]],
    "环断链：a 以根兜底出现，b 挂其下（视觉退化可接受，不丢条目不死循环）",
  );
}

console.log("session-tree.check: all assertions passed");
