import * as assert from "assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultAgentDir,
  installedPackageRoot,
  isPinnedNpmSpec,
  packageDisplayName,
  packageIdentity,
  packageSourceKind,
  parseNpmSpec,
  projectConfigDir,
  readPackageVersion,
  resolveAgentDir,
  scanLocalExtensions,
  scanPackages,
  setLocalExtensionEnabled,
  setPackageEnabled,
  uninstallLocalExtension,
} from "../chat/extensions";

/** 建临时目录，测试结束清理。 */
async function tmpdir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function write(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
}

suite("resolveAgentDir", () => {
  test("优先 PI_CODING_AGENT_DIR env", () => {
    assert.strictEqual(
      resolveAgentDir("/home/u", { PI_CODING_AGENT_DIR: "/custom/agent" }),
      "/custom/agent",
    );
  });

  test("空 env 回退 ~/.pi/agent", () => {
    assert.strictEqual(resolveAgentDir("/home/u", {}), path.join("/home/u", ".pi", "agent"));
    assert.strictEqual(resolveAgentDir("/home/u", { PI_CODING_AGENT_DIR: "  " }), path.join("/home/u", ".pi", "agent"));
  });

  test("defaultAgentDir 使用 os.homedir + process.env（真实环境不抛错）", () => {
    assert.ok(defaultAgentDir().length > 0);
  });

  test("projectConfigDir 拼接 .pi", () => {
    assert.strictEqual(projectConfigDir("/ws"), path.join("/ws", ".pi"));
  });
});

suite("packageDisplayName", () => {
  test("npm 裸名 / 带版本 / scope", () => {
    assert.strictEqual(packageDisplayName("npm:pi-web-access"), "pi-web-access");
    assert.strictEqual(packageDisplayName("npm:pi-web-access@1.0.0"), "pi-web-access");
    assert.strictEqual(packageDisplayName("npm:@scope/pkg"), "pkg");
    assert.strictEqual(packageDisplayName("npm:@scope/pkg@2.0.0"), "pkg");
  });

  test("git / url / 本地路径", () => {
    assert.strictEqual(packageDisplayName("git:github.com/user/repo@v1"), "repo");
    assert.strictEqual(packageDisplayName("https://github.com/user/repo@v1"), "repo");
    assert.strictEqual(packageDisplayName("/abs/path/my-ext"), "my-ext");
    assert.strictEqual(packageDisplayName("./rel/ext-dir"), "ext-dir");
  });
});

suite("packageIdentity", () => {
  test("npm 去版本（含 scope）", () => {
    assert.strictEqual(packageIdentity("npm:pi-web-access"), "npm:pi-web-access");
    assert.strictEqual(packageIdentity("npm:pi-web-access@1.0.0"), "npm:pi-web-access");
    assert.strictEqual(packageIdentity("npm:@scope/pkg@2.0.0"), "npm:@scope/pkg");
  });

  test("git:/URL 归一 host/path（去 ref/用户/端口/.git）", () => {
    assert.strictEqual(packageIdentity("git:github.com/user/repo@v1"), "git:github.com/user/repo");
    assert.strictEqual(packageIdentity("https://github.com/user/repo"), "git:github.com/user/repo");
    assert.strictEqual(packageIdentity("https://github.com/user/repo@v1"), "git:github.com/user/repo");
    assert.strictEqual(
      packageIdentity("ssh://git@github.com:22/user/repo.git"),
      "git:github.com/user/repo",
    );
  });

  test("本地路径按 baseDir 绝对化", () => {
    assert.strictEqual(packageIdentity("./rel/ext"), "local:" + path.resolve("./rel/ext"));
    assert.strictEqual(
      packageIdentity("./rel/ext", "/ws/.pi"),
      "local:" + path.resolve("/ws/.pi", "./rel/ext"),
    );
  });
});

suite("scanLocalExtensions", () => {
  test("布局：顶层 .ts/.js + 子目录 index.ts + .disabled 判定", async () => {
    const dir = await tmpdir("pinel-ext-");
    try {
      await write(path.join(dir, "foo.ts"), "export default () => {}");
      await write(path.join(dir, "bar.js"), "module.exports = () => {}");
      await write(path.join(dir, "off.ts.disabled"), "export default () => {}");
      await write(path.join(dir, "sub", "index.ts"), "export default () => {}");
      await write(path.join(dir, "suboff", "index.js.disabled"), "module.exports = () => {}");
      await write(path.join(dir, "skip.txt"), "not an extension");

      const items = await scanLocalExtensions(dir);
      const byName = new Map(items.map((i) => [i.name, i]));
      assert.strictEqual(items.length, 5);
      assert.strictEqual(byName.get("foo")?.enabled, true);
      assert.strictEqual(byName.get("bar")?.enabled, true);
      assert.strictEqual(byName.get("off")?.enabled, false);
      assert.strictEqual(byName.get("off")?.id, path.join(dir, "off.ts"));
      assert.strictEqual(byName.get("sub")?.enabled, true);
      assert.strictEqual(byName.get("sub")?.source, path.join(dir, "sub")); // 目录样式卸载目标=目录
      assert.strictEqual(byName.get("suboff")?.enabled, false);
      assert.ok(!byName.has("skip"));
      for (const i of items) {
        assert.strictEqual(i.scope, "global");
        assert.strictEqual(i.kind, "local");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("跳过 dotfiles 与 node_modules", async () => {
    const dir = await tmpdir("pinel-ext-");
    try {
      await write(path.join(dir, ".hidden.ts"), "x");
      await write(path.join(dir, "node_modules", "pkg", "index.ts"), "x");
      await write(path.join(dir, "real.ts"), "x");
      const items = await scanLocalExtensions(dir);
      assert.deepStrictEqual(items.map((i) => i.name), ["real"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test(".gitignore 过滤（目录尾斜杠）", async () => {
    const dir = await tmpdir("pinel-ext-");
    try {
      await write(path.join(dir, ".gitignore"), "ignored/\nvendor.ts\n");
      await write(path.join(dir, "ignored", "index.ts"), "x");
      await write(path.join(dir, "vendor.ts"), "x");
      await write(path.join(dir, "kept.ts"), "x");
      const items = await scanLocalExtensions(dir);
      assert.deepStrictEqual(items.map((i) => i.name), ["kept"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("目录不存在 → 空列表；全局+项目合并", async () => {
    const g = await tmpdir("pinel-ext-g-");
    const p = await tmpdir("pinel-ext-p-");
    try {
      await write(path.join(g, "g.ts"), "x");
      await write(path.join(p, "p.ts"), "x");
      const items = await scanLocalExtensions(path.join(g, "missing"), p);
      assert.deepStrictEqual(items.map((i) => i.name), ["p"]);
      assert.strictEqual(items[0].scope, "project");
    } finally {
      await fs.rm(g, { recursive: true, force: true });
      await fs.rm(p, { recursive: true, force: true });
    }
  });
});

suite("setLocalExtensionEnabled", () => {
  test("禁用/启用重命名往返（文件样式）", async () => {
    const dir = await tmpdir("pinel-ext-");
    try {
      const file = path.join(dir, "foo.ts");
      await write(file, "x");
      await setLocalExtensionEnabled(file, false);
      assert.ok(await exists(`${file}.disabled`));
      assert.ok(!(await exists(file)));
      await setLocalExtensionEnabled(file, true);
      assert.ok(await exists(file));
      assert.ok(!(await exists(`${file}.disabled`)));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

suite("uninstallLocalExtension", () => {
  test("文件样式：删除文件 + .disabled 变体", async () => {
    const dir = await tmpdir("pinel-ext-");
    try {
      const file = path.join(dir, "foo.ts");
      await write(`${file}.disabled`, "x");
      await uninstallLocalExtension(file);
      assert.ok(!(await exists(`${file}.disabled`)));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("目录样式：递归删除目录", async () => {
    const dir = await tmpdir("pinel-ext-");
    try {
      await write(path.join(dir, "sub", "index.ts"), "x");
      await write(path.join(dir, "sub", "helper.ts"), "x");
      await uninstallLocalExtension(path.join(dir, "sub"));
      assert.ok(!(await exists(path.join(dir, "sub"))));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

suite("scanPackages", () => {
  async function withSettings(content: string): Promise<string> {
    const dir = await tmpdir("pinel-settings-");
    const p = path.join(dir, "settings.json");
    await write(p, content);
    return p;
  }

  test("字符串=启用；对象全类型空数组=禁用；部分过滤=启用+filtered；autoload:false=禁用", async () => {
    const p = await withSettings(
      JSON.stringify({
        packages: [
          "npm:a",
          { source: "npm:b", extensions: [], skills: [], prompts: [], themes: [] },
          { source: "npm:c", extensions: [] },
          { source: "npm:d", autoload: false },
        ],
      }),
    );
    try {
      const items = await scanPackages(p);
      const byId = new Map(items.map((i) => [i.id, i]));
      assert.strictEqual(items.length, 4);
      assert.deepStrictEqual(
        { enabled: byId.get("npm:a")?.enabled, filtered: byId.get("npm:a")?.filtered },
        { enabled: true, filtered: undefined },
      );
      assert.deepStrictEqual(
        { enabled: byId.get("npm:b")?.enabled, filtered: byId.get("npm:b")?.filtered },
        { enabled: false, filtered: undefined },
      );
      assert.deepStrictEqual(
        { enabled: byId.get("npm:c")?.enabled, filtered: byId.get("npm:c")?.filtered },
        { enabled: true, filtered: true },
      );
      assert.strictEqual(byId.get("npm:d")?.enabled, false);
      for (const i of items) {
        assert.strictEqual(i.kind, "package");
        assert.strictEqual(i.scope, "global");
      }
    } finally {
      await fs.rm(path.dirname(p), { recursive: true, force: true });
    }
  });

  test("packages 非数组 / 文件不存在 → 空列表（不抛错）", async () => {
    const p = await withSettings(JSON.stringify({ packages: "oops" }));
    try {
      assert.deepStrictEqual(await scanPackages(p), []);
    } finally {
      await fs.rm(path.dirname(p), { recursive: true, force: true });
    }
    const dir = await tmpdir("pinel-settings-");
    try {
      assert.deepStrictEqual(await scanPackages(path.join(dir, "nope.json")), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("全局+项目合并（scope 区分）", async () => {
    const g = await withSettings(JSON.stringify({ packages: ["npm:g"] }));
    const p = await withSettings(JSON.stringify({ packages: ["npm:p"] }));
    try {
      const items = await scanPackages(g, p);
      assert.strictEqual(items.length, 2);
      assert.strictEqual(items.find((i) => i.id === "npm:g")?.scope, "global");
      assert.strictEqual(items.find((i) => i.id === "npm:p")?.scope, "project");
    } finally {
      await fs.rm(path.dirname(g), { recursive: true, force: true });
      await fs.rm(path.dirname(p), { recursive: true, force: true });
    }
  });
});

suite("setPackageEnabled", () => {
  test("字符串 → 禁用：写入对象空数组，保留其他键", async () => {
    const dir = await tmpdir("pinel-settings-");
    const p = path.join(dir, "settings.json");
    await write(p, JSON.stringify({ defaultModel: "m1", packages: ["npm:a", "npm:b"] }));
    try {
      await setPackageEnabled(p, "npm:a", false);
      const parsed = JSON.parse(await fs.readFile(p, "utf8")) as Record<string, unknown>;
      assert.strictEqual(parsed.defaultModel, "m1");
      assert.deepStrictEqual(parsed.packages, [
        { source: "npm:a", extensions: [], skills: [], prompts: [], themes: [] },
        "npm:b",
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("禁用 → 启用：恢复字符串形式", async () => {
    const dir = await tmpdir("pinel-settings-");
    const p = path.join(dir, "settings.json");
    await write(
      p,
      JSON.stringify({ packages: [{ source: "npm:a", extensions: [], skills: [], prompts: [], themes: [] }] }),
    );
    try {
      await setPackageEnabled(p, "npm:a", true);
      const parsed = JSON.parse(await fs.readFile(p, "utf8")) as Record<string, unknown>;
      assert.deepStrictEqual(parsed.packages, ["npm:a"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("source 不存在 → upsert append 覆盖条目（项目级覆盖全局包主路径）", async () => {
    const dir = await tmpdir("pinel-settings-");
    const p = path.join(dir, "settings.json");
    await write(p, JSON.stringify({ packages: ["npm:a"] }));
    try {
      await setPackageEnabled(p, "npm:new", false);
      const parsed = JSON.parse(await fs.readFile(p, "utf8")) as Record<string, unknown>;
      assert.deepStrictEqual(parsed.packages, [
        "npm:a",
        { source: "npm:new", extensions: [], skills: [], prompts: [], themes: [] },
      ]);
      // 再启用：append 条目恢复字符串（不产生重复条目）
      await setPackageEnabled(p, "npm:new", true);
      const parsed2 = JSON.parse(await fs.readFile(p, "utf8")) as Record<string, unknown>;
      assert.deepStrictEqual(parsed2.packages, ["npm:a", "npm:new"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("upsert 按 identity 查重：同 repo 不同拼写不重复 append", async () => {
    const dir = await tmpdir("pinel-settings-");
    const p = path.join(dir, "settings.json");
    await write(p, JSON.stringify({ packages: ["https://github.com/user/repo"] }));
    try {
      await setPackageEnabled(p, "ssh://git@github.com/user/repo.git", false);
      const parsed = JSON.parse(await fs.readFile(p, "utf8")) as Record<string, unknown>;
      assert.strictEqual((parsed.packages as unknown[]).length, 1);
      const only = (parsed.packages as unknown[])[0] as Record<string, unknown>;
      assert.strictEqual(only.source, "ssh://git@github.com/user/repo.git");
      assert.deepStrictEqual(only.extensions, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("settings 目录不存在 → mkdir 补建并写入", async () => {
    const dir = await tmpdir("pinel-settings-");
    const p = path.join(dir, "missing", "nested", "settings.json");
    try {
      await setPackageEnabled(p, "npm:a", true);
      const parsed = JSON.parse(await fs.readFile(p, "utf8")) as Record<string, unknown>;
      assert.deepStrictEqual(parsed.packages, ["npm:a"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("损坏 JSON → 抛错且不覆盖原文件", async () => {
    const dir = await tmpdir("pinel-settings-");
    const p = path.join(dir, "settings.json");
    await write(p, "{ not valid json ");
    try {
      await assert.rejects(() => setPackageEnabled(p, "npm:a", false), /not valid JSON/);
      assert.strictEqual(await fs.readFile(p, "utf8"), "{ not valid json ");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

suite("packageSourceKind", () => {
  test("npm/git/path 三类", () => {
    assert.strictEqual(packageSourceKind("npm:pi-web-access"), "npm");
    assert.strictEqual(packageSourceKind("git:github.com/u/r"), "git");
    assert.strictEqual(packageSourceKind("https://github.com/u/r"), "git");
    assert.strictEqual(packageSourceKind("../local/pkg"), "path");
  });
});

suite("parseNpmSpec / isPinnedNpmSpec", () => {
  test("裸名 / scoped / 带版本 / 带 range", () => {
    assert.deepStrictEqual(parseNpmSpec("npm:pi-web-access"), { name: "pi-web-access" });
    assert.deepStrictEqual(parseNpmSpec("npm:@scope/pkg"), { name: "@scope/pkg" });
    assert.deepStrictEqual(parseNpmSpec("npm:@scope/pkg@2.0.0"), { name: "@scope/pkg", version: "2.0.0" });
    assert.deepStrictEqual(parseNpmSpec("npm:pkg@^1.2.3"), { name: "pkg", version: "^1.2.3" });
    assert.strictEqual(isPinnedNpmSpec("npm:pkg@1.0.0"), true);
    assert.strictEqual(isPinnedNpmSpec("npm:pkg@^1.0.0"), false);
    assert.strictEqual(isPinnedNpmSpec("npm:pkg"), false);
  });
  test("range / dist-tag 非 pinned，预发布精确版 pinned", () => {
    assert.strictEqual(isPinnedNpmSpec("npm:pkg@1.x"), false);
    assert.strictEqual(isPinnedNpmSpec("npm:pkg@latest"), false);
    assert.strictEqual(isPinnedNpmSpec("npm:pkg@beta"), false);
    assert.strictEqual(isPinnedNpmSpec("npm:pkg@1.2.3-beta.1"), true);
  });
});

suite("gitRef / gitHostPath（经 installedPackageRoot 间接验证）", () => {
  test("installedPackageRoot：全局 npm（scoped）", () => {
    assert.strictEqual(
      installedPackageRoot("npm:@scope/pkg@1.0.0", "global", "/agent"),
      path.join("/agent", "npm", "node_modules", "@scope", "pkg"),
    );
  });
  test("installedPackageRoot：项目 npm 需 projectRoot，无则 undefined", () => {
    assert.strictEqual(installedPackageRoot("npm:pkg", "project", "/agent"), undefined);
    assert.strictEqual(
      installedPackageRoot("npm:pkg", "project", "/agent", "/ws"),
      path.join("/ws", ".pi", "npm", "node_modules", "pkg"),
    );
  });
  test("installedPackageRoot：git 带/不带 ref，URL 形式", () => {
    assert.strictEqual(
      installedPackageRoot("git:github.com/obra/superpowers@v6.3.0", "global", "/agent"),
      path.join("/agent", "git", "github.com", "obra", "superpowers"),
    );
    assert.strictEqual(
      installedPackageRoot("https://github.com/u/repo", "global", "/agent"),
      path.join("/agent", "git", "github.com", "u", "repo"),
    );
  });
  test("installedPackageRoot：本地路径按 baseDir 解析", () => {
    assert.strictEqual(
      installedPackageRoot("../pkg", "global", "/agent"),
      path.resolve("/agent", "../pkg"),
    );
  });
});

suite("readPackageVersion", () => {
  test("有 version / 无 package.json / 损坏 JSON", async () => {
    const dir = await tmpdir("pinel-ver-");
    await write(path.join(dir, "package.json"), `{"name":"x","version":"1.2.3"}`);
    assert.strictEqual(await readPackageVersion(dir), "1.2.3");
    assert.strictEqual(await readPackageVersion(path.join(dir, "missing")), undefined);
    await write(path.join(dir, "bad", "package.json"), "{oops");
    assert.strictEqual(await readPackageVersion(path.join(dir, "bad")), undefined);
  });
});

suite("scanPackages 版本富化", () => {
  test("npm 包读 node_modules 版本 + sourceKind；本地散文件无版本", async () => {
    const agent = await tmpdir("pinel-scan-");
    const settings = path.join(agent, "settings.json");
    await write(settings, JSON.stringify({ packages: ["npm:foo"] }));
    await write(
      path.join(agent, "npm", "node_modules", "foo", "package.json"),
      `{"name":"foo","version":"0.9.1"}`,
    );
    const items = await scanPackages(settings, undefined, { agentDir: agent });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].sourceKind, "npm");
    assert.strictEqual(items[0].version, "0.9.1");
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
