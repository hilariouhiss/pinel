import assert from "node:assert";
import { describe, it } from "mocha";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PINEL_PACKAGE_SOURCE,
  agentSettingsPath,
  decidePinelPluginState,
  readAgentPackages,
} from "../chat/pinel-install";

describe("pinel-install 安装态检测", () => {
  it("PINEL_PACKAGE_SOURCE 为 npm 规范格式", () => {
    assert.strictEqual(PINEL_PACKAGE_SOURCE, "npm:@hilariouhiss/pinel");
  });

  describe("decidePinelPluginState", () => {
    it("列表含字符串条目 → installed", () => {
      assert.strictEqual(decidePinelPluginState(["npm:other", PINEL_PACKAGE_SOURCE], false), "installed");
    });

    it("列表含对象条目（source 字段）→ installed", () => {
      assert.strictEqual(
        decidePinelPluginState([{ source: PINEL_PACKAGE_SOURCE, extensions: [] }], false),
        "installed",
      );
    });

    it("不在列表且无标记 → offer；有标记 → removed（不复活）", () => {
      assert.strictEqual(decidePinelPluginState(["npm:other"], false), "offer");
      assert.strictEqual(decidePinelPluginState(["npm:other"], true), "removed");
    });

    it("packages 非数组（损坏配置容缺）→ 按未安装处理", () => {
      assert.strictEqual(decidePinelPluginState(undefined, false), "offer");
      assert.strictEqual(decidePinelPluginState("garbage", false), "offer");
    });
  });

  describe("agentSettingsPath / readAgentPackages", () => {
    it("默认路径 ~/.pi/agent/settings.json；PI_CODING_AGENT_DIR 覆盖", () => {
      assert.strictEqual(
        agentSettingsPath("/home/user", {}),
        path.join("/home/user", ".pi", "agent", "settings.json"),
      );
      assert.strictEqual(
        agentSettingsPath("/home/user", { PI_CODING_AGENT_DIR: "/custom/agent" }),
        path.join("/custom/agent", "settings.json"),
      );
    });

    it("读取 packages 数组；文件缺失/损坏/形状异常 → []", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinel-install-"));
      const p = path.join(dir, "settings.json");
      // 文件缺失
      assert.deepStrictEqual(await readAgentPackages(p), []);
      // 正常 JSON
      fs.writeFileSync(p, JSON.stringify({ packages: ["npm:a", { source: "npm:b", extensions: [] }] }));
      assert.deepStrictEqual(await readAgentPackages(p), ["npm:a", { source: "npm:b", extensions: [] }]);
      // 损坏 JSON
      fs.writeFileSync(p, "{oops");
      assert.deepStrictEqual(await readAgentPackages(p), []);
      // 数组形状
      fs.writeFileSync(p, JSON.stringify([1, 2]));
      assert.deepStrictEqual(await readAgentPackages(p), []);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
