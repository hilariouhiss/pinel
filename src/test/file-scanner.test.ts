import * as assert from "assert";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { scanWorkspaceFiles, MAX_SCAN_FILES } from "../chat/file-scanner";

suite("工作区文件扫描（@ 添加文件）单元测试", () => {
  let dir: string;

  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinel-file-scanner-"));
    // 目录结构：
    // ├─ .gitignore（忽略 dist/ 与 *.log）
    // ├─ src/a.ts / src/b.png（图片判定）
    // ├─ dist/out.js（gitignore 目录）
    // ├─ node_modules/x.js（硬编码跳过）
    // ├─ .git/HEAD（硬编码跳过）
    // └─ debug.log（gitignore 文件）
    await fs.writeFile(
      path.join(dir, ".gitignore"),
      ["dist/", "*.log", ""].join("\n"),
    );
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(dir, "src", "b.png"), "not-a-real-png");
    await fs.writeFile(path.join(dir, "src", "c.jpg"), "not-a-real-jpg");
    await fs.writeFile(path.join(dir, "dist", "out.js"), "console.log(1);\n");
    await fs.writeFile(path.join(dir, "node_modules", "x.js"), "module.exports = 1;\n");
    await fs.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(path.join(dir, "debug.log"), "log line\n");
  });

  suiteTeardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("gitignore 过滤 + 硬编码跳过 + 相对路径（/ 分隔）", async () => {
    const { items, truncated } = await scanWorkspaceFiles(dir);
    assert.strictEqual(truncated, false, "小目录不截断");
    const paths = items.map((i) => i.path).sort();
    assert.deepStrictEqual(
      paths,
      [".gitignore", "src/a.ts", "src/b.png", "src/c.jpg"],
      "dist/node_modules/.git/日志均被过滤（.gitignore 文件本身保留）",
    );
    assert.ok(paths.every((p) => !p.includes("\\")), "路径必须 / 分隔（Windows 反斜杠规范化）");
  });

  test("图片判定（扩展名表）", async () => {
    const { items } = await scanWorkspaceFiles(dir);
    const byPath = new Map(items.map((i) => [i.path, i.isImage]));
    assert.strictEqual(byPath.get("src/a.ts"), false, "ts 非图片");
    assert.strictEqual(byPath.get("src/b.png"), true, "png 图片");
    assert.strictEqual(byPath.get("src/c.jpg"), true, "jpg 图片");
  });

  test("目录剪枝（gitignore 的 dist/ 规则连带其下文件）", async () => {
    const { items } = await scanWorkspaceFiles(dir);
    assert.ok(!items.some((i) => i.path.startsWith("dist/")), "dist/ 目录整体忽略");
  });

  test("上限截断", async () => {
    // 造大量文件目录（MAX_SCAN_FILES 边界）：不落地全量文件（太慢），
    // 用单层大量文件验证截断标记与数量上限
    const bigDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinel-file-scanner-big-"));
    try {
      for (let i = 0; i < MAX_SCAN_FILES + 50; i++) {
        await fs.writeFile(path.join(bigDir, `f${i}.txt`), "x");
      }
      const { items, truncated } = await scanWorkspaceFiles(bigDir);
      assert.strictEqual(truncated, true, "超上限必须标记截断");
      assert.ok(items.length <= MAX_SCAN_FILES, "数量不超过上限");
    } finally {
      await fs.rm(bigDir, { recursive: true, force: true });
    }
  });

  test("无 .gitignore 目录：不过滤（仅硬编码跳过）", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "pinel-file-scanner-bare-"));
    try {
      await fs.writeFile(path.join(bare, "keep.txt"), "x");
      const { items } = await scanWorkspaceFiles(bare);
      assert.deepStrictEqual(items.map((i) => i.path), ["keep.txt"]);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  test("根目录不存在 → 空列表", async () => {
    const { items, truncated } = await scanWorkspaceFiles(path.join(dir, "不存在"));
    assert.deepStrictEqual(items, []);
    assert.strictEqual(truncated, false);
  });
});
