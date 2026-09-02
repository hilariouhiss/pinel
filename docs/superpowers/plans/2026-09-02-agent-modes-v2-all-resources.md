# 模式 v2：范围扩大至所有 skills + 扩展（含包资源）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模式可配置范围从「本地 skills」扩大到「所有 skills + 扩展」：本地（全局/项目）+ **包提供的** skills 与 extensions 全部可按模式启停；Default = 全部生效。

**Architecture（实测 pi 0.84.2 dist/core/package-manager.js）：**
- **包对象过滤同为排除形**：`applyPatterns` 空 includes = 全部启用，`!rel`（相对**包根**的 posix 路径）排除 → 包条目写 `{source, skills:["!skills/foo"], extensions:["!extensions/x.ts"]}` 即可，省略键 = 该类型全量加载。
- **本地扩展**：`isEnabledByOverrides` 同样作用于 auto-discovered extensions（无 SKILL.md 特例）→ 全局/项目 settings 的 `extensions` 数组写 `!<相对 baseDir 的 posix 路径>`（目录式扩展 basename 恒为 index.ts，必须用完整 rel 路径防碰撞）。
- **基线快照**：Pinel 覆写包条目前把原条目存 `pinel.modes.packageBaseline`（identity → 原值）；无需过滤时还原并清除。还原/覆写只动 `skills`/`extensions` 两键，包条目的 `prompts`/`themes` 等用户自定义键保留。
- **id 方案**（模式配置里的不透明键）：`local|<scope>|<名>`（skill=目录名/文件名；扩展=baseDir 相对 posix 路径）与 `pkg|<identity>|<包根相对 posix 路径>`；scan 产物带 `pattern`（排除模式体）与 `identity`，避免 UI/配置解析 id。

**Spec:** 用户需求（逐字）：「skills 范围扩大至所有skills和扩展」。

## Global Constraints

- 历史计划文档不改；本文件为 v2 附录。
- 不新增依赖；仅 vscode 仓。settings 纪律同 v1（严格 JSON、原子写、损坏不覆盖）。
- ponytail ceilings：① 包资源只扫**约定目录**（`<pkgRoot>/skills`、`<pkgRoot>/extensions`），`pi` manifest 自定义路径不扫；② 包条目覆写会丢用户自定义 `prompts/themes` 过滤（键保留、值保留——只覆写 skills/extensions 两键，原对象其余键原样保留，无丢失）；③ 扩展弹层的包启停（字符串↔全空对象）会覆盖模式过滤，下次切模式重算；④ `autoload:false` 项目 delta 包不管理；⑤ 编辑激活模式期间用户手改包过滤会被基线还原覆盖。

## File Structure

| 文件 | 职责 |
|------|------|
| `vscode/src/chat/modes.ts`（重写扩展） | `ModeSkill`/`ModeExtension`（id/pattern/identity）、`AgentMode.extensions`、`ModesState.packageBaseline`、`scanModeInventory`、`modeApplyPlan`、`planPackageEntries` |
| `vscode/src/chat/extensions.ts`（修改） | 导出 `collectLocalExtensions`（包 extensions 目录扫描复用） |
| `vscode/src/chat/controller.ts`（修改） | `applyActiveMode` v2（本地 overrides + 包过滤 + 基线持久化）、`getModeState` 带 extensions、`updateModeSkills` 加 extensions 参数 |
| `vscode/src/chat/panel.ts`（修改） | `updateModeSkills` 消息加 `extensions` |
| `vscode/webview-ui/src/types.ts` + `ModePopover.tsx`（修改） | `ModeState.extensions`、扩展勾选清单区 |
| `vscode/src/test/modes.test.ts`（修改） | v2 纯函数用例 |

---

### Task 1: modes.ts v2 + 单测
- [ ] 类型：`ModeSkill`/`ModeExtension`（id/pattern/name/scope/package?/identity?）；`AgentMode.extensions`；`ModesState.packageBaseline`
- [ ] `scanModeInventory(agentDir, homeDir, projectRoot?, packages)`：本地 skills（现逻辑，id 改复合键）+ 本地扩展（复用 `scanLocalExtensions`，pattern = baseDir 相对 posix）+ 包 skills/extensions（`installedPackageRoot` → 约定目录扫描，未安装跳过）
- [ ] `modeApplyPlan(state, scan)`：Default → 全空；否则按 scope 出本地排除组 + 按 identity 分组包排除
- [ ] `planPackageEntries(packages, exclusions, baseline, baseDir)`：首覆写快照基线、免过滤还原基线、保留原对象其余键、修剪陈旧基线
- [ ] 单测：扫描（本地+包混合、未装包跳过）、plan（Default/混合/包分组）、planPackageEntries（快照/还原/键保留/修剪）、baseline 读写往返

### Task 2: 接线
- [ ] controller：`applyActiveMode`（两文件本地 overrides + 两文件包过滤 + baseline 变更回写 pinel.modes）；`getModeState` 加 extensions；`updateModeSkills(name, skills, extensions)`
- [ ] panel/types/App/ModePopover：消息与扩展清单 UI（scope 徽标 global/project/package，title 显示包名）

### Task 3: 验证 + 提交
- [ ] `npm run compile`、`npm test` 全绿；`git -C vscode` 提交 `feat(modes): 模式范围扩大至所有 skills + 扩展`
