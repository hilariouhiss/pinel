# 整理 git 仓库：忽略本地/生成文件，处理图标未决修改

> 状态：待用户确认后执行
> 日期：2026-08-13

## 1. 背景与目标

用户要求整理仓库，忽略无用/生成/仅本地的文件。盘点结果：

- **`.codegraph/`**（CodeGraph 索引目录，工具生成的仅本地产物）未被仓库 `.gitignore` 覆盖，`git status` 持续显示 `?? .codegraph/`——需忽略。
- **`media/pinel-icon.svg`** 存在未提交修改（被替换为 1254×1254 大尺寸新图标，17 行 diff）——已跟踪文件不能忽略，经确认**提交为新图标**。
- 其余忽略项已完备：`node_modules`、`dist`、`out`、`.vscode-test/`、`*.vsix`、`media/webview.*`（4 个构建产物）、`.pi/subagents/`。仓库中无 `.DS_Store`/`Thumbs.db`/`*.log`/`*.tsbuildinfo` 等散落本地文件。
- 经确认：`.gitignore` **整理为带注释的分组结构 + 通用防御条目**。

## 2. 方案设计

### 2.1 重写 `.gitignore`（注释分组结构）

```
# 依赖
node_modules

# 构建产物（宿主 + webview）
dist
out
*.vsix
media/webview.js
media/webview.css
media/webview.js.map
media/webview.css.map

# 测试运行时
.vscode-test/

# 工具本地状态
.codegraph/          # CodeGraph 索引（仅本地）
.pi/subagents/       # pi 子代理会话产物（仅本地）

# 通用本地/生成文件防御
.DS_Store
Thumbs.db
*.log
*.tsbuildinfo
```

说明：
- 条目集合 = 现有条目 + `.codegraph/` + 4 条通用防御；无删除项（现有条目全部仍有效）。
- `.codegraph/` 放**仓库级** `.gitignore`（团队统一：任何开发者的本地 CodeGraph 索引都不入库），而非 `.git/info/exclude`（仅本机生效）。
- 追加 `.codegraph/` 后，`.codegraph/.gitignore`（目录自带的内部忽略文件）也不再出现在 status 中。

### 2.2 提交图标修改（独立提交）

`media/pinel-icon.svg` 的新版大尺寸图标作为正式资产变更提交。该文件继续入库（`media/` 图标是发布资产，`.vscodeignore` 会打包）。

### 2.3 提交拆分（Conventional Commits）

1. `chore: 整理 .gitignore 并忽略 CodeGraph 索引与通用本地文件`——`.gitignore` + AGENTS.md 同步说明。
2. `chore: 更新扩展图标`（或按语义 `feat` 不合适，`chore` 即可）——`media/pinel-icon.svg` + `CHANGELOG.md` 补一条 `[Unreleased] Changed`：「更换扩展图标为高清版 SVG」（图标更换是用户可见变更，按仓库规则需同步 CHANGELOG；README/package.json 仅路径引用无需改动）。

一次提交一个完整独立变更（.gitignore 整理与图标资产是两件事）。

### 2.4 文档同步

- `AGENTS.md` 结构描述补一行：`.gitignore` 忽略分组（构建产物/依赖/测试运行时/工具本地状态/通用防御），并提及 `.codegraph/` 不入库。

## 3. 任务拆解

1. 重写 `.gitignore`（按 §2.1 分组结构）。
2. 验证忽略生效：`git status --short` 只剩图标修改；`git check-ignore .codegraph/ media/webview.js node_modules` 全部命中。
3. 提交 1：`.gitignore` + AGENTS.md 同步（`chore:`）。
4. 提交 2：`media/pinel-icon.svg`（`chore:`）。
5. 终验：`git status` 完全干净；`git log --oneline -3` 确认两次提交。

## 4. 涉及文件

- `.gitignore`（重写）
- `media/pinel-icon.svg`（提交现有修改）
- `CHANGELOG.md`（图标变更条目）
- `AGENTS.md`（结构描述同步）

## 5. 验证方式与风险

**验证**：
- 执行前只读确认：`git ls-files .vscode/`（确认 `.vscode/` 的跟踪状态与计划前提一致）与 `git diff --stat media/pinel-icon.svg`。
- `git status` 干净（无未跟踪、无未提交修改）。
- `git check-ignore` 命中 `.codegraph/`、构建产物、依赖目录（.codegraph/ media/webview.js media/webview.css media/webview.js.map media/webview.css.map node_modules dist out .vscode-test/ .pi/subagents/）。
- 不涉及源码/构建/测试改动，无需跑 `npm run compile`/`npm test`（质量门针对代码变更）。

**风险与缓解**：
- 通用防御条目（`*.log` 等）理论上可能误伤未来有意入库的文件：仓库当前无此类文件；若未来需要入库某个 log，可显式 `!` 解除——条目集保守，风险可忽略。
- `.codegraph/` 若未来想入库（不太可能——纯本地索引）：届时删除该行即可。
- 图标新尺寸（1254×1254）远大于原 24×24：VS Code 会对 activitybar 图标缩放显示，用户已确认提交；若显示异常（模糊/裁切），后续再替换，不在本轮范围。

## 6. 决策点（已与用户确认）

1. `media/pinel-icon.svg` 未提交修改 → 提交为新图标 ✓
2. 忽略范围 → 整理分组 + 通用防御条目（.DS_Store/Thumbs.db/*.log/*.tsbuildinfo）✓
