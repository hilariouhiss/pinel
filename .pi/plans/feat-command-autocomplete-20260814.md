# 计划：/命令自动补全

> 状态：✅ 已实现（2026-08-14，实现后评审通过；F5 人工验收待用户执行）
> 日期：2026-08-14
> 仓库：`C:/source_code/Other/pinel`

## 1. 背景与目标

Pinel 聊天输入框目前是纯 textarea，用户输入 pi 的斜杠命令（`/fix`、`/plan`、`/skill:xxx`、自定义扩展命令等）全靠记忆。本计划为输入框添加 `/` 命令自动补全：输入 `/` 后弹出候选下拉列表（命令名 + 描述 + 来源徽标），支持键盘与鼠标选择，接受后插入 `/命令 ` 并留在输入框继续编辑。

**已与用户确认的决策点（4 项，全部采纳推荐项）**：

1. **触发位置**：仅消息开头（pi 源码实测：只有 `text.startsWith("/")` 时才被当作命令执行/展开；中段 `/xxx` 只作为普通文本发送）
2. **数据源**：pi 动态列表（RPC `get_commands`：扩展命令 + 提示模板 + 技能，随 pi 启动/settle 刷新）
3. **UI 形态**：下拉候选列表（非 ghost 内联文本）
4. **插入行为**：插入 `/命令 `（含尾部空格），光标留在输入框

## 2. 方案设计

### 2.1 数据链路

```
pi 子进程 ──get_commands──▶ ChatController.commands ──snapshot/commands──▶ App ──props──▶ Composer 弹窗
```

- **协议实测**（pi 0.84.x，`dist/modes/rpc/rpc-mode.js` L539）：`get_commands` 返回
  `{type:"response",command:"get_commands",success:true,data:{commands:[{name,description?,source:"extension"|"prompt"|"skill",sourceInfo}]}}`
- **注意文档漂移**：官方 `docs/rpc.md` 示例写的是 `path`/`location` 字段，实际实现返回 `sourceInfo`——协议类型以**实现为准**，防御解析只取 `name`/`description`/`source`（`sourceInfo` 本版本不用，预留 `unknown`）
- **拉取时机**：`start()` 在 `get_messages` 之后拉取一次；`agent_settled` 时刷新（扩展可能在会话运行中注册新命令）；`restart` 清空后随新启动流程重拉；视图隐藏重显经 snapshot 自动恢复（与 todos 同模式）
- **拉取语义（关键）**：一律 **fire-and-forget**（`void this.fetchCommands()`，内部 try/catch + client 身份校验丢弃迟到结果）——**不得 await 阻塞、不得 reject `start()`/`sendPrompt`**（`client.send` 默认 30s 超时，旧版 pi 回 `success:false` 会 reject；若 await 在启动关键路径上会把面板挂起至 30s）
- **清空与广播**：`restart()` 与 `handleExit`（崩溃路径）都必须清空 commands 并广播空列表（与 `uiCleared`/`todos` 同模式）——commands 是"进程能力描述"，进程死亡/重启后旧列表会误导用户接受不可执行的命令
- **失败静默**：旧版 pi 不支持 `get_commands` 会回 `success:false`（Unknown command）→ 保持空列表、只写 Output 日志、**不弹 notice**（避免每次启动噪音）；补全弹窗对空列表永不弹出
- **无需改动**：`client.ts`（无 id 响应按 command 字段兜底关联已覆盖本命令，pi 实际响应帧不带 id）与 `panel.ts`（OutMessage 透传）均不改

### 2.2 匹配逻辑（纯函数，webview 侧）

`webview-ui/src/command-match.ts`，规则（业界调研结论：ranked 匹配 exact > prefix > substring，见 §2.4；本列表规模小，不引 fzf 类库）：

- 查询 = 首词去掉开头 `/`；大小写不敏感；**空查询（仅输入 `/`）返回全部命令**
- 排序：name 前缀命中 > name 子串命中 > 描述命中（skill 命令对裸技能名也视为 name 命中，如查询 `ctx-search` 命中 `skill:ctx-search`——用户记不住前缀）
- 返回过滤后的有序列表；零匹配返回 `[]`（弹窗隐藏，不显示"无匹配"文案）

**宿主侧防御解析**：`get_commands` 响应字段存在文档漂移风险（与 todos 的未文档化字段同类），按 AGENTS.md 惯例拆独立纯函数模块 `src/chat/commands.ts`（`parseCommands(data: unknown): SlashCommand[]`，无 vscode 依赖，参照 `todos.ts` 先例）：非数组/字段缺失/类型不符逐项跳过；`name` 非空字符串才保留；`source` 归一为 string（不写死三值联合——pi 未来新增来源不得破坏运行时），UI 对未知来源显示兜底标签（"其他"）

### 2.3 Composer 弹窗交互

| 事件 | 行为 |
|---|---|
| 触发 | 弹窗可见条件（精确谓词）：`text.startsWith("/")` 且首词（首个空白字符——空格/制表/换行——之前）不含空白，即 `/fix args` 时弹窗已关闭；弹窗打开时实时过滤。注意：弹窗是**提示层**，与 pi 的执行层解耦——弹窗关闭不影响 pi 侧对 `/fix args` 的展开执行 |
| IME 组合输入 | `e.nativeEvent.isComposing === true` 时，弹窗所有快捷键（Enter/Tab/↑/↓/Esc）一律不拦截、不 preventDefault，走默认行为（与现有 Enter 防护 Composer.tsx:89 同款） |
| ↑ / ↓ | 移动高亮（弹窗打开时才拦截）；**列表变化（过滤/刷新）时高亮重置为第一项并夹取防越界** |
| Enter / Tab | 接受高亮候选：执行 `text.replace(/^\/\S*/, "/" + name + " ")`，光标置于插入串末尾（若原首词后有内容则置于其前，双空格情形可接受），保持焦点；**弹窗打开时 Enter 优先接受补全，不发送；接受后再次 Enter 才是发送**。Tab 仅在弹窗打开时 preventDefault，弹窗关闭时保持默认焦点移动 |
| Esc | 分层：弹窗打开 → 仅关闭弹窗；否则保持现有行为（busy 中断 / 空闲清空） |
| 鼠标 | 悬停高亮、点击接受；候选项 `onMouseDown={e => e.preventDefault()}` 防 textarea 失焦，接受后主动 refocus |
| 无匹配 / 命令列表为空 | 弹窗隐藏 |
| busy（流式中） | 不禁用补全，Enter 两步化：第一次接受补全（不发送）、再按才发送（steer 排队）；Esc 先关弹窗再中断（pi 对扩展命令立即执行，steer 展开语义由 pi 侧处理——F5 验收重点确认，若 pi 对 steer 不展开则回退为 busy 态禁用补全） |

弹窗定位在 composer 上方（绝对定位），`max-height` + 滚动，名称 ellipsis；样式全部用 VS Code CSS 变量（`--vscode-list-hoverBackground`、`--vscode-focusBorder` 等）适配主题；来源徽标中文标签（扩展 / 提示模板 / 技能）。

### 2.4 关键取舍（sequentialthinking 收敛结论 + 调研来源）

| 决策 | 选择 | 理由 |
|---|---|---|
| 数据源 | RPC `get_commands` 动态获取 | 用户确认；静态列表会缺失用户自装技能/模板，且无法保证可执行 |
| 触发范围 | 仅 `text.startsWith("/")` | pi 的 `prompt()` 仅对开头 `/` 做扩展命令/技能/模板展开（源码实测）；与 Claude Code 插件实际行为一致（官方声称支持中段补全但用户报告弹层不出现，issues #44488/#55173） |
| UI 形态 | 下拉列表（非 ghost） | 用户确认；描述+来源信息量大，支持鼠标（侧边栏面板场景）；业界主流（Cloudscape shortcut-menu 模式：实时过滤/Esc 关/↑↓ 选/Enter 确认） |
| 匹配算法 | 前缀优先 + 子串兜底 + 描述命中 | 命令列表规模小（几十条），自实现纯函数零依赖；ranked 匹配是业界共识（codex #9741、qwen-code #3104），但 fzf 级模糊匹配收益低 |
| 匹配函数位置 | webview 纯函数模块 | 每次按键必须本地过滤（不能往返宿主）；宿主与 webview 零代码共享约束下，webview 无 mocha 基建 → 数据链路由宿主集成测试覆盖、匹配逻辑靠评审 + F5 验收 |
| 响应防御解析 | 宿主侧独立纯函数 `commands.ts` + mocha 单测 | 与 todos.ts/todos.test.ts 先例一致（未文档化字段防御解析），符合 AGENTS.md "纯函数优先拆独立模块便于单测" |
| webview 侧防御 | snapshot 的 `commands` 字段用 `msg.commands ?? []` | 与现有 todos 处理同款（App.tsx:36-38 模式），旧 snapshot/竞态下不崩 |
| get_commands 失败 | 静默空列表 | 旧版 pi 兼容；不打断聊天主流程 |
| 弹窗打开时 Enter | 接受补全而非发送 | 业界键盘优先模式一致（Kimi Code、Cloudscape） |
| 列表渲染位置 | snapshot + 独立 commands 消息 | 复用视图重显重放机制（与 todos 同模式） |

**调研来源**：Claude Code 插件补全行为（github.com/anthropics/claude-code issues #44488/#55173/#42147）；Cloudscape shortcut-menus 模式（cloudscape.design/gen-ai/patterns/shortcut-menus）；Kimi Code 交互文档（kimi.com/code/docs）；ranked 匹配（github.com/openai/codex#9741、github.com/QwenLM/qwen-code#3104）。

**未触发 context7**：本功能不引入任何新库（仅 React 现有依赖 + 自实现纯函数），resolve-library-id/query-docs 环节不适用。

## 3. 任务拆解（与 todo 列表镜像）

| id | 任务 | blockedBy |
|---|---|---|
| 1 | 协议类型扩展 get_commands | — |
| 2 | webview 类型镜像 | — |
| 3 | 宿主命令链路（含 commands.ts 防御解析 + 清空广播） | 1 |
| 4 | webview 过滤与弹窗交互（含 IME/精确触发/插入规则/高亮 clamp） | 2 |
| 5 | 弹窗样式 | 4 |
| 6 | 测试：commands 单测 + 假 pi 场景 + 集成断言 | 3, 4 |
| 7 | 验证与文档同步 | 1–6 |

执行顺序：T1/T2 并行 → T3/T4 并行 → T5/T6 并行 → T7。

## 4. 涉及的文件

```
src/rpc/protocol.ts                # + GetCommandsCommand/GetCommandsData/SlashCommand（T1）
webview-ui/src/types.ts            # + SlashCommand 镜像、snapshot.commands、commands 消息（T2）
src/chat/controller.ts             # + commands 状态/fire-and-forget 拉取/刷新/清空广播/snapshot/getCommands()（T3）
src/chat/commands.ts               # 新文件：parseCommands 防御解析纯函数（T3）
src/test/commands.test.ts          # 新文件：防御解析单测（T6）
webview-ui/src/command-match.ts    # 新文件：匹配纯函数（T4）
webview-ui/src/components/Composer.tsx  # 弹窗状态机与键盘/鼠标交互（T4）
webview-ui/src/App.tsx             # commands 接收与传递（T4）
webview-ui/src/styles.css          # 弹窗样式（T5）
src/test/fixtures/fake-pi.js       # + get_commands case（T6）
src/test/extension.test.ts         # + 送达/刷新/重启集成断言（T6）
AGENTS.md / README.md / CHANGELOG.md   # 文档同步（T7）
```

## 5. 验证方式与风险

**验证**：

- `npm run compile`（类型 + lint + 双 bundle）与 `npm test` 全绿（现有 38 个 + 新增单测与集成断言）
- 单测 `commands.test.ts`：parseCommands 全量合法 / 部分损坏跳过 / 结构不符返回空列表 / source 未知值兜底
- 集成测试（经 `PinelTestApi.getCommands()`）：启动后命令送达；**settle 刷新可观察**（fake-pi 新增 `CMDADD` 场景：prompt 含标记 → 假 pi 追加一条命令 → settle 后 `waitFor` 轮询断言新命令出现）；**restart 后恢复用 `waitFor` 轮询**（重启类不用 waitForSettled，清空广播与重拉之间为空列表，不得立即断言）；**旧版 pi 失败静默**（新增环境变量场景 `PINEL_FAKE_PI_SCENARIO=NOCOMMANDS`：get_commands 回 success:false——首次 get_commands 发生在任何 prompt 之前，按 AGENTS.md 约定经 env 在 spawn 时激活——断言空列表 + 无 notice + start 不 reject）
- F5 人工验收：`/` 触发弹窗、输入过滤（前缀/子串/描述/skill 裸名）、↑↓/Enter/Tab/Esc 分层、鼠标点击不失焦、插入 `/命令 `、无匹配隐藏、busy 态两步化 Enter、亮/暗主题样式、**中文输入法组合输入**、弹窗顶部空间不足时的定位
- 真实 pi 冒烟：与用户环境真实技能/模板/扩展命令列表比对；重点确认 busy 态 `/` 命令经 steer 的展开行为

**风险**：

| 风险 | 缓解 |
|---|---|
| 旧版 pi 无 `get_commands`（Unknown command） | 失败静默 + Output 日志，弹窗永不弹出 |
| rpc.md 文档与实际返回字段漂移（path/location vs sourceInfo） | 类型以实现为准 + 防御解析；协议注释标注漂移 |
| settle 刷新与 restart 竞态 | 复用现有 client 身份校验模式，迟到结果丢弃 |
| webview 匹配逻辑无法入宿主 mocha 基建 | 数据链路集成测试 + 纯函数评审 + F5 验收；逻辑保持极简 |
| 弹窗遮挡消息区/侧边栏窄面板溢出 | 绝对定位在 composer 上方 + max-height 滚动 + ellipsis |
| Esc 与现有中断/清空行为冲突 | 明确分层：弹窗开 → 只关弹窗 |

## 6. 需要用户确认的决策点

已确认（2026-08-14）：

1. ✅ 触发位置：仅消息开头
2. ✅ 数据源：pi 动态列表（get_commands）
3. ✅ UI 形态：下拉候选列表
4. ✅ 插入行为：`/命令 ` + 留输入

## 7. 执行记录（实现后回溯更新）

- **测试**：46/46 通过（新增 parseCommands 单测 4 + 集成 4：启动送达 / CMDADD settle 刷新 / 重启恢复不残留 / NOCOMMANDS 旧版失败静默）
- **实现后评审修复**：① 弹窗门禁由 `query.length > 0` 改为 `isCommandQuery(text)`——裸 `/`（空查询）必须弹出全部命令（计划 §2.2/§5 验收清单行为）；② 候选 key 改 `${name}-${i}` 防同名命令 React key 冲突
- **评审确认的测试基建限制**：NOCOMMANDS 场景「无 notice」未自动化断言（PinelTestApi 不暴露 notice 通道），由实现保证（catch 内仅写 Output）+ 评审确认可接受
- **待用户 F5 人工验收**（交互行为无法集成测试覆盖）：`/` 触发、过滤（前缀/子串/描述/skill 裸名）、↑↓/Enter/Tab/Esc 分层、鼠标点击不失焦、busy 两步化 Enter、中文输入法组合输入、弹窗定位、亮/暗主题；真实 pi 冒烟确认 busy 态 `/` 命令经 steer 的展开行为（若 pi 不展开则回退为 busy 态禁用补全）
