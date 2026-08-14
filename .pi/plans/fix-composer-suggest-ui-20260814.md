# 修复计划：命令补全弹窗 hover 可读性 + 键盘导航滚动

> 状态：✅ 已实施（2026-08-14；F5 人工验收待用户执行）
> 日期：2026-08-14
> 仓库：`C:/source_code/Other/pinel`
> 关联：commit 4094b95 引入的 /命令自动补全弹窗（`feat-command-autocomplete-20260814.md`）的两处 UI 缺陷

## 1. 问题复现

1. 输入框键入 `/` 弹出候选列表；**鼠标 hover 候选行时，高亮背景使命令描述与来源类型文字看不清**（暗灰文字叠在高亮背景上对比度骤降）
2. 候选超过弹窗可视高度后（max-height 200px），**按 ↓ 到列表底部时容器不滚动，被选中项不可见**

## 2. 根因分析（证据链）

**问题 1**：
- `Composer.tsx`：候选项 `onMouseEnter → setHighlight(i)` → 行获得 `.active` 类（hover 与键盘选中共用该高亮态）
- `styles.css` `.composer-suggest-item.active`：设置 `background: var(--vscode-quickInputList-focusBackground)` 与 `color: var(--vscode-quickInputList-focusForeground)`
- **但** `.composer-suggest-desc` 与 `.composer-suggest-source` 各自显式声明 `color: var(--vscode-descriptionForeground)`，覆盖了继承的焦点前景色 → 背景换成高亮色的同时文字仍是暗灰（亮主题下对比度约 3:1，具体数值随主题变量浮动；徽标另叠 `input-border` 深色边框更显浑浊）
- **官方对照**（microsoft/vscode main 分支 `quickInput.css` 行 413-416「focused items in quick pick」）：聚焦行内的辅助元素统一 `color: inherit`（跟随行的 focusForeground）；描述类再以降不透明度分层（issue microsoft/vscode#276764 佐证官方对 quick pick 描述用 opacity 手法）
- 结论：辅助元素颜色未随高亮态切换，覆盖了行级前景色

**问题 2**：
- `.composer-suggest` 有 `max-height: 200px; overflow-y: auto`，长列表必出滚动条
- `Composer.tsx` 键盘分支仅 `setHighlight`（ArrowDown → `min(h+1, len-1)`），**无任何把高亮项滚入视口的逻辑**；候选为纯 `div`（非可聚焦元素），浏览器不会因高亮变化自动滚动
- 结论：高亮状态变化与滚动位置无同步机制

## 3. 修复方案

**问题 1（styles.css 单文件）**：激活行内辅助元素跟随官方 QuickPick 行为——

```css
.composer-suggest-item.active .composer-suggest-desc {
  color: inherit;            /* 跟随 quickInputList.focusForeground */
  opacity: 0.7;              /* 降不透明度保持视觉层级 */
}

.composer-suggest-item.active .composer-suggest-source {
  color: inherit;
  opacity: 0.8;              /* 徽标略高：文本更小需要更多对比 */
  border-color: color-mix(in srgb, currentColor 35%, transparent); /* 边框随文字色，避免深色 input-border 浑浊 */
}
```

名称（`.composer-suggest-name`）无需改动——已正确继承行级 `color`。

**替代方案权衡**（已与用户确认选官方同款）：
| 方案 | 权衡 |
|---|---|
| ✅ QuickPick 官方同款（inherit + opacity） | 与 VS Code 自身交互一致；hover/键盘共用一个高亮态，状态模型不变 |
| hover 与键盘高亮分离（hover 用浅色 list-hoverBackground） | 需新增 hovered 状态与 setHovered 逻辑，改动大、状态更复杂 |
| 只改文字不改背景 | 对比度问题未根治 |

**问题 2（Composer.tsx 单文件）**：

- 给 `.composer-suggest` 容器加 `suggestRef`
- 新增滚动同步 effect，**依赖 `[activeIndex, candidates]`**：`suggestRef.current?.querySelectorAll(".composer-suggest-item")[activeIndex]?.scrollIntoView({ block: "nearest" })`
  - 依赖含 `candidates` 的理由（评审 M1）：仅依赖 `activeIndex` 时，滚轮滚到底 + 高亮已在 0 + 过滤后列表变化（activeIndex 值不变）不会触发滚动，首项高亮不可见；`candidates` 同时覆盖列表变化（过滤/命令刷新）与高亮移动两条路径
- `block: "nearest"` 保证只滚动最近的滚动容器（弹窗本体）——弹窗是 `.composer` 的绝对定位子元素，**根本不是 `.pinel-scroll` 的后代**，不会牵动消息列表；默认 instant 动画，键盘连按即时跟随
- 已知有意行为（评审 L1/L4）：鼠标 hover 改变 highlight 会触发本 effect（`nearest` 无跳跃，良性）；鼠标离开后高亮保留在最后 hover 项——与 VS Code QuickPick 焦点行为一致，修复后保留，不视为回归

**方案权衡**：`scrollIntoView({block:'nearest'})`（标准 DOM API、无新依赖）vs 手动计算 `scrollTop/offsetTop`（需处理 clientHeight 边界，易错）——选前者。

## 4. 任务拆解（与 todo 镜像）

| id | 任务 | blockedBy |
|---|---|---|
| 8 | 激活行文字配色修复（styles.css） | — |
| 9 | 键盘导航滚动同步（Composer.tsx） | — |
| 10 | 验证与文档 | 8, 9 |

## 5. 涉及的文件

```
webview-ui/src/styles.css                # 激活行 desc/source 配色（任务 8）
webview-ui/src/components/Composer.tsx   # suggestRef + scrollIntoView effect（任务 9）
CHANGELOG.md                             # Fixed 条目（任务 10）
```

## 6. 验证方式与风险

**验证**（用户已确认：F5 人工验收，不引入 webview 测试基建——宿主 mocha 无法覆盖 webview DOM，与仓库既有惯例一致）：
- `npm run compile` 全绿（类型 + lint + 双 bundle；CSS 不在 lint 范围，视觉由人工验收）
- `npm test` 全绿（纯 webview 改动预期不影响宿主 46 测试，按 AGENTS.md 提交门槛跑一遍确认）
- F5 复现路径 1：`/` 弹窗 → hover 各候选行 → 描述与类型徽标在高亮下清晰可读（亮/暗两主题）
- F5 复现路径 2：命令多到超过弹窗高度（或缩小面板）→ 连续 ↓ 到底部/↑ 回顶部 → 选中项始终在可视区内，消息列表不被牵动
- F5 补充路径（评审 M1/L2）：滚轮把弹窗滚到底 → 继续输入过滤 → 高亮重置回顶且首项可见；面板缩到比弹窗矮 → 弹窗被视口裁剪处无页面级滚动/无异常
- 无回归：点击/Enter/Tab 接受、Esc 分层（先关弹窗）、IME 组合输入、鼠标离开后高亮残留（有意行为，与 QuickPick 一致）

**风险**：

| 风险 | 缓解 |
|---|---|
| `scrollIntoView` 兼容性 | Chromium（webview）全版本支持 `block: 'nearest'`，无风险 |
| opacity 0.7/0.8 在个别自定义主题仍偏淡 | 数值与官方 QuickPick 手法一致；用户 F5 反馈后可微调 |
| `querySelectorAll` 与渲染时序 | effect 在 commit 后执行，DOM 已就绪；candidates 与 DOM 一一对应（key=name-i） |

## 7. 决策点（已确认）

1. ✅ 修复方案：QuickPick 官方同款（inherit + 降不透明度；hover 与键盘共用一个高亮态）
2. ✅ 回归验证：F5 人工验收（不引入 webview 测试基建）

## 8. 调研记录（工具使用）

- **web_search**（强制，官方仓库核对）：microsoft/vscode `quickInput.css` 聚焦行辅助元素 `color: inherit` 规则（行 413-416）；`quickInputList.focusBackground/focusForeground` 主题变量（quickInputService.ts）；quick pick 描述 opacity 处理（issue #118214、#276764）
- **context7**：不适用（纯 CSS + DOM API，无库 API 语义问题）
- **MATLAB MCP**：未配置，跳过
- **memory**：已检索 `slash-command-autocomplete` 实体（无历史缺陷记录；实现约束与本次修复不冲突）

## 9. 执行记录（实施后回溯更新）

- **实施**：styles.css 加两条激活行规则（desc inherit+opacity 0.7 / source inherit+opacity 0.8+border-color color-mix）；Composer.tsx 加 suggestRef + 滚动 effect（依赖 `[activeIndex, candidates]`，评审 M1 修订）；`npm run compile` 与 `npm test` 全绿（46/46）
- **评审修订**（计划阶段）：滚动 effect 依赖加 `candidates`（滚轮到底+过滤路径）；F5 清单补 npm test、极短面板场景、hover 残留行为声明
- **待用户 F5 人工验收**：两条复现路径（hover 可读性亮/暗主题、方向键到底选中项可见）+ 补充路径（滚轮到底+过滤回顶、极短面板）+ 无回归项（接受三式/Esc 分层/IME）
