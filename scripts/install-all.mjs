/**
 * 一条命令安装 Pinel 全家桶（本地开发直装，不经市场）：
 *   1. npm run package                      构建扩展（host bundle + webview bundle）
 *   2. vsce package                         打包 pinel-<version>.vsix
 *   3. code --install-extension <vsix>      安装 VS Code 扩展
 *   4. pi install <仓库根>/pi               全局安装本地 pi 插件
 *      （写 ~/.pi/agent/settings.json；绝对路径不复制，改代码即时生效）
 *
 * 用法：cd vscode && npm run install:all
 * 卸载：pi remove <仓库根>\pi  &&  code --uninstall-extension hilariouhiss.pinel
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = path.resolve(ROOT, "..", "pi");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`FAIL: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

run("npm", ["run", "package"]);
run("npx", ["-y", "@vscode/vsce", "package"]);
run("code", ["--install-extension", path.join(ROOT, `pinel-${VERSION}.vsix`)]);
run("pi", ["install", PLUGIN_DIR]);

console.log(`OK: vscode 扩展 ${VERSION} + pi 插件（${PLUGIN_DIR}）已安装`);
