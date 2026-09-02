import * as assert from "assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeCwd, parseSessionMeta, scanSessions, appendSessionName, MAX_SCAN_LINES, MAX_PREVIEW_CHARS } from "../chat/session-history";

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

suite("appendSessionName 单元测试", () => {
  let tmp: string;
  let file: string;

  setup(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pinel-append-name-"));
    file = path.join(tmp, "2026-08-18T01-00-00-000Z_uuid.jsonl");
  });

  teardown(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeSession(lines: string[]): Promise<void> {
    await fs.writeFile(file, lines.join("\n"));
  }

  function msgEntry(id: string, parentId: string | null, role: string, content: string): string {
    return JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: "2026-08-18T01:02:00.000Z",
      message: { role, content },
    });
  }

  test("正常追加：session_info 条目可被 parseSessionMeta 解析为最新名称", async () => {
    await writeSession([
      header(),
      msgEntry("a1", null, "user", "第一条消息"),
      msgEntry("a2", "a1", "assistant", "回复"),
    ]);
    await appendSessionName(file, "重构认证模块");
    const content = await fs.readFile(file, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    assert.strictEqual(lines.length, 4);
    const info = JSON.parse(lines[3]) as Record<string, unknown>;
    assert.strictEqual(info.type, "session_info");
    assert.strictEqual(info.parentId, "a2"); // leaf = 最后一个非 header 条目的 id
    assert.strictEqual(info.name, "重构认证模块");
    assert.match(info.id as string, /^[0-9a-f]{8}$/); // uuid8
    assert.strictEqual(typeof info.timestamp, "string");
    // 显示层读取到最新名称
    assert.strictEqual(parseSessionMeta(content)?.name, "重构认证模块");
  });

  test("名称清洗：\r\n 压成空格 + trim（对齐 pi appendSessionInfo）", async () => {
    await writeSession([header(), msgEntry("b1", null, "user", "消息")]);
    await appendSessionName(file, "  多行\r\n名称\n第二行  ");
    assert.strictEqual(parseSessionMeta(await fs.readFile(file, "utf8"))?.name, "多行 名称 第二行");
  });

  test("仅 header 的会话：parentId 为 null（对齐 pi leafId 初始值）", async () => {
    await writeSession([header()]);
    await appendSessionName(file, "空会话命名");
    const content = await fs.readFile(file, "utf8");
    const info = JSON.parse(content.split("\n").filter((l) => l.trim())[1]) as Record<string, unknown>;
    assert.strictEqual(info.type, "session_info");
    assert.strictEqual(info.parentId, null);
  });

  test("追加不覆盖既有名称：最新一条生效（重命名两次取后一次）", async () => {
    await writeSession([header(), msgEntry("c1", null, "user", "消息")]);
    await appendSessionName(file, "旧名");
    await appendSessionName(file, "新名");
    assert.strictEqual(parseSessionMeta(await fs.readFile(file, "utf8"))?.name, "新名");
  });

  test("损坏文件：坏行跳过（对齐 pi parseSessionEntryLine），仍可追加", async () => {
    await writeSession([header(), "{not-json", msgEntry("d1", null, "user", "消息")]);
    await appendSessionName(file, "坏文件命名");
    // 坏行被跳过，leaf 取最后合法条目 d1
    const content = await fs.readFile(file, "utf8");
    const info = JSON.parse(content.split("\n").filter((l) => l.trim()).pop()!) as Record<string, unknown>;
    assert.strictEqual(info.parentId, "d1");
    assert.strictEqual(parseSessionMeta(content)?.name, "坏文件命名");
  });

  test("id 查重：不与既有条目 id 冲突", async () => {
    // 构造一个既有 id 恰好为固定 uuid8 的文件（查重需跳过它）——用固定种子不可行，
    // 改为断言：追加生成的 id 不在既有 id 集合内（覆盖多条目场景）
    await writeSession([
      header(),
      msgEntry("00000001", null, "user", "消息"),
      msgEntry("00000002", "00000001", "assistant", "回复"),
    ]);
    await appendSessionName(file, "查重命名");
    const content = await fs.readFile(file, "utf8");
    const info = JSON.parse(content.split("\n").filter((l) => l.trim()).pop()!) as Record<string, unknown>;
    assert.notStrictEqual(info.id, "00000001");
    assert.notStrictEqual(info.id, "00000002");
  });

  test("空名：抛错（调用方应提前拦截，双保险）", async () => {
    await writeSession([header()]);
    await assert.rejects(appendSessionName(file, "   \r\n "), /会话名称不能为空/);
  });

  test("文件尾无换行：先补 \\n 再追加（防粘连成坏 JSON 行）", async () => {
    // writeSession 用 join 不追加尾换行 → 构造无尾换行文件
    await fs.writeFile(file, [header(), msgEntry("e1", null, "user", "无尾换行")].join("\n"));
    await appendSessionName(file, "补换行");
    const content = await fs.readFile(file, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    assert.strictEqual(lines.length, 3); // 追加行独立成行，未与末行粘连
    assert.strictEqual(parseSessionMeta(content)?.name, "补换行");
  });

  test("文件不存在：抛错", async () => {
    await assert.rejects(appendSessionName(path.join(tmp, "nope.jsonl"), "任意名"), /Failed to read session file/);
  });
});
