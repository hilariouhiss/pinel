// 清理 @vscode/test-electron 的持久 user-data。
//
// 必要性：两个测试实例（main 工作区套件 + no-workspace 空窗口套件）共享
// .vscode-test/user-data。no-workspace 套件以空窗口退出后，VS Code 会把
// 空窗口状态持久化，导致下一次运行 main 实例时 workspaceFolder 参数被
// 窗口恢复逻辑忽略、集成测试拿不到工作区（踩坑记录）。
// 每次 npm test 前清理，保证测试隔离。
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const userData = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".vscode-test",
  "user-data",
);
rmSync(userData, { recursive: true, force: true });
