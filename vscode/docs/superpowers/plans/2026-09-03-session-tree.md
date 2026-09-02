# Pi 会话树展示（fork 血缘可视化） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「Fork from a message」后回不去——两个会话列表（聊天头下拉 `SessionListPopover` + 侧边栏 `HistoryApp`）从 mtime 平铺改为按 fork 血缘的**全展开缩进树**展示，点击任意节点即 `switch_session` 切回，父会话紧邻可见。

**Architecture:** 已实证（pi 0.84.4 源码 + 本机真实会话文件）：`fork` RPC 走 `createBranchedSession()` 落成**新会话文件**并 rebind，新文件 header 带 `parentSession`（常规 fork = 父文件绝对路径；任务/子代理会话 = 父会话 id，两种形态实测并存）。宿主扫描 `session-history.ts` 本就在解析 header，只需多解析一个字段并镜像到 webview 类型；树构建是 webview 纯函数（新模块 `session-tree.ts`，`*.check.mjs` 自检挂编译门），两个列表视图共用。**零 RPC 协议改动、零插件改动、零新依赖。**

**Tech Stack:** TypeScript 宿主（mocha tdd 单测）+ React webview（esbuild）；纯函数自检走 `node --experimental-strip-types`。

**Spec:** 本会话用户需求，经澄清确认三项决策：① 范围=**会话文件树**（不做会话内 entry 树——`navigateTree` 未暴露给 RPC，需插件桥接，收益不配成本）；② 展现位置=**两个视图都改**；③ 形态=**全展开缩进树**（无折叠状态）。

## 需求明细

1. fork 后在两个会话列表能看到血缘：子会话缩进挂在父会话下，名字带 ↳ 血缘标记。
2. 根节点按**子树内最大 modified** 倒序——刚 fork 出的活跃会话所在树浮顶，其父会话紧邻可见、一键点回。
3. 搜索（name/preview 过滤，命中行保留树深度缩进）、行内重命名、删除、Current 高亮、切换 loading 等既有行为全部不变。
4. 脏数据防御：父不在列表（已删除/跨 cwd 目录）/自指/父环（A↔B）不崩、不死循环、不丢条目（环上节点退化为根+子展示）；Windows 路径大小写与分隔符漂移可匹配。

## Global Constraints

- 零新依赖；不改 `src/rpc/protocol.ts`、不改 `../pi` 插件、不改宿主扫描/切换链路（`getSessionList` / `SessionHistoryProvider` / `panel.postSessionList` 均不动）。
- 宿主类型变更必须同步 `webview-ui/src/types.ts` 镜像（AGENTS.md 硬规则）。
- 字段命名统一 `parentSession`（header 原始值原样透传：可能是路径或 id，由 webview 侧解析时兼容两种形态）。
- 注释与提交信息中文，标识符英文；ESLint 零警告。
- `npm run compile`（含新增 `check:session-tree` 门）+ `npm test` 全绿为验收底线。
- webview 禁 import 宿主代码（架构规则 1）。

## File Structure

- Modify `vscode/src/chat/session-history.ts` — `parseSessionMeta`/`SessionMeta`/`toItem`/`SessionListItem` 解析并透传 `parentSession`
- Modify `vscode/webview-ui/src/types.ts` — `SessionListItem` 镜像加 `parentSession?: string`
- Create `vscode/webview-ui/src/session-tree.ts` — `buildSessionTree` 纯函数（树构建/排序/防环）
- Create `vscode/webview-ui/session-tree.check.mjs` — assert 自检（挂编译门）
- Modify `vscode/webview-ui/src/HistoryApp.tsx` — 平铺 map 改树行 map
- Modify `vscode/webview-ui/src/components/SessionListPopover.tsx` — 同上
- Modify `vscode/webview-ui/src/styles.css` — `.history-item-forked` 血缘样式
- Modify `vscode/package.json` — `check:session-tree` 接入 `compile`/`package` 链
- Modify `vscode/src/test/session-history.test.ts` — `parentSession` 解析单测
- Modify `vscode/AGENTS.md` — Feature Map 补一行索引

---

### Task 1: 宿主解析 parentSession（含 webview 类型镜像）

**Files:**
- Modify: `vscode/src/chat/session-history.ts`
- Modify: `vscode/webview-ui/src/types.ts`（SessionListItem）
- Test: `vscode/src/test/session-history.test.ts`

**Interfaces:**
- Consumes: 会话文件首行 header 的 `parentSession` 字段（string：绝对路径或会话 id）
- Produces: `SessionListItem.parentSession?: string`（宿主与 webview 两侧同名同型；Task 2/3/4 的树构建输入）

- [ ] **Step 1: 写失败测试**

在 `vscode/src/test/session-history.test.ts` 的 `suite("parseSessionMeta 单元测试", ...)` 内追加（沿用文件既有 `header()` 局部工具与断言风格）：

```ts
  test("header 带 parentSession（fork 路径形态）：原样透传", () => {
    const parent = "C:\\Users\\x\\.pi\\agent\\sessions\\--x--\\2026-01-01T00-00-00-000Z_uuid.jsonl";
    const meta = parseSessionMeta(
      JSON.stringify({ type: "session", version: 3, id: "u1", timestamp: "2026-08-18T01:00:00.000Z", cwd: "/p", parentSession: parent }),
    );
    assert.strictEqual(meta!.parentSession, parent);
  });

  test("header 带 parentSession（会话 id 形态，任务会话）：原样透传", () => {
    const meta = parseSessionMeta(
      JSON.stringify({ type: "session", version: 3, id: "u1", timestamp: "2026-08-18T01:00:00.000Z", cwd: "/p", parentSession: "01a04c48-305f-7437-bfe1-72f2fc9eecf7" }),
    );
    assert.strictEqual(meta!.parentSession, "01a04c48-305f-7437-bfe1-72f2fc9eecf7");
  });

  test("header 无 parentSession / 非字符串：undefined", () => {
    assert.strictEqual(parseSessionMeta(header())!.parentSession, undefined);
    assert.strictEqual(
      parseSessionMeta(JSON.stringify({ type: "session", version: 3, id: "u2", timestamp: "2026-08-18T01:00:00.000Z", cwd: "/p", parentSession: 42 }))!.parentSession,
      undefined,
    );
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd vscode && npm run compile-tests && npx vscode-test --grep "parentSession"`
Expected: 前两个新测试 FAIL（`meta!.parentSession` 为 undefined —— 字段尚未解析）；第三个（缺省即 undefined）先过

- [ ] **Step 3: 最小实现**

`vscode/src/chat/session-history.ts` 四处改动：

① `SessionListItem` 接口（`path` 字段后）加：

```ts
  /** header.parentSession 原始值：常规 fork = 父会话文件绝对路径；任务会话 = 父会话 id。 */
  parentSession?: string;
```

② `SessionMeta` 接口（`path` 字段后）加：

```ts
  /** header.parentSession 原始值（路径或 id，webview 侧树构建兼容解析）。 */
  parentSession?: string;
```

③ `ParsedSessionMeta` 接口加 `parentSession?: string;`；`parseSessionMeta` 返回对象改为：

```ts
  return {
    id,
    parentSession: typeof header.parentSession === "string" && header.parentSession ? header.parentSession : undefined,
    created: parseDate(header.timestamp),
    name,
    preview,
    truncated: lines.length - 1 > MAX_SCAN_LINES,
  };
```

④ `loadSessionMeta` 构造处加 `parentSession: parsed.parentSession`；`toItem` 加 `parentSession: m.parentSession`。

`vscode/webview-ui/src/types.ts` 的 `SessionListItem` 镜像加（放在 `preview` 后）：

```ts
  /** header.parentSession 原始值（fork 父文件路径或父会话 id）；宿主镜像。 */
  parentSession?: string;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd vscode && npm run compile-tests && npx vscode-test --grep "parentSession"`
Expected: 3 个新测试 PASS

- [ ] **Step 5: 提交**

```bash
cd vscode && git add src/chat/session-history.ts src/test/session-history.test.ts webview-ui/src/types.ts
git commit -m "feat(session-tree): 宿主解析会话 header 的 parentSession 并镜像 webview 类型"
```

---

### Task 2: webview 树构建纯函数 session-tree.ts + 编译门自检

**Files:**
- Create: `vscode/webview-ui/src/session-tree.ts`
- Create: `vscode/webview-ui/session-tree.check.mjs`
- Modify: `vscode/package.json`（compile/package 脚本链）

**Interfaces:**
- Consumes: `SessionListItem`（Task 1 的 `parentSession?: string`）
- Produces: `buildSessionTree(items: SessionListItem[]): SessionTreeRow[]`，其中 `SessionTreeRow = { item: SessionListItem; depth: number }`（根 depth=0）；`normalizeSessionPath(p: string): string`（Task 2 自检内部用）

- [ ] **Step 1: 写失败自检**

创建 `vscode/webview-ui/session-tree.check.mjs`（模式对齐 `mode-groups.check.mjs`）：

```js
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
    "环断链：a 以根兑底出现，b 挂其下（视觉退化可接受，不丢条目不死循环）",
  );
}

console.log("session-tree.check: all assertions passed");
```

- [ ] **Step 2: 跑自检确认失败**

Run: `cd vscode && node --experimental-strip-types webview-ui/session-tree.check.mjs`
Expected: FAIL（`Cannot find module .../src/session-tree.ts`）

- [ ] **Step 3: 实现 session-tree.ts**

创建 `vscode/webview-ui/src/session-tree.ts`：

```ts
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
```

- [ ] **Step 4: 跑自检确认通过**

Run: `cd vscode && node --experimental-strip-types webview-ui/session-tree.check.mjs`
Expected: `session-tree.check: all assertions passed`

- [ ] **Step 5: 接入编译门**

`vscode/package.json` 三处：scripts 加一项（放在 `check:mode-groups` 后）：

```json
    "check:session-tree": "node --experimental-strip-types webview-ui/session-tree.check.mjs",
```

`compile` 与 `package` 两条长链中，在 `npm run check:mode-groups &&` 之后各插入 `npm run check:session-tree &&`。

- [ ] **Step 6: 全量编译**

Run: `cd vscode && npm run compile`
Expected: 类型检查（宿主+webview 双 tsconfig）+ 全部 check + lint + 双 bundle 全绿

- [ ] **Step 7: 提交**

```bash
cd vscode && git add webview-ui/src/session-tree.ts webview-ui/session-tree.check.mjs package.json
git commit -m "feat(session-tree): webview 会话树构建纯函数（血缘解析/子树排序/防环）+ 编译门自检"
```

---

### Task 3: HistoryApp 侧边栏树渲染 + 样式

**Files:**
- Modify: `vscode/webview-ui/src/HistoryApp.tsx`
- Modify: `vscode/webview-ui/src/styles.css`

**Interfaces:**
- Consumes: `buildSessionTree`/`SessionTreeRow`（Task 2）、`SessionListItem.parentSession`（Task 1）
- Produces: `.history-item-forked` CSS 类约定（Task 4 复用）；行渲染契约 `{ item, depth }` 行 map 模式（Task 4 复制）

- [ ] **Step 1: 改 HistoryApp 渲染**

`vscode/webview-ui/src/HistoryApp.tsx`：

① import 行加：

```tsx
import { buildSessionTree } from "./session-tree";
```

② `import { useCallback, useEffect, useState } from "react";` 改为加 `useMemo`：

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
```

③ 过滤段（`// 本地过滤` 注释起）替换为树构建 + 行过滤（搜索命中行保留树深度缩进）：

```tsx
  // 会话树：fork 子会话缩进挂父下；根按子树最新活动排序（活跃 fork 所在树浮顶）
  const rows = useMemo(() => buildSessionTree(items), [items]);
  // 本地过滤：名称/预览包含关键词（大小写不敏感）；命中行保留 depth 缩进显示血缘
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? rows.filter(
        (r) =>
          r.item.name?.toLowerCase().includes(keyword) ||
          r.item.preview?.toLowerCase().includes(keyword),
      )
    : rows;
```

④ 列表 map 签名与容器 div 改（`filtered.map((item) => {` 一处）：

```tsx
          filtered.map(({ item, depth }) => {
            const active = item.path === currentSessionFile;
            const editing = editingPath === item.path;
            return (
              <div
                key={item.path}
                className={`history-item${active ? " active" : ""}${depth > 0 ? " history-item-forked" : ""}`}
                style={depth > 0 ? { marginLeft: Math.min(depth, 4) * 14 } : undefined}
              >
```

（map 体内其余 `item.*` 引用与编辑态分支不动——解构后名字不变。）

- [ ] **Step 2: 加样式**

`vscode/webview-ui/src/styles.css` 在 `.history-item` 规则块附近加：

```css
/* 会话树：fork 子会话缩进（marginLeft 内联）+ 名字前缀 ↳ 标记血缘（纯 CSS 无图标资源） */
.history-item-forked .history-item-name::before {
  content: "↳ ";
  opacity: 0.65;
}
```

- [ ] **Step 3: 编译**

Run: `cd vscode && npm run compile`
Expected: 全绿

- [ ] **Step 4: 手动验证（F5 开发宿主）**

前置：`cd vscode && npm run watch`（AGENTS.md 要求 F5 前必跑）。开发宿主里：打开工作区 → 侧边栏 Pinel History → 发消息 → 聊天头「分支」按钮 Fork from a message → 回到侧边栏：新会话应缩进 + ↳ 挂在父会话下且整树浮顶；点父会话行 → 切回原会话（消息完整）。

- [ ] **Step 5: 提交**

```bash
cd vscode && git add webview-ui/src/HistoryApp.tsx webview-ui/src/styles.css
git commit -m "feat(session-tree): 侧边栏会话历史按 fork 血缘树形展示"
```

---

### Task 4: SessionListPopover 聊天下拉树渲染

**Files:**
- Modify: `vscode/webview-ui/src/components/SessionListPopover.tsx`

**Interfaces:**
- Consumes: `buildSessionTree`/`SessionTreeRow`（Task 2）、`.history-item-forked`（Task 3）
- Produces: 无（叶子任务）

- [ ] **Step 1: 改 SessionListPopover 渲染**

与 Task 3 同款改动：

① import 加 `import { buildSessionTree } from "../session-tree";`，react import 的 `useEffect, useLayoutEffect, useRef, useState` 后补 `useMemo`。

② 过滤段替换：

```tsx
  // 会话树：与侧边栏 HistoryApp 同构（缩进挂父、根按子树最新活动排序）
  const rows = useMemo(() => buildSessionTree(items), [items]);
  // 本地过滤：名称/预览包含关键词（大小写不敏感）；命中行保留 depth 缩进
  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? rows.filter(
        (r) =>
          r.item.name?.toLowerCase().includes(keyword) ||
          r.item.preview?.toLowerCase().includes(keyword),
      )
    : rows;
```

③ `filtered.map((item) => {` 的容器 div 改：

```tsx
            filtered.map(({ item, depth }) => {
              const active = item.path === currentSessionFile;
              const editing = editingPath === item.path;
              return (
                <div
                  key={item.path}
                  className={`history-item${active ? " active" : ""}${depth > 0 ? " history-item-forked" : ""}`}
                  style={depth > 0 ? { marginLeft: Math.min(depth, 4) * 14 } : undefined}
                >
```

（240px 弹层内 `Math.min(depth, 4) * 14` 封顶防深层挤压内容。）

- [ ] **Step 2: 编译**

Run: `cd vscode && npm run compile`
Expected: 全绿

- [ ] **Step 3: 手动验证**

F5 开发宿主：聊天头会话历史下拉 → fork 一次 → 重新打开下拉：树形 + ↳ + 活跃树浮顶；搜索关键词命中子会话时保留缩进；点父会话行 → 切回；Current 徽标/重命名/删除行为不变。

- [ ] **Step 4: 提交**

```bash
cd vscode && git add webview-ui/src/components/SessionListPopover.tsx
git commit -m "feat(session-tree): 聊天头会话下拉按 fork 血缘树形展示"
```

---

### Task 5: 全量验证 + 文档索引

**Files:**
- Modify: `vscode/AGENTS.md`（Feature Map 索引）

**Interfaces:**
- Consumes: Task 1-4 全部产物
- Produces: 验收结论

- [ ] **Step 1: 全量质量门**

Run: `cd vscode && npm run compile && npm test && npm run package`
Expected: 三者全绿（295+ 测试含新增 3 个解析测试；check:session-tree 在 compile/package 链内）

- [ ] **Step 2: AGENTS.md Feature Map 补索引**

在 Feature Map（或 Repository Structure 对应处）会话历史条目旁补一行，说明 `webview-ui/src/session-tree.ts` 为会话树构建纯函数、`session-tree.check.mjs` 为其编译门自检、`parentSession` 双形态（路径/id）解析约定。

- [ ] **Step 3: 提交**

```bash
cd vscode && git add AGENTS.md
git commit -m "docs(session-tree): AGENTS.md 补会话树模块索引"
```

---

## 已知边界（挂账，不在本计划内）

- 单会话内 entry 树（pi `get_tree` RPC 已有、`navigateTree` 未暴露 RPC）：如需"会话内回到某分支点"体验，须经 `../pi` 插件桥接自定义命令，另立计划。
- 任务/子代理会话文件（`tasks/` 子目录）不入列表（现状扫描只读顶层 `*.jsonl`，保持不变）——树只覆盖用户 fork 血缘。
- `marginLeft` 缩进为视觉近似（非连接线树）；需要连接线时在 `.history-item-forked` 加 `border-left` 即可，纯 CSS 升级。
