import * as assert from "assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeCwd, parseSessionMeta, scanSessions, MAX_SCAN_LINES, MAX_PREVIEW_CHARS } from "../chat/session-history";

function header(id = "uuid-1", timestamp = "2026-08-18T01:00:00.000Z"): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/fake/project" });
}

suite("encodeCwd 单元测试", () => {
  test("POSIX 路径：/ 替换为 -，去开头斜杠，-- 包裹", () => {
    assert.strictEqual(encodeCwd("/home/user/project"), "--home-user-project--");
  });

  test("Windows 路径：盘符冒号与反斜杠替换为 -（相邻时产生双 -）", () => {
    // C:\Users\xueyu\pinel → 冒号与首个反斜杠相邻 → C--Users-xueyu-pinel
    assert.strictEqual(encodeCwd("C:\\Users\\xueyu\\pinel"), "--C--Users-xueyu-pinel--");
  });

  test("反斜杠开头路径：去开头反斜杠", () => {
    assert.strictEqual(encodeCwd("\\Users\\xueyu\\pinel"), "--Users-xueyu-pinel--");
  });

  test("仅去开头第一个 / 或 \\（非全局），后续斜杠仍替换", () => {
    // //double → 去开头首个 / → /double → 替换剩余 / → -double → 包裹
    assert.strictEqual(encodeCwd("//double"), "---double--");
  });
});

suite("parseSessionMeta 单元测试", () => {
  test("全量合法：header + session_info 名称 + 首条 user 消息预览", () => {
    const content = [
      header(),
      JSON.stringify({ type: "session_info", id: "a1", parentId: null, timestamp: "2026-08-18T01:01:00.000Z", name: "重构认证模块" }),
      JSON.stringify({ type: "message", id: "a2", parentId: "a1", timestamp: "2026-08-18T01:02:00.000Z", role: "user", message: { role: "user", content: "帮我重构认证模块，当前实现有安全问题" } }),
      JSON.stringify({ type: "message", id: "a3", parentId: "a2", timestamp: "2026-08-18T01:03:00.000Z", role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好的，开始重构" }] } }),
    ].join("\n");
    const meta = parseSessionMeta(content);
    assert.ok(meta);
    assert.strictEqual(meta!.id, "uuid-1");
    assert.strictEqual(meta!.name, "重构认证模块");
    assert.strictEqual(meta!.preview, "帮我重构认证模块，当前实现有安全问题");
    assert.strictEqual(meta!.created!.toISOString(), "2026-08-18T01:00:00.000Z");
    assert.strictEqual(meta!.truncated, false);
  });

  test("user 消息 content 数组形态（实测真实文件）：提取 text 块", () => {
    const content = [
      header(),
      JSON.stringify({ type: "message", id: "b1", parentId: null, timestamp: "2026-08-18T01:02:00.000Z", message: { role: "user", content: [{ type: "image", data: "xx", mimeType: "image/png" }, { type: "text", text: "看图说话" }] } }),
    ].join("\n");
    const meta = parseSessionMeta(content);
    assert.ok(meta);
    assert.strictEqual(meta!.preview, "看图说话");
  });

  test("多行消息预览：压成单行并截断", () => {
    const longText = `第一行\n第二行\n${"字".repeat(MAX_PREVIEW_CHARS + 50)}`;
    const content = [header(), JSON.stringify({ type: "message", id: "c1", parentId: null, timestamp: "2026-08-18T01:02:00.000Z", message: { role: "user", content: longText } })].join("\n");
    const meta = parseSessionMeta(content);
    assert.ok(meta);
    assert.ok(meta!.preview!.length <= MAX_PREVIEW_CHARS + 1); // 含省略号
    assert.ok(!meta!.preview!.includes("\n"));
    assert.ok(meta!.preview!.endsWith("…"));
  });

  test("session_info 名称取最新一条（含显式清除）", () => {
    const content = [
      header(),
      JSON.stringify({ type: "session_info", id: "d1", parentId: null, timestamp: "2026-08-18T01:01:00.000Z", name: "旧名称" }),
      JSON.stringify({ type: "session_info", id: "d2", parentId: null, timestamp: "2026-08-18T01:05:00.000Z", name: "新名称" }),
    ].join("\n");
    assert.strictEqual(parseSessionMeta(content)!.name, "新名称");
    // 显式清除：最新一条 name 为空 → undefined
    const cleared = [
      header(),
      JSON.stringify({ type: "session_info", id: "d1", parentId: null, timestamp: "2026-08-18T01:01:00.000Z", name: "旧名称" }),
      JSON.stringify({ type: "session_info", id: "d2", parentId: null, timestamp: "2026-08-18T01:05:00.000Z", name: "" }),
    ].join("\n");
    assert.strictEqual(parseSessionMeta(cleared)!.name, undefined);
  });

  test("损坏行跳过、正常条目保留", () => {
    const content = [
      header(),
      "{not valid json",
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-08-18T01:02:00.000Z", message: { role: "user", content: "正常消息" } }),
      "42",
    ].join("\n");
    const meta = parseSessionMeta(content);
    assert.ok(meta);
    assert.strictEqual(meta!.preview, "正常消息");
  });

  test("首行非 session 类型或非合法 JSON → null（整文件跳过）", () => {
    assert.strictEqual(parseSessionMeta(""), null);
    assert.strictEqual(parseSessionMeta("{not json"), null);
    assert.strictEqual(parseSessionMeta(JSON.stringify({ type: "message", id: "x" })), null);
    assert.strictEqual(parseSessionMeta("42"), null);
  });

  test("header 缺 id → null", () => {
    assert.strictEqual(parseSessionMeta(JSON.stringify({ type: "session", version: 3 })), null);
  });

  test("header.timestamp 无效 → created 缺省（不崩溃）", () => {
    const meta = parseSessionMeta(JSON.stringify({ type: "session", version: 3, id: "u", timestamp: "not-a-date" }));
    assert.ok(meta);
    assert.strictEqual(meta!.created, undefined);
  });

  test("超长文件 → truncated 标记", () => {
    const lines = [header()];
    for (let i = 0; i < MAX_SCAN_LINES + 10; i++) {
      lines.push(JSON.stringify({ type: "message", id: `f${i}`, parentId: null, timestamp: "2026-08-18T01:02:00.000Z", message: { role: "assistant", content: `第${i}条` } }));
    }
    const meta = parseSessionMeta(lines.join("\n"));
    assert.ok(meta);
    assert.strictEqual(meta!.truncated, true);
  });

  test("首条 user 消息在前 200 行内、预览取首条（后续 user 消息不覆盖）", () => {
    const content = [
      header(),
      JSON.stringify({ type: "message", id: "g1", parentId: null, timestamp: "2026-08-18T01:02:00.000Z", message: { role: "user", content: "第一个问题" } }),
      JSON.stringify({ type: "message", id: "g2", parentId: "g1", timestamp: "2026-08-18T01:03:00.000Z", message: { role: "user", content: "第二个问题" } }),
    ].join("\n");
    assert.strictEqual(parseSessionMeta(content)!.preview, "第一个问题");
  });
});

suite("scanSessions 单元测试（临时目录）", () => {
  let tmp: string;

  setup(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pinel-session-test-"));
  });

  teardown(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("默认布局：cwd 子目录 + mtime 倒序 + 损坏文件跳过", async () => {
    const dir = path.join(tmp, encodeCwd("/fake/project"));
    await fs.mkdir(dir, { recursive: true });
    const now = Date.now();
    const newer = path.join(dir, "2026-08-18T02-00-00-000Z_newer.jsonl");
    const older = path.join(dir, "2026-08-18T01-00-00-000Z_older.jsonl");
    const broken = path.join(dir, "2026-08-18T00-00-00-000Z_broken.jsonl");
    await fs.writeFile(newer, [header("newer-id"), JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-18T02:01:00.000Z", message: { role: "user", content: "新会话" } })].join("\n"));
    await fs.writeFile(older, [header("older-id", "2026-08-18T01:00:00.000Z"), JSON.stringify({ type: "session_info", id: "n1", parentId: null, timestamp: "2026-08-18T01:01:00.000Z", name: "旧会话" })].join("\n"));
    await fs.writeFile(broken, "{not a session file");
    // mtime 控制：newer 更新
    await fs.utimes(newer, new Date(now), new Date(now));
    await fs.utimes(older, new Date(now - 60_000), new Date(now - 60_000));

    const list = await scanSessions(tmp, "/fake/project");
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].path, newer); // 新的在前
    assert.strictEqual(list[0].id, "newer-id");
    assert.strictEqual(list[0].preview, "新会话");
    assert.strictEqual(list[1].id, "older-id");
    assert.strictEqual(list[1].name, "旧会话");
  });

  test("默认布局：cwd 为空（no-workspace）→ 空列表", async () => {
    assert.deepStrictEqual(await scanSessions(tmp, undefined), []);
  });

  test("默认布局：目录不存在 → 空列表", async () => {
    assert.deepStrictEqual(await scanSessions(tmp, "/no/such/dir"), []);
  });

  test("自定义布局：直接扫描根目录 jsonl（不建 cwd 子目录）", async () => {
    const a = path.join(tmp, "2026-08-18T02-00-00-000Z_a.jsonl");
    const b = path.join(tmp, "2026-08-18T01-00-00-000Z_b.jsonl");
    await fs.writeFile(a, header("a-id"));
    await fs.writeFile(b, header("b-id", "2026-08-18T01:00:00.000Z"));
    await fs.utimes(a, new Date("2026-08-18T02:00:00Z"), new Date("2026-08-18T02:00:00Z"));
    await fs.utimes(b, new Date("2026-08-18T01:00:00Z"), new Date("2026-08-18T01:00:00Z"));
    // 子目录中的文件不应被扫到（自定义布局）
    await fs.mkdir(path.join(tmp, "--fake--"), { recursive: true });
    await fs.writeFile(path.join(tmp, "--fake--", "2026-08-18T03-00-00-000Z_sub.jsonl"), header("sub-id", "2026-08-18T03:00:00.000Z"));

    const list = await scanSessions(tmp, undefined, "custom");
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, "a-id");
    assert.strictEqual(list[1].id, "b-id");
  });

  test("默认布局：Windows 盘符大小写兜底（--C-- vs --c--）", async () => {
    // 精确目录名缺失，但存在大小写不同的目录 → 命中
    await fs.mkdir(path.join(tmp, "--c--users-xueyu-pinel--"), { recursive: true });
    await fs.writeFile(path.join(tmp, "--c--users-xueyu-pinel--", "2026-08-18T01-00-00-000Z_x.jsonl"), header("loose-id"));
    const list = await scanSessions(tmp, "C:\\Users\\xueyu\\pinel");
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, "loose-id");
    // Windows 上 NTFS 大小写不敏感：dirExists 直接命中，路径保留传入大小写；
    // 断言不区分大小写（POSIX 上则命中大小写兜底分支，路径为小写形式）
    assert.ok(list[0].path.toLowerCase().includes("--c--users-xueyu-pinel--"));
  });

  test("根目录为空/不存在 → 空列表", async () => {
    assert.deepStrictEqual(await scanSessions(path.join(tmp, "nope"), undefined, "custom"), []);
  });
});
