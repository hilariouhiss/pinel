import assert from "node:assert";
import { describe, it } from "mocha";
import {
  CATALOG,
  catalogInstallState,
  defaultInstallSpecs,
  getCatalog,
  getCatalogEntry,
  getCatalogGroup,
  installedIdentities,
  installSpecsForGroup,
} from "../chat/catalog";

describe("catalog 静态清单", () => {
  it("共 20 项：pi-packages 9 + rpiv-mono 11，无重复 id", () => {
    assert.strictEqual(CATALOG.length, 20);
    assert.strictEqual(getCatalogGroup("pi-packages").length, 9);
    assert.strictEqual(getCatalogGroup("rpiv-mono").length, 11);
    assert.strictEqual(new Set(CATALOG.map((e) => e.id)).size, 20);
  });

  it("installSpec 全为 npm: 规范格式且与 scope 一致", () => {
    for (const e of CATALOG) {
      const scope = e.group === "pi-packages" ? "npm:@gotgenes/" : "npm:@juicesharp/";
      assert.ok(e.installSpec.startsWith(scope), `${e.id} spec: ${e.installSpec}`);
      assert.ok(!e.installSpec.includes("@", scope.length), `${e.id} 含版本号`);
    }
  });

  it("rpiv 默认安装集 = todo / ask-user-question / voice（用户指定）", () => {
    assert.deepStrictEqual(defaultInstallSpecs("rpiv-mono"), [
      "npm:@juicesharp/rpiv-todo",
      "npm:@juicesharp/rpiv-ask-user-question",
      "npm:@juicesharp/rpiv-voice",
    ]);
    assert.deepStrictEqual(defaultInstallSpecs("pi-packages"), []);
  });

  it("installSpecsForGroup：pi-packages = git 整仓；rpiv-mono = 默认集三包", () => {
    assert.deepStrictEqual(installSpecsForGroup("pi-packages"), ["git:github.com/gotgenes/pi-packages"]);
    assert.deepStrictEqual(installSpecsForGroup("rpiv-mono"), [
      "npm:@juicesharp/rpiv-todo",
      "npm:@juicesharp/rpiv-ask-user-question",
      "npm:@juicesharp/rpiv-voice",
    ]);
  });

  it("tui-only 项均有 compatNote；defaultSet 仅存在于 rpiv-mono", () => {
    for (const e of CATALOG) {
      if (e.compat !== "ok") {
        assert.ok(e.compatNote, `${e.id} 缺 compatNote`);
      }
      if (e.defaultSet) {
        assert.strictEqual(e.group, "rpiv-mono");
      }
    }
    assert.deepStrictEqual(
      CATALOG.filter((e) => e.compat === "tui-only").map((e) => e.id),
      ["rpiv-voice", "rpiv-btw"],
    );
  });

  it("getCatalog 返回副本；getCatalogEntry 按 id 命中", () => {
    const copy = getCatalog();
    copy[0].id = "hacked";
    assert.strictEqual(CATALOG[0].id, "pi-permission-system");
    assert.strictEqual(getCatalogEntry("rpiv-todo")?.installSpec, "npm:@juicesharp/rpiv-todo");
    assert.strictEqual(getCatalogEntry("nope"), undefined);
  });
});

describe("catalog 安装态检测", () => {
  it("installedIdentities：字符串/对象条目、npm 版本去归一、损坏条目容缺", () => {
    const ids = installedIdentities([
      "npm:@gotgenes/pi-subagents",
      { source: "npm:@juicesharp/rpiv-todo@0.1.0", extensions: [] },
      "git:github.com/gotgenes/pi-packages",
      42,
      {},
    ]);
    assert.ok(ids.has("npm:@gotgenes/pi-subagents"));
    assert.ok(ids.has("npm:@juicesharp/rpiv-todo")); // 版本号已剥离
    assert.ok(ids.has("git:github.com/gotgenes/pi-packages"));
    assert.strictEqual(ids.size, 3);
  });

  it("installedIdentities：packages 非数组 → 空集", () => {
    assert.strictEqual(installedIdentities(undefined).size, 0);
    assert.strictEqual(installedIdentities("garbage").size, 0);
  });

  it("catalogInstallState：identity 命中判已装（含带版本条目）", () => {
    const installed = installedIdentities(["npm:@juicesharp/rpiv-todo@0.1.0"]);
    assert.strictEqual(catalogInstallState(getCatalogEntry("rpiv-todo")!, installed), "installed");
    assert.strictEqual(catalogInstallState(getCatalogEntry("rpiv-btw")!, installed), "available");
  });

  it("catalogInstallState：git 整仓装包名不命中单包 spec（各是独立 identity）", () => {
    const installed = installedIdentities(["git:github.com/gotgenes/pi-packages"]);
    assert.strictEqual(catalogInstallState(getCatalogEntry("pi-subagents")!, installed), "available");
  });
});
