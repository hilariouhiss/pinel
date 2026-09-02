import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, suite, test } from "mocha";
import {
  mergeSkillsEntries,
  modeApplyPlan,
  parseSkillFrontmatter,
  planPackageEntries,
  readModesState,
  scanModeInventory,
  writeModesState,
  type ModeInventory,
} from "../chat/modes";

/** 递归建目录 + 写文件。 */
function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function write(p: string, body: string): void {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, body, "utf8");
}

const EMPTY_SCAN: ModeInventory = { skills: [], extensions: [] };

suite("modes 纯函数", function () {
  this.timeout(10000);
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pinel-modes-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  suite("readModesState / writeModesState", () => {
    test("缺 pinel/modes 节 → 空态", () => {
      assert.deepStrictEqual(readModesState({}), { active: null, modes: [] });
      assert.deepStrictEqual(readModesState({ pinel: {} }), { active: null, modes: [] });
      assert.deepStrictEqual(readModesState({ pinel: { modes: "x" } }), { active: null, modes: [] });
      assert.deepStrictEqual(readModesState({ pinel: { autoCommit: true } }), { active: null, modes: [] });
    });

    test("形状容缺：坏条目跳过、skills/extensions 非字符串过滤", () => {
      const state = readModesState({
        pinel: {
          modes: {
            active: "code",
            modes: [
              { name: "code", skills: ["a", 42, null, "b"], extensions: ["x", 7] },
              { name: "" },
              null,
              { skills: ["x"] },
              "junk",
            ],
          },
        },
      });
      assert.strictEqual(state.active, "code");
      // 仅 code 合法：空名/缺名/非对象/字符串条目全部跳过
      assert.strictEqual(state.modes.length, 1);
      assert.deepStrictEqual(state.modes[0], { name: "code", skills: ["a", "b"], extensions: ["x"] });
    });

    test("write → read 往返 + 保留 pinel 节其余键 + packageBaseline 一并写入", () => {
      const settings: Record<string, unknown> = { pinel: { autoCommit: true, other: 1 }, theme: "dark" };
      writeModesState(settings, {
        active: "docs",
        modes: [{ name: "docs", skills: ["local|global|a"], extensions: [] }],
        packageBaseline: { "npm:x": "npm:x" },
      });
      assert.strictEqual((settings.pinel as Record<string, unknown>).autoCommit, true);
      assert.strictEqual(settings.theme, "dark");
      const back = readModesState(settings as never);
      assert.strictEqual(back.active, "docs");
      assert.deepStrictEqual(back.modes, [{ name: "docs", skills: ["local|global|a"], extensions: [] }]);
      assert.deepStrictEqual(back.packageBaseline, { "npm:x": "npm:x" });
    });

    test("active 空白字符串归一为 null；无基线 → packageBaseline undefined", () => {
      const state = readModesState({ pinel: { modes: { active: "  " } } });
      assert.strictEqual(state.active, null);
      assert.strictEqual(state.packageBaseline, undefined);
    });
  });

  suite("parseSkillFrontmatter", () => {
    test("标准块取 name/description", () => {
      const fm = parseSkillFrontmatter("---\nname: my-skill\ndescription: Does things\n---\n\n# body");
      assert.strictEqual(fm.name, "my-skill");
      assert.strictEqual(fm.description, "Does things");
    });

    test("无块/缺字段 → 键缺省", () => {
      assert.deepStrictEqual(parseSkillFrontmatter("# no frontmatter"), {});
      assert.deepStrictEqual(parseSkillFrontmatter("---\nname: only\n---\nbody"), { name: "only" });
    });
  });

  suite("scanModeInventory", () => {
    test("本地四根 + 包约定目录：id/pattern/scope/identity", async () => {
      const agentDir = path.join(tmp, "agent");
      const home = path.join(tmp, "home");
      const root = path.join(tmp, "ws");
      // 本地 skills：全局 pi 式（根 .md + SKILL.md 目录）+ 项目
      write(path.join(agentDir, "skills", "notes.md"), "---\nname: notes\ndescription: root md skill\n---\n");
      write(path.join(agentDir, "skills", "colgrep", "SKILL.md"), "---\ndescription: top skill\n---\n");
      write(path.join(root, ".pi", "skills", "proj-skill", "SKILL.md"), "---\ndescription: project skill\n---\n");
      // 本地扩展：全局散文件 + 目录式（index.ts）+ 项目
      write(path.join(agentDir, "extensions", "foo.ts"), "export {};\n");
      write(path.join(agentDir, "extensions", "myext", "index.ts"), "export {};\n");
      write(path.join(root, ".pi", "extensions", "bar.js"), "export {};\n");
      // 包：已装（skills 目录 + extensions 目录）+ 未安装（settings 里有但磁盘无）
      const pkgRoot = path.join(agentDir, "npm", "node_modules", "pi-skills");
      write(path.join(pkgRoot, "skills", "brave", "SKILL.md"), "---\nname: brave-search\ndescription: pkg skill\n---\n");
      write(path.join(pkgRoot, "extensions", "tool.ts"), "export {};\n");

      const inv = await scanModeInventory(agentDir, home, root, [
        { source: "npm:pi-skills", scope: "global" },
        { source: "npm:ghost", scope: "global" },
      ]);
      const s = new Map(inv.skills.map((x) => [x.id, x]));
      const e = new Map(inv.extensions.map((x) => [x.id, x]));
      // 本地 skills
      assert.deepStrictEqual(s.get("local|global|notes.md"), {
        id: "local|global|notes.md",
        pattern: "notes.md",
        name: "notes",
        description: "root md skill",
        scope: "global",
      });
      assert.strictEqual(s.get("local|global|colgrep")?.pattern, "colgrep");
      assert.strictEqual(s.get("local|project|proj-skill")?.scope, "project");
      // 本地扩展：目录式 pattern = baseDir 相对完整路径（防 index.ts 碰撞）
      assert.strictEqual(e.get("local|global|extensions/foo.ts")?.pattern, "extensions/foo.ts");
      assert.strictEqual(e.get("local|global|extensions/myext/index.ts")?.name, "myext");
      assert.strictEqual(e.get("local|project|extensions/bar.js")?.scope, "project");
      // 包资源：identity 分组、pattern = 包根相对路径、未装包零贡献
      const pkgSkill = s.get("pkg|npm:pi-skills|skills/brave");
      assert.ok(pkgSkill);
      assert.strictEqual(pkgSkill.name, "brave-search");
      assert.strictEqual(pkgSkill.pattern, "skills/brave");
      assert.strictEqual(pkgSkill.package, "pi-skills");
      assert.strictEqual(pkgSkill.identity, "npm:pi-skills");
      const pkgExt = e.get("pkg|npm:pi-skills|extensions/tool.ts");
      assert.ok(pkgExt);
      assert.strictEqual(pkgExt.pattern, "extensions/tool.ts");
      assert.ok(![...s.keys()].some((k) => k.startsWith("pkg|npm:ghost")));
      // 字母序
      const names = inv.skills.map((x) => x.name);
      assert.deepStrictEqual([...names].sort((a, b) => a.localeCompare(b)), names);
    });

    test("目录不存在：返回空清单不抛错", async () => {
      assert.deepStrictEqual(await scanModeInventory(path.join(tmp, "no"), path.join(tmp, "no2"), undefined, []), {
        skills: [],
        extensions: [],
      });
    });
  });

  suite("modeApplyPlan", () => {
    const scan: ModeInventory = {
      skills: [
        { id: "local|global|a", pattern: "a", name: "a", scope: "global" },
        { id: "local|project|p", pattern: "p", name: "p", scope: "project" },
        { id: "pkg|npm:x|skills/s", pattern: "skills/s", name: "s", scope: "package", package: "x", identity: "npm:x" },
      ],
      extensions: [
        { id: "local|global|extensions/e.ts", pattern: "extensions/e.ts", name: "e", scope: "global" },
        { id: "pkg|npm:x|extensions/t.ts", pattern: "extensions/t.ts", name: "t", scope: "package", package: "x", identity: "npm:x" },
      ],
    };

    test("Default（active=null）→ 全空", () => {
      const plan = modeApplyPlan({ active: null, modes: [] }, scan);
      assert.deepStrictEqual(plan.localSkills, { global: [], project: [] });
      assert.deepStrictEqual(plan.localExtensions, { global: [], project: [] });
      assert.strictEqual(plan.packageExclusions.size, 0);
    });

    test("激活模式 → 本地按 scope 分组 + 包按 identity 分组", () => {
      const state = {
        active: "m",
        modes: [
          {
            name: "m",
            skills: ["local|global|a"],
            extensions: ["pkg|npm:x|extensions/t.ts"],
          },
        ],
      };
      const plan = modeApplyPlan(state, scan);
      assert.deepStrictEqual(plan.localSkills, { global: [], project: ["p"] });
      assert.deepStrictEqual(plan.localExtensions, { global: ["extensions/e.ts"], project: [] });
      assert.deepStrictEqual(plan.packageExclusions.get("npm:x"), { skills: ["skills/s"], extensions: [] });
    });

    test("active 指向已删模式 → 全空（等同 Default）", () => {
      const plan = modeApplyPlan({ active: "gone", modes: [] }, scan);
      assert.deepStrictEqual(plan.localSkills, { global: [], project: [] });
      assert.strictEqual(plan.packageExclusions.size, 0);
    });
  });

  suite("planPackageEntries", () => {
    const ex = new Map([["npm:x", { skills: ["skills/s"], extensions: [] }]]);

    test("首覆写快照基线；其余键保留；空类型省略键", () => {
      const { packages, baseline } = planPackageEntries(
        ["npm:y", { source: "npm:x", prompts: ["prompts/r.md"] }],
        ex,
        {},
        "/base",
      );
      assert.deepStrictEqual(packages[0], "npm:y");
      assert.deepStrictEqual(packages[1], {
        source: "npm:x",
        prompts: ["prompts/r.md"],
        skills: ["!skills/s"],
      }); // extensions 空数组 → 省略键
      assert.deepStrictEqual(baseline, { "npm:x": { source: "npm:x", prompts: ["prompts/r.md"] } });
    });

    test("免过滤 → 还原基线并出基线", () => {
      const baseline = { "npm:x": "npm:x" };
      const { packages, baseline: next } = planPackageEntries(
        [{ source: "npm:x", skills: ["!skills/s"] }],
        new Map(),
        baseline,
        "/base",
      );
      assert.deepStrictEqual(packages, ["npm:x"]);
      assert.deepStrictEqual(next, {});
    });

    test("二次覆写不重复快照（基线保持最原值）", () => {
      const baseline = { "npm:x": "npm:x" };
      const { baseline: next } = planPackageEntries(
        [{ source: "npm:x", skills: ["!skills/s"] }],
        ex,
        baseline,
        "/base",
      );
      assert.deepStrictEqual(next, { "npm:x": "npm:x" });
    });

    test("基线中已不存在的 identity 修剪；损坏条目原样保留", () => {
      const { packages, baseline } = planPackageEntries(["npm:y", 42], new Map(), { "npm:gone": "npm:gone" }, "/base");
      assert.deepStrictEqual(packages, ["npm:y", 42]);
      assert.deepStrictEqual(baseline, {});
    });
  });

  suite("mergeSkillsEntries", () => {
    test("保留非 ! 条目 + 替换 ! 段", () => {
      assert.deepStrictEqual(
        mergeSkillsEntries(["~/extra-skills", "!old", 42, null], ["b", "a"]),
        ["~/extra-skills", "!b", "!a"],
      );
    });
    test("无既有数组 → 纯排除段", () => {
      assert.deepStrictEqual(mergeSkillsEntries(undefined, ["x"]), ["!x"]);
    });
    test("空排除 → 仅剩保留条目", () => {
      assert.deepStrictEqual(mergeSkillsEntries(["~/extra", "!old"], []), ["~/extra"]);
    });
  });
});
