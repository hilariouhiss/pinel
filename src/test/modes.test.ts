import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, suite, test } from "mocha";
import {
  computeExclusions,
  mergeSkillsEntries,
  modeExclusions,
  parseSkillFrontmatter,
  readModesState,
  scanLocalSkills,
  writeModesState,
} from "../chat/modes";

/** 递归建目录 + 写文件（\n 结尾）。 */
function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function write(p: string, body: string): void {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, body, "utf8");
}

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

    test("形状容缺：坏条目跳过、skills 非字符串过滤", () => {
      const state = readModesState({
        pinel: {
          modes: {
            active: "code",
            modes: [
              { name: "code", skills: ["a", 42, null, "b"] },
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
      assert.deepStrictEqual(state.modes[0], { name: "code", skills: ["a", "b"] });
    });

    test("write → read 往返 + 保留 pinel 节其余键", () => {
      const settings: Record<string, unknown> = { pinel: { autoCommit: true, other: 1 }, theme: "dark" };
      writeModesState(settings, { active: "docs", modes: [{ name: "docs", skills: ["a.md"] }] });
      assert.strictEqual((settings.pinel as Record<string, unknown>).autoCommit, true);
      assert.strictEqual(settings.theme, "dark");
      const back = readModesState(settings as never);
      assert.strictEqual(back.active, "docs");
      assert.deepStrictEqual(back.modes, [{ name: "docs", skills: ["a.md"] }]);
    });

    test("active 空白字符串归一为 null", () => {
      assert.strictEqual(readModesState({ pinel: { modes: { active: "  " } } }).active, null);
    });
  });

  suite("parseSkillFrontmatter", () => {
    test("标准块取 name/description", () => {
      const fm = parseSkillFrontmatter("---\nname: my-skill\ndescription: Does things\n---\n\n# body");
      assert.strictEqual(fm.name, "my-skill");
      assert.strictEqual(fm.description, "Does things");
    });

    test("无块/缺字段 → undefined", () => {
      assert.deepStrictEqual(parseSkillFrontmatter("# no frontmatter"), {});
      assert.deepStrictEqual(parseSkillFrontmatter("---\nname: only\n---\nbody"), {
        name: "only",
      });
    });
  });

  suite("scanLocalSkills", () => {
    test("四根扫描：SKILL.md 目录、嵌套分组、根 .md（仅 pi 式）、跳过 dotfiles/符号规则", async () => {
      const agentDir = path.join(tmp, "agent");
      const home = path.join(tmp, "home");
      const root = path.join(tmp, "ws");
      // 全局 pi 式：根 .md skill + 顶层 skill 目录 + 分组文件夹嵌套 skill
      write(path.join(agentDir, "skills", "notes.md"), "---\nname: notes\ndescription: root md skill\n---\n");
      write(path.join(agentDir, "skills", "colgrep", "SKILL.md"), "---\ndescription: top skill\n---\n");
      write(
        path.join(agentDir, "skills", "group", "deep-skill", "SKILL.md"),
        "---\nname: deep\ndescription: nested skill\n---\n",
      );
      // 跳过：dotfile 目录、无 SKILL.md 的裸目录、根 .md 无 description
      write(path.join(agentDir, "skills", ".hidden", "SKILL.md"), "---\ndescription: nope\n---\n");
      mkdirp(path.join(agentDir, "skills", "bare"));
      write(path.join(agentDir, "skills", "invalid.md"), "# no frontmatter");
      // 全局 agents 式：SKILL.md 目录算，根 .md 忽略
      write(path.join(home, ".agents", "skills", "agents-skill", "SKILL.md"), "---\ndescription: from agents\n---\n");
      write(path.join(home, ".agents", "skills", "ignored.md"), "---\ndescription: nope\n---\n");
      // 项目 .pi/skills
      write(path.join(root, ".pi", "skills", "proj-skill", "SKILL.md"), "---\ndescription: project skill\n---\n");
      // 项目 .agents/skills
      write(path.join(root, ".agents", "skills", "proj-agents", "SKILL.md"), "---\ndescription: proj agents\n---\n");

      const skills = await scanLocalSkills(agentDir, home, root);
      const byId = new Map(skills.map((s) => [`${s.scope}:${s.id}`, s]));
      // 命中集
      assert.ok(byId.get("global:notes.md")?.name === "notes");
      assert.ok(byId.get("global:colgrep")?.name === "colgrep"); // frontmatter 无 name → 目录名
      assert.ok(byId.get("global:deep-skill")?.name === "deep");
      assert.ok(byId.get("global:agents-skill")?.description === "from agents");
      assert.ok(byId.get("project:proj-skill")?.description === "project skill");
      assert.ok(byId.get("project:proj-agents")?.description === "proj agents");
      // 跳过集
      assert.ok(!byId.has("global:.hidden"));
      assert.ok(!byId.has("global:bare"));
      assert.ok(!byId.has("global:invalid.md"));
      assert.ok(!byId.has("global:ignored.md"));
      // 字母序
      const names = skills.map((s) => s.name);
      assert.deepStrictEqual([...names].sort((a, b) => a.localeCompare(b)), names);
    });

    test("无项目根：只扫全局两根", async () => {
      const agentDir = path.join(tmp, "agent2");
      const home = path.join(tmp, "home2");
      write(path.join(agentDir, "skills", "g", "SKILL.md"), "---\ndescription: g\n---\n");
      const skills = await scanLocalSkills(agentDir, home);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0].scope, "global");
    });

    test("目录不存在：返回空数组不抛错", async () => {
      assert.deepStrictEqual(await scanLocalSkills(path.join(tmp, "nope"), path.join(tmp, "nope2")), []);
    });
  });

  suite("computeExclusions", () => {
    const skills = [
      { id: "a", name: "a", scope: "global" as const },
      { id: "b", name: "b", scope: "global" as const },
      { id: "p", name: "p", scope: "project" as const },
    ];
    test("未选中项按 scope 分组", () => {
      assert.deepStrictEqual(computeExclusions(skills, new Set(["a"])), { global: ["b"], project: ["p"] });
    });
    test("全选 → 双空（Default 模式）", () => {
      assert.deepStrictEqual(computeExclusions(skills, new Set(["a", "b", "p"])), { global: [], project: [] });
    });
  });

  suite("modeExclusions（applyActiveMode 决策层）", () => {
    const skills = [
      { id: "a", name: "a", scope: "global" as const },
      { id: "b", name: "b", scope: "global" as const },
      { id: "p", name: "p", scope: "project" as const },
    ];
    test("Default（active=null）→ 无排除", () => {
      assert.deepStrictEqual(modeExclusions({ active: null, modes: [] }, skills), {
        global: [],
        project: [],
      });
    });
    test("激活模式 → 未选中项排除", () => {
      const state = { active: "m", modes: [{ name: "m", skills: ["a", "p"] }] };
      assert.deepStrictEqual(modeExclusions(state, skills), { global: ["b"], project: [] });
    });
    test("active 指向已删模式 → 无排除（等同 Default）", () => {
      assert.deepStrictEqual(modeExclusions({ active: "gone", modes: [] }, skills), {
        global: [],
        project: [],
      });
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
