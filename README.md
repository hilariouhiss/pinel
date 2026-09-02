# Pinel monorepo

Pinel —— 为 Pi 编码智能体（`@earendil-works/pi-coding-agent`）提供 VS Code 图形聊天面板。

## 布局

- `vscode/` —— VS Code 扩展（发布 ID `hilariouhiss.pinel`）。开发：`cd vscode && npm install && npm run compile && npm test`（详见 `vscode/AGENTS.md`）。
- `pi/` —— Pinel Pi 插件包（npm 包 `@hilariouhiss/pinel`，`pi install` 安装；独立发布：`cd pi && npm publish`）。

两子项目工具链互引（`vscode/` 内命令以 `../pi` 相对路径引用插件源），构建/测试/发布均在各自目录内进行。
本仓由两个独立仓库经 `git subtree` 整合而成，双方完整历史保留（`git log --follow` 可溯源）。
