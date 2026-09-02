import assert from "node:assert";
import { readModelDefaults, writeDefaultModel, writeDefaultThinkingLevel, writeModelRole } from "../chat/model-defaults";
import type { SettingsObject } from "../chat/extensions";

suite("model-defaults 纯函数", function () {
  test("读取：pi 启动键 + pinel.modelRoles 防御解析", () => {
    const settings: SettingsObject = {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet",
      defaultThinkingLevel: "high",
      pinel: { modelRoles: { strong: "anthropic:opus", weak: "openai:mini" } },
    };
    assert.deepStrictEqual(readModelDefaults(settings), {
      defaultModelKey: "anthropic:claude-sonnet",
      defaultThinkingLevel: "high",
      strongKey: "anthropic:opus",
      weakKey: "openai:mini",
    });
  });

  test("读取：缺失/损坏形状逐层容缺为 null", () => {
    assert.deepStrictEqual(readModelDefaults({}), {
      defaultModelKey: null,
      defaultThinkingLevel: null,
      strongKey: null,
      weakKey: null,
    });
    // provider 有 model 无 → 复合键为 null；modelRoles 非对象 → 预设 null
    assert.deepStrictEqual(
      readModelDefaults({ defaultProvider: "anthropic", pinel: { modelRoles: "bad" } }),
      { defaultModelKey: null, defaultThinkingLevel: null, strongKey: null, weakKey: null },
    );
  });

  test("写入默认模型：defaultProvider + defaultModel 同写", () => {
    const settings: SettingsObject = { theme: "dark" };
    writeDefaultModel(settings, "openai", "gpt-5");
    assert.strictEqual(settings.defaultProvider, "openai");
    assert.strictEqual(settings.defaultModel, "gpt-5");
    assert.strictEqual(settings.theme, "dark", "保留其余键");
  });

  test("写入默认思考强度", () => {
    const settings: SettingsObject = {};
    writeDefaultThinkingLevel(settings, "max");
    assert.strictEqual(settings.defaultThinkingLevel, "max");
  });

  test("写入强弱预设：合并保留 pinel 其余键与另一角色", () => {
    const settings: SettingsObject = { pinel: { autoCommit: true, modelRoles: { strong: "a:1" } } };
    writeModelRole(settings, "weak", "b:2");
    const pinel = settings.pinel as Record<string, unknown>;
    assert.strictEqual(pinel.autoCommit, true, "保留 pinel.autoCommit");
    assert.deepStrictEqual(pinel.modelRoles, { strong: "a:1", weak: "b:2" });
  });
});
