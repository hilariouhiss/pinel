# 推荐安装插件（catalog Recommended 分组 + pi 依赖瘦身）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Ruling (2026-09-01):** 推荐集计数以枚举清单为准 = 12 项（原 13 个死依赖 − tui-only 的 rpiv-voice）。文中「11」为计划撰写时的算术错误，已按 12 修正。

**Goal:** 修复审计问题 2：pi/package.json 的 13 个从未被 import 也从不被 pi 加载的死依赖全部删除（只留 rpiv-workflow），配套插件套件改由 Pinel 面板目录的「Recommended」分组一键推荐安装。

**Architecture:** pi 侧纯删除（package.json 依赖瘦身 + README 安装指引改写）；vscode 侧在既有目录流上加「推荐」概念——`CatalogEntry` 加 `recommended` 标记（12 项：@gotgenes×9 + rpiv-args + rpiv-ask-user-question + rpiv-todo，剔除 tui-only 的 rpiv-voice），`installSpecsForGroup` 联合扩展 `"recommended"`，ExtensionPopover 目录视图顶部新增 Recommended 分组与「Install recommended (N)」按钮，安装执行复用既有 `installCatalogEntries`（spawn `pi install` 逐个，120s 超时，写全局 settings）。零新机制、零新依赖。

**Tech Stack:** TypeScript（pi 包与 vscode 扩展既有约定）、vitest（pi 测试）、mocha + vscode-test（vscode 测试）、真实 pi 冒烟（`npm run smoke:plugin`，验证依赖瘦身后插件加载链路）。

**Spec:** 本会话用户需求（逐字）："编写计划，修复第二个问题，实现为推荐安装插件" + 三个已确认决策：推荐范围 = 12 个（剔除 rpiv-voice）；UI = Recommended 分组 + 一键装；pi 依赖 = 全部删除只留 rpiv-workflow。

## Global Constraints

- 两个独立 git 仓库：`c:/source_code/Other/pinel/pi` 与 `c:/source_code/Other/pinel/vscode`。两仓各自提交；命令用 `git -C <绝对路径>`。
- 不新增任何 npm 依赖，只删依赖（pi 侧）。vscode 侧零依赖变动。
- 推荐集 = 12 项，**rpiv-voice 排除**（tui-only，面板内无效）；rpiv-voice 的 `defaultSet: true` 保持不变（rpiv-mono 默认集语义不动）。
- 推荐项在其原分组（pi-packages / rpiv-mono）内**原样保留**——Recommended 分组是置顶货架，不是从原组移出。
- 安装执行复用 `installCatalogEntries`（写真实全局 settings）：集成测试不得直调安装链路，单测覆盖纯函数（catalog.test.ts）。
- pi 侧 `@juicesharp/rpiv-workflow` 是唯一被代码 import 的依赖（`pinel-workflows.ts`/`workflows/*.ts`），保留；`typebox` 已在 peerDependencies（pi 核心捆绑），不动。
- pi 仓库约定：相对导入 `.js` 后缀、中文注释、Conventional Commits（`refactor(pi-pinel):` / `docs(pi-pinel):`）；vscode 约定同（`feat(catalog):` / `feat(webview):`）。
- 历史计划文档（两仓 `docs/superpowers/plans/` 既有文件）一律不改。
- 验证命令固定：pi `npx vitest run`；vscode `npm run check-types`、`npm run check-plugin`、`npm run lint`、`npm test`、`npm run smoke:plugin`（冒烟在临时项目 `pi install -l` 安装瘦身后的 pi 包——**依赖瘦身端到端验证的关键**）。

## File Structure

| 文件 | 职责 |
|------|------|
| `pi/package.json`（修改） | dependencies 只留 rpiv-workflow |
| `pi/package-lock.json`（修改） | npm install 同步 |
| `pi/README.md`（修改） | 安装节改写：推荐套件指向面板 Catalog → Recommended |
| `vscode/src/chat/catalog.ts`（修改） | `recommended?: boolean` 标记 12 项；`installSpecsForGroup` 扩展 `"recommended"` |
| `vscode/src/chat/panel.ts`（修改） | `WebviewInstallCatalogGroupMessage.group` 联合加 `"recommended"` |
| `vscode/src/test/catalog.test.ts`（修改） | 推荐集断言（12 项、rpiv-voice 排除、installSpecsForGroup("recommended")） |
| `vscode/webview-ui/src/types.ts`（修改） | `CatalogItem` 加 `recommended?: boolean` |
| `vscode/webview-ui/src/components/ExtensionPopover.tsx`（修改） | Recommended 分组 + 一键装按钮 + recommended 徽标；行渲染抽为共用函数；修两处过期横幅文案 |

---

### Task 1: pi 依赖瘦身 + README 安装指引

**Files:**
- Modify: `pi/package.json`、`pi/package-lock.json`
- Modify: `pi/README.md`

**Interfaces:**
- Consumes: 现状——dependencies 14 个，仅 `@juicesharp/rpiv-workflow` 被代码 import（`pinel-workflows.ts`/`workflows/sp-shared.ts` 等，已核实 grep 仅 rpiv-workflow 命中）。
- Produces: dependencies 仅 `{ "@juicesharp/rpiv-workflow": "^2.7.1" }`；README 安装节不再声称套件「随本包依赖自动安装」。

- [ ] **Step 1: 基线验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿（46/46）。

- [ ] **Step 2: package.json 依赖裁剪**

`pi/package.json` 的 `dependencies` 字段整块替换为：

```json
  "dependencies": {
    "@juicesharp/rpiv-workflow": "^2.7.1"
  },
```

（删除全部 9 个 `@gotgenes/*` 与 `rpiv-args`、`rpiv-ask-user-question`、`rpiv-todo`、`rpiv-voice`；peerDependencies/devDependencies 不动。）

- [ ] **Step 3: 同步 lockfile**

Run: `cd c:/source_code/Other/pinel/pi && npm install`
Expected: 成功；`package-lock.json` 更新（rpiv-workflow 及其传递依赖保留，其余包移除）。

- [ ] **Step 4: 残留 import 扫描**

Run: `cd c:/source_code/Other/pinel/pi && grep -rn "@gotgenes\|rpiv-args\|rpiv-ask-user-question\|rpiv-todo\|rpiv-voice" --include="*.ts" . | grep -v node_modules`
Expected: 零输出（源码零引用已删包；仅 rpiv-workflow 合法保留）。

- [ ] **Step 5: README 安装节改写**

`pi/README.md` 的「## 安装」节中，删掉误导行：

```markdown
> rpiv-workflow、@gotgenes/* 工具集与 rpiv-args/ask-user-question/todo/voice
> 随本包依赖自动安装；rpiv-pi 需单独安装并在 settings.json packages 中加载。
```

替换为：

```markdown
> rpiv-workflow 随本包依赖自动安装。推荐的配套插件（pi-subagents、pi-colgrep、
> rpiv-ask-user-question、rpiv-todo 等 12 个）在 Pinel 面板
> Extensions → Catalog → Recommended 一键安装；rpiv-pi 需单独安装并在
> settings.json packages 中加载。
```

（安装节前两行 `pi install <本包路径或 npm 源>` 与 superpowers 行原样不动。）

- [ ] **Step 6: 验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿。

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-plugin`
Expected: 零错误（tsc 跟随 pinel.ts import 检查，rpiv-workflow/typebox 解析不受影响）。

- [ ] **Step 7: 提交（pi 仓库，两个）**

```bash
git -C c:/source_code/Other/pinel/pi add package.json package-lock.json
git -C c:/source_code/Other/pinel/pi commit -m "refactor(pi-pinel): drop unused dependencies, keep rpiv-workflow"
git -C c:/source_code/Other/pinel/pi add README.md
git -C c:/source_code/Other/pinel/pi commit -m "docs(pi-pinel): recommended suite install via panel catalog"
```

---

### Task 2: vscode 宿主——推荐集数据与消息面

**Files:**
- Modify: `vscode/src/chat/catalog.ts`
- Modify: `vscode/src/chat/panel.ts`
- Modify: `vscode/src/test/catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 不涉及本仓。既有 `CatalogEntry`/`installSpecsForGroup`/`WebviewInstallCatalogGroupMessage`。
- Produces: `CatalogEntry.recommended?: boolean`（12 项为 true）；`installSpecsForGroup(group: CatalogGroup | "recommended")`；`WebviewInstallCatalogGroupMessage.group: "pi-packages" | "rpiv-mono" | "recommended"`。`CatalogGroup` 类型本身不变（目录项仍只有两组）。

- [ ] **Step 1: catalog.ts 加 recommended 标记**

- `CatalogEntry` 接口（`defaultSet?: boolean` 之后）加一行：

```typescript
  /** 推荐安装集成员（面板 Catalog → Recommended 分组；12 项，剔除 tui-only 的 rpiv-voice）。 */
  recommended?: boolean;
```

- 为 12 项加 `recommended: true`（位置紧随各条目 `compat` 字段或任意字段顺序均可，保持现有条目排版风格）：
  - @gotgenes 全部 9 项：`pi-permission-system`、`pi-permission-model-judge`、`pi-subagents`、`pi-github-tools`、`pi-autoformat`、`pi-colgrep`、`pi-session-tools`、`pi-subagents-worktrees`、`pi-nocd`
  - rpiv 侧 2 项：`rpiv-args`、`rpiv-ask-user-question`、`rpiv-todo` —— 共 12 项；注意 **rpiv-voice 不加**（其 `defaultSet: true` 保持原样）。

- [ ] **Step 2: catalog.ts 扩展 installSpecsForGroup**

替换函数为：

```typescript
/** 组批量安装 spec 列表：pi-packages = git 整仓 9 包；rpiv-mono = 默认集三包（用户指定）；
 *  recommended = 推荐集 12 项（跨两组，剔除 tui-only 的 rpiv-voice）。 */
export function installSpecsForGroup(group: CatalogGroup | "recommended"): string[] {
  if (group === "pi-packages") {
    return [PI_PACKAGES_ALL_SPEC];
  }
  if (group === "rpiv-mono") {
    return defaultInstallSpecs("rpiv-mono");
  }
  return CATALOG.filter((e) => e.recommended).map((e) => e.installSpec);
}
```

（`CatalogGroup` 类型与 `getCatalogGroup`/`defaultInstallSpecs` 不动。）

- [ ] **Step 3: panel.ts 消息联合扩展**

`WebviewInstallCatalogGroupMessage` 接口的 group 字段改为：

```typescript
/** 目录按组默认集安装（pi-packages = git 整仓；rpiv-mono = 默认集三包；
 *  recommended = 推荐集 12 项）。 */
interface WebviewInstallCatalogGroupMessage {
  type: "installCatalogGroup";
  group: "pi-packages" | "rpiv-mono" | "recommended";
}
```

（case 处理器 `msg.type === "installCatalogEntry" ? [msg.spec] : installSpecsForGroup(msg.group)` 不动——联合扩展后自然走通。）

- [ ] **Step 4: catalog.test.ts 断言扩展**

在 `describe("catalog 静态清单")` 内新增两个 it：

```typescript
  it("推荐集 = 12 项（@gotgenes×9 + rpiv-args/ask-user-question/todo），rpiv-voice 排除", () => {
    const recs = CATALOG.filter((e) => e.recommended);
    assert.strictEqual(recs.length, 12);
    assert.deepStrictEqual(
      recs.map((e) => e.id).sort(),
      [
        "pi-autoformat", "pi-colgrep", "pi-github-tools", "pi-nocd",
        "pi-permission-model-judge", "pi-permission-system", "pi-session-tools",
        "pi-subagents", "pi-subagents-worktrees",
        "rpiv-args", "rpiv-ask-user-question", "rpiv-todo",
      ].sort(),
    );
    assert.ok(!recs.some((e) => e.id === "rpiv-voice"), "tui-only 的 rpiv-voice 不得在推荐集");
    assert.ok(!recs.some((e) => e.compat === "tui-only"), "推荐集不得含 tui-only 项");
  });

  it("installSpecsForGroup：recommended = 推荐集 12 个 installSpec（目录顺序）", () => {
    const specs = installSpecsForGroup("recommended");
    assert.strictEqual(specs.length, 12);
    assert.deepStrictEqual(specs, CATALOG.filter((e) => e.recommended).map((e) => e.installSpec));
    for (const s of specs) {
      assert.ok(s.startsWith("npm:"), `推荐集 spec 应为 npm 形式：${s}`);
    }
  });
```

既有 `it("installSpecsForGroup：pi-packages = git 整仓；rpiv-mono = 默认集三包")` 不动。

- [ ] **Step 5: 验证**

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-types && npm run lint`
Expected: 零错误。

Run: `cd c:/source_code/Other/pinel/vscode && npx mocha --require ts-node/register src/test/catalog.test.ts` 不可用则跑 `npm run compile-tests && npx mocha out/test/catalog.test.js`
Expected: catalog 套件全绿（含新增两条）。

- [ ] **Step 6: 提交**

```bash
git -C c:/source_code/Other/pinel/vscode add src/chat/catalog.ts src/chat/panel.ts src/test/catalog.test.ts
git -C c:/source_code/Other/pinel/vscode commit -m "feat(catalog): recommended set with one-click install"
```

---

### Task 3: webview——Recommended 分组与横幅文案修复

**Files:**
- Modify: `vscode/webview-ui/src/types.ts`
- Modify: `vscode/webview-ui/src/components/ExtensionPopover.tsx`

**Interfaces:**
- Consumes: Task 2 的 `CatalogEntry.recommended`（经宿主 `catalogState` 消息广播）与 group 联合 `"recommended"`。
- Produces: `CatalogItem.recommended?: boolean`；ExtensionPopover 目录视图顶部 Recommended 分组 + `onInstallCatalogGroup("recommended", specs)` 调用。

- [ ] **Step 1: types.ts 加字段**

`CatalogItem` 接口（`defaultSet?: boolean;` 之后）加：

```typescript
  /** 推荐安装集成员（目录视图 Recommended 分组）。 */
  recommended?: boolean;
```

- [ ] **Step 2: ExtensionPopover 提取共用的目录行渲染**

把 `renderCatalog()` 内联的 `entries.map((e) => { ... })` 行渲染提取为组件函数 `renderCatalogRow(e: CatalogItem)`（内容一字不动，仅搬位置），并加 recommended 徽标（在 `{e.defaultSet && ...}` 之后）：

```tsx
  const renderCatalogRow = (e: CatalogItem) => {
    const busy = installing.has(e.installSpec);
    return (
      <div key={e.id} className="extension-item catalog-item">
        <div className="extension-item-main">
          <span className="extension-item-name" title={e.installSpec}>
            {e.name}
          </span>
          {e.compat !== "ok" && (
            <span className={`extension-item-badge compat-${e.compat}`} title={e.compatNote ?? ""}>
              {e.compat === "tui-only" ? "TUI only" : "limited"}
            </span>
          )}
          {e.defaultSet && <span className="extension-item-tag">default</span>}
          {e.recommended && <span className="extension-item-tag">recommended</span>}
          <span className="catalog-item-desc" title={e.description}>
            {e.description}
          </span>
        </div>
        {e.state === "installed" ? (
          <span className="catalog-item-installed">Installed</span>
        ) : (
          <button
            className="catalog-item-install"
            disabled={busy}
            title={e.installSpec}
            onClick={() => onInstallCatalogEntry(e.installSpec)}
          >
            {busy ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    );
  };
```

`renderCatalog()` 的两组渲染改为 `{entries.map(renderCatalogRow)}`，其余组头逻辑不动。

- [ ] **Step 3: Recommended 分组 + 一键装按钮**

在 `renderCatalog()` 返回的 `.catalog-groups` 容器最顶部（两个 catalogGroups.map 之前）插入：

```tsx
  // Recommended 货架：置顶列出推荐集（跨两组），一键装未装项；原分组内仍保留这些项
  const renderRecommended = () => {
    const recs = catalog.filter((e) => e.recommended);
    const pending = recs.filter((e) => e.state !== "installed");
    const busy = recs.some((e) => installing.has(e.installSpec));
    return (
      <div className="extension-popover-section">
        <div className="extension-popover-title catalog-group-header">
          <span>Recommended</span>
          <button
            className="catalog-group-install"
            disabled={pending.length === 0 || busy}
            title={`Install ${pending.length} recommended package${pending.length === 1 ? "" : "s"}`}
            onClick={() => onInstallCatalogGroup("recommended", recs.map((e) => e.installSpec))}
          >
            {busy ? "Installing…" : `Install recommended (${pending.length})`}
          </button>
        </div>
        {recs.map(renderCatalogRow)}
      </div>
    );
  };
```

并在 `.catalog-groups` 内渲染为 `{renderRecommended()}`（置于两个 catalogGroups.map 之前）。

- [ ] **Step 4: props 类型联合扩展**

`onInstallCatalogGroup` 的 props 类型改为：

```typescript
  /** 目录按组默认集安装（group + 实际 installSpec 列表，供 busy 标记）。 */
  onInstallCatalogGroup: (group: "pi-packages" | "rpiv-mono" | "recommended", specs: string[]) => void;
```

（App.tsx 的传参处 `(group, specs) => {...}` 不引用 group 值，无需改 App.tsx。）

- [ ] **Step 5: 修复过期横幅文案（问题 1 遗留）**

`pinelPluginState !== "installed"` 横幅两处文案改为：

```tsx
              {pinelPluginState === "removed"
                ? "Pinel plugin was removed — reinstall to restore live prompt composition, MCP status &amp; workflow tracking"
                : "Install the Pinel plugin to unlock live prompt composition, MCP status &amp; workflow tracking"}
```

- [ ] **Step 6: 验证**

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-types && npm run lint`
Expected: 零错误（含 webview tsc）。

- [ ] **Step 7: 提交**

```bash
git -C c:/source_code/Other/pinel/vscode add webview-ui/src/types.ts webview-ui/src/components/ExtensionPopover.tsx
git -C c:/source_code/Other/pinel/vscode commit -m "feat(webview): recommended group in catalog view"
```

---

### Task 4: 全量回归 + 冒烟（依赖瘦身端到端验证）

**Files:** 无新文件。

- [ ] **Step 1: 两仓全量验证**

Run: `cd c:/source_code/Other/pinel/pi && npx vitest run`
Expected: 全绿。

Run: `cd c:/source_code/Other/pinel/vscode && npm run check-types && npm run check-plugin && npm run lint`
Expected: 零错误。

Run: `cd c:/source_code/Other/pinel/vscode && npm test`
Expected: 全绿（含 catalog 新断言）。

- [ ] **Step 2: 冒烟（关键：瘦身后插件加载）**

Run: `cd c:/source_code/Other/pinel/vscode && npm run smoke:plugin`
Expected: `SMOKE OK: 插件加载 / pinel.prompt 启动帧 / pinel.mcp 基线帧全部通过`——冒烟在临时项目 `pi install -l` 安装瘦身后的 pi 包（npm install 只装 rpiv-workflow + 传递依赖），验证插件 manifest/import 链不依赖已删包。

- [ ] **Step 3: 残留扫描（必须零输出）**

Run:

```
grep -rn "@gotgenes\|rpiv-args\|rpiv-ask-user-question\|rpiv-todo\|rpiv-voice" c:/source_code/Other/pinel/pi --include="*.ts" --exclude-dir=node_modules --exclude-dir=docs
```

Expected: 零输出（README 的推荐指引文案在 `.md`，不在本 grep 范围）。

- [ ] **Step 4: 两仓状态检查**

Run: `git -C c:/source_code/Other/pinel/pi status --short && git -C c:/source_code/Other/pinel/vscode status --short`
Expected: 两仓干净（本计划文件已在 vscode 仓提交）。

---

## Self-Review

- **Spec coverage:** 三决策全覆盖——12 项推荐集（Task 2 Step 1 显式列出、rpiv-voice 排除并在测试断言）→ Recommended 分组 + 一键装（Task 3 Steps 2-4）→ pi 依赖全删只留 rpiv-workflow（Task 1 Steps 2-4）+ README 指引（Task 1 Step 5）。审计问题 2 的「装而不加载」矛盾随依赖删除消失；横幅文案修复是审计问题 1 的遗留收尾（Task 3 Step 5）。
- **Placeholder scan:** 无 TBD/TODO；所有代码块完整；12 项清单与 installSpecsForGroup("recommended") 的过滤逻辑一致；冒烟作为瘦身端到端验证已写入 Step 2。
- **Type consistency:** `recommended?: boolean` 三处一致（catalog.ts CatalogEntry ↔ types.ts CatalogItem ↔ ExtensionPopover 消费）；group 联合 `"recommended"` 三处一致（catalog.ts installSpecsForGroup 参数 ↔ panel.ts 消息类型 ↔ ExtensionPopover props）；`CatalogGroup` 类型保持不变与「目录项仍两组」约束一致。catalog.test.ts 新增断言与 catalog.ts 实现同构（filter 逻辑两侧相同是测试意图，非复制实现）。
