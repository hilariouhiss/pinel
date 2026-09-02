# 智能体模式（Agent Modes：模式创建/切换 + 按模式启用 SKILL）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面板支持创建/切换「模式」；每个模式配置一组启用的本地 SKILL，切换后（重启 pi）仅该模式的 skills 对智能体生效；当前模式名固定显示在输入框开头（chip），点击打开模式管理弹层。

**Architecture:** 零新机制，全部复用既有链路——
- **生效原理**：pi 仅在启动时扫描 skills；settings.json `skills` 数组的 `!name` 排除项按「SKILL.md 父目录名 / 根 .md 文件名」匹配，可禁用**本地自动发现**的 skill（实测对齐 `pi dist/core/package-manager.js` 的 `isEnabledByOverrides`：用户 scope 只认全局 settings 的 overrides，项目 scope 只认项目 settings）。切换模式 = 把「不在激活模式里的本地 skill」写成两个 scope 的 `!id` 排除段，重启 pi 进程加载新 skills 集。
- **存储**：模式定义与当前激活项存**全局** settings（`~/.pi/agent/settings.json`）的 `pinel.modes`（复用 `pinel.autoCommit` 的 `settings.pinel` 节先例）。项目 scope 的排除项写当前工作区 `.pi/settings.json` 的 `skills` 数组。
- **skill 清单**：宿主直接扫描 skill 目录（同 extensions.ts 直扫文件思路，薄客户端不扩 RPC）：全局 `<agentDir>/skills` + `~/.agents/skills`，项目 `.pi/skills` + `.agents/skills`；解析 SKILL.md frontmatter 取 name/description。不依赖 pi 运行（未启动也能配置）。
- **UI**：Composer 输入框内左上角常驻模式 chip（绝对定位 + textarea/渲染层恒定 padding-left 让位）；点击打开 `ModePopover`（居中模态，镜像 ExtensionPopover 骨架）：模式单选切换 + 勾选 skill + 新建/删除。
- **生效确认**：复用扩展启停的「写完配置 → confirm 弹窗 → restart()」三步；restart 走既有 `--session` 恢复，对话不丢。

**Tech Stack:** TypeScript strict（宿主 Node16/ES2022 + React 19 webview）；mocha + vscode-test 既有测试设施；零新依赖。

**Spec:** 用户需求（逐字）：「支持不同模式创建和切换，每个模式可配置不同SKILL，插件生效。当前模式固定显示在输入框开头。」+ 三个已确认决策：
1. 生效方式 = **确认弹窗**（与扩展启停一致，点 Reload 才重启 pi）；
2. 模式存储 = **全局共享**（所有项目共用一套模式与当前激活项）；
3. skill 范围 = **本地 skills**（全局 + 项目目录自动发现；包提供的 skills 不归模式管，继续走扩展弹层按包启停——pi 排除机制对包 skills 无效）。

## Global Constraints

- 仅改 `vscode/` 仓；`pi/` 插件仓不动。零 npm 依赖变动。
- settings.json 严格 JSON：全部经 `readSettings`/`writeSettings`（损坏抛错不覆盖，原子写）——与 extensions.ts 同一纪律。
- Pinel 托管 `skills` 数组中 **`!` 前缀段**：合并写时保留全部非 `!` 条目（用户手配的路径/目录），`!` 段整体按当前模式重算。ponytail: 用户手写的自定义 `!` 排除会被模式切换覆盖（罕见；恢复手段 = 模式切回 Default）。
- 模式名唯一（trim 后非空、查重）；`Default` 为内置伪模式（active = null，无排除 = 全部本地 skills 生效），不落盘、不可删。
- 排除键（id）= 目录名（SKILL.md 所在目录）或根 .md 文件名（含 `.md`）——对齐 pi 匹配规则，**不是** frontmatter name；编辑器展示名 = frontmatter name ?? id。
- 单测覆盖纯函数（modes.test.ts）；集成链路（panel → controller）不新增自动化（与 catalog 先例一致，UI 链路靠 build + 既有模式回归兜底）。
- 验证命令固定：`npm run compile`（含 lint）、`npm test`。
- 中文注释、Conventional Commits（`feat(modes):` / `feat(webview):`）。

## Key Facts（实测 pi 0.84.x dist 得出，写代码前必读）

- `isEnabledByOverrides(filePath, patterns, baseDir)`（package-manager.js:519）：`!p` 排除对 minimatch(rel)、basename、绝对 posix 路径、**SKILL.md 的父目录 rel/目录名/posix 路径**任一命中即禁用 ⇒ `!foo` 禁用任意深度的名为 foo 的 skill 目录与根文件 foo.md。
- 用户 scope 自动发现 skills（`<agentDir>/skills`、`~/.agents/skills`）只受**全局** settings `skills` overrides 影响；项目 scope（`.pi/skills`、`.agents/skills`，需项目 trusted）只受**项目** settings 影响 ⇒ 切换模式须写两个文件。
- 包 skills 走 resolvePackageSources 的对象过滤，与 `skills` overrides 无交集 ⇒ 模式不管包 skills。
- restart() 后 spawn 以 `--session <lastSessionFile>` 恢复当前会话（controller.restoreSessionArg）。

## File Structure

| 文件 | 职责 |
|------|------|
| `vscode/src/chat/modes.ts`（新增） | 纯函数：`readModesState`/`writeModesState`/`parseSkillFrontmatter`/`scanLocalSkills`/`computeExclusions`/`mergeSkillsEntries` |
| `vscode/src/test/modes.test.ts`（新增） | 上述纯函数单测（临时目录真实扫描） |
| `vscode/src/chat/controller.ts`（修改） | `ChatStatus.modeName`；`getModeState`/`createMode`/`deleteMode`/`updateModeSkills`/`switchMode`；启动回读 `refreshModeName`；`confirmModeApply` |
| `vscode/src/chat/panel.ts`（修改） | 5 个 Webview 消息接口 + handler 透传 |
| `vscode/webview-ui/src/types.ts`（修改） | `AgentMode`/`ModeSkill`/`ModeState` + HostMessage `modeState` + ChatStatus `modeName` |
| `vscode/webview-ui/src/components/ModePopover.tsx`（新增） | 模式管理弹层（居中模态）：单选切换/勾选 skill/新建/删除 |
| `vscode/webview-ui/src/components/Composer.tsx`（修改） | 输入框开头模式 chip（绝对定位，点击开弹层） |
| `vscode/webview-ui/src/App.tsx`（修改） | modeState 状态 + popover `"mode"` 接线 + chip ref 下发 |
| `vscode/webview-ui/src/styles.css`（修改） | `.composer-mode-chip` + 输入区让位 padding + 弹层样式（复用 extension-popover 系） |

---

### Task 1: 宿主纯函数模块 `modes.ts` + 单测

- [ ] `readModesState(settings)`：防御解析 `settings.pinel.modes` → `{ active: string|null, modes: AgentMode[] }`（形状不符逐层容缺为空态；mode 名非空字符串、skills 字符串数组过滤）。
- [ ] `writeModesState(settings, state)`：写回 `settings.pinel.modes`（`settings.pinel` 节合并保留 autoCommit 等其余键）。
- [ ] `parseSkillFrontmatter(raw)`：取首个 `---` 块内 `name:`/`description:` 行（正则，行首锚定；无块/字段缺省 → undefined）。
- [ ] `scanLocalSkills(agentDir, homeDir, projectRoot?)`：四根扫描——`<agentDir>/skills`（pi 式：SKILL.md 目录递归 + 根 `.md` frontmatter 文件）、`~/.agents/skills`（agents 式：仅 SKILL.md 目录）、`<root>/.pi/skills`（pi 式）、`<root>/.agents/skills`（agents 式，无 root 跳过）；跳过 dotfiles/node_modules/符号链接目录、深度上限 6；产出 `{ id, name, description?, scope }`，按 name 字母序排序。id = 目录名 / 根文件名（含 .md）。
- [ ] `computeExclusions(skills, activeIds)`：`{ global: 未选中全局 id 列表, project: 未选中项目 id 列表 }`。
- [ ] `mergeSkillsEntries(raw, exclusionIds)`：保留非 `!` 字符串条目 + 追加 `!${id}`（去重）。
- [ ] `modes.test.ts`：frontmatter 解析（有/无/缺字段）、扫描（tmp 目录：嵌套 skill 目录、根 .md、agents 式忽略根 .md、深度/跳过规则）、exclusions 计算、merge 保留非 `!` 条目、read/write 往返。

### Task 2: controller + panel 接线

- [ ] `ChatStatus` 加 `modeName?: string`（激活模式名；undefined = Default）。启动回读 `refreshModeName()`（镜像 refreshAutoCommit：读失败保持缺省）。
- [ ] 私有助手：`readModesFromDisk()`（fail-soft 空态）、`persistModes(state)`（全局 settings 合并写）、`applyActiveMode(state)`（scan → computeExclusions → 两个 scope `readSettings`+`mergeSkillsEntries`+`writeSettings`；无 workspace 只写全局）。
- [ ] 公开操作（均广播 `modeState` + 失败 notice）：
  - `getModeState()`：scan + read → 载荷 `{ active, modes, skills }`；
  - `createMode(name)` / `deleteMode(name)`：删激活项时 active=null 并 applyActiveMode + confirmModeApply；
  - `updateModeSkills(name, skills)`：仅保留扫描命中的 id；name 为激活项时 applyActiveMode + confirmModeApply；
  - `switchMode(name|null)`：置 active、persist、applyActiveMode、更新 `status.modeName` 广播 status、confirmModeApply → restart()。
- [ ] `confirmModeApply()`（导出，镜像 confirmExtensionReload 文案 "Mode changed. Reload pi to apply skills?" / "Reload"）。
- [ ] `OutMessage` 加 `{ type: "modeState"; state }`；panel.ts 加 5 个消息接口 + handler。

### Task 3: webview UI

- [ ] `types.ts`：`AgentMode`/`ModeSkill`/`ModeState` 镜像 + `modeState` HostMessage + `ChatStatus.modeName`。
- [ ] `Composer.tsx`：新 props `modeName?/modesOpen/onOpenModes/modeChipRef`；`.composer-input-wrap` 内渲染 chip（模式名 ?? "Default"）。
- [ ] `ModePopover.tsx`：居中模态（overlay + Esc capture + 焦点还原，照抄 ExtensionPopover 骨架）；Default + 模式列表（单选切换、skill 计数、× 删除）；选中模式编辑区 = skill 勾选清单（scope 徽标 + description 省略）；底部新建行（输入 + Add）；列表与 skill 清单按字母排序。
- [ ] `App.tsx`：`modeState` 状态、`"mode"` popover 枚举、chip ref、消息分发 case、ModePopover 挂载、Composer props 下发。
- [ ] `styles.css`：`.composer-mode-chip`（绝对定位 7px/2px、max-width 84px 省略、单行高）、`.composer-with-mode` 让位（`.composer-input` padding-left: 88px、`.composer-md` left: 88px）、弹层复用 `extension-popover*` 类 + `.mode-*` 增量样式。

### Task 4: 验证 + 提交

- [ ] `npm run compile`（tsc 双 tsconfig + lint，0 error）
- [ ] `npm test`（全绿，含新增 modes.test.ts）
- [ ] 手工冒烟（可选，F5）：切模式 → Reload → `get_commands` skills 集合变化；输入框 chip 显示与让位。
- [ ] `git -C vscode` 提交（计划文档 + 实现分两个 commit 或合一，消息 `feat(modes): ...`）。

## Risks / ponytail ceilings（记录在代码注释）

1. 用户手写的 `!` 排除项会被模式切换重算覆盖（切回 Default 即清空全部排除）。
2. 项目 scope 排除仅写入**切换时的工作区**；其他工作区需各自切换一次才应用项目级排除（全局 scope 排除天然全工作区生效）。
3. 包 skills / settings 显式路径 skills 不受模式管（前者按包启停，后者保留非 `!` 条目恒加载）。
4. 多窗口同时切模式：全局 settings last-write-wins。
