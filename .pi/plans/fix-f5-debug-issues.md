# 修复 F5 调试问题：DEP0169 警告与「pi 进程异常 / 重启无效」

> 状态：✅ 已执行完成（2026-08-13）
> 日期：2026-08-13

## 1. 背景与目标

用户 F5 调试扩展时报告两个现象：

1. **Debug Console 输出 DEP0169 警告**：`url.parse()` 弃用警告（Node 22.13+/24 运行时警告）。
2. **面板状态栏显示「未选择模型 medium ✕ pi 进程异常」，点击「重启」无任何变化**。

目标：定位两个问题的根因并修复本仓库可控的部分；无法在本仓库修复的部分（第三方来源的警告）诊断确认后记录归档。

## 2. 根因分析

### 2.1 问题 2 主因：launch.json 未向开发宿主传入工作区（已由用户现场信息确认）

**证据链**：

- 用户确认：错误 tooltip 文本为 **「请先打开一个文件夹」**。该文本在 `src/chat/controller.ts` 的 `start()` 中仅有一处：
  ```ts
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    this.status = { ...this.status, processState: "error", error: "请先打开一个文件夹" };
    ...
    return;
  }
  ```
  即 F5 的开发宿主窗口中 `workspaceFolders` 为空，pi 从未被 spawn。
- 本仓库 `.vscode/launch.json` 的 args 仅有 `--extensionDevelopmentPath=${workspaceFolder}`，**没有传入要打开的文件夹**。VS Code 的 extensionHost 启动方式下，若不显式传入文件夹路径，开发宿主打开的是空工作区（官方示例与社区实践均要求把文件夹路径作为 args 参数传入）。
- 由此解释全部症状：首次打开面板即 error（model 未同步 → 「未选择模型」，thinkingLevel 保持初始值 → 「medium」）；每次点击重启都重新走同一条 `start()` 失败分支 → 「无任何变化」。
- 旁证：DEP0169 警告出现在开发宿主进程（pi 从未启动，见 2.3），与此一致。

**修复**：launch.json args 增加 `${workspaceFolder}`（官方推荐写法，跨版本兼容）：
```json
"args": [
  "--extensionDevelopmentPath=${workspaceFolder}",
  "${workspaceFolder}"
]
```

### 2.2 问题 2 次因（独立 bug）：restart 竞态——旧进程退出事件污染新状态

**代码路径**：

1. `ChatController.restart()`：`old.stop()` → 立即 `ensureStarted()` → 新 `RpcClient` spawn 新 pi → `setProcessState("running")`。
2. `RpcClient.stop()` 内 `taskkill /T /F` 同步返回，但子进程 `exit` 事件**异步迟到**（已实测：taskkill 返回后 `exit` 事件才派发）。
3. 旧 client 的 `exit` 事件触发 `controller.handleExit()`，**无条件**把 `this.status` 置为 `error`（"pi 进程已退出"），覆盖新进程的 running 状态 → 界面停在「pi 进程异常」，用户感知"重启无变化"。
4. 根因：controller 注册的事件处理器没有 client 身份检查；`stop()` 不等待进程真正退出。

**实验证据**（本机实测）：spawn 长命进程 → `taskkill` 返回后，`exit` 事件在下一事件循环才派发，恰好落在 `restart()` 进入新进程启动阶段之后。

**修复**（双保险）：
- `RpcClient.stop()` 改为等待进程真正退出（`exit`/`error` 事件或已退出即返回），带超时兜底防挂起。
- controller 的事件处理器绑定 client 身份（`if (this.client !== client) return;`），旧 client 的迟到 `exit`/`spawnError` 事件一律忽略。

### 2.3 问题 1（DEP0169）来源分析：大概率 VS Code 内部或第三方扩展

**已排除**：

- 本仓库 `src/` 与 `webview-ui/` 源码无任何 `url.parse` 调用（rg 全文检索）；宿主 bundle 仅由 `src/` 打包而成且 `vscode` 为 external，故 bundle 中不可能凭空引入 `url.parse`（逻辑推导；`dist/` 为 gitignored 产物，不作为直接证据）。
- 全局 pi 包（0.84.1）本体及其依赖树（dist 产物与 node_modules）无 `url.parse` 调用；实测 `node --trace-deprecation` 运行 pi rpc 入口无警告。
- pi 子进程 stderr 被 `RpcClient` 完全接管（stdio pipe → OutputChannel「Pinel」），不可能出现在 Debug Console。

**指向**：警告前缀 `(node:13156)` 为扩展宿主进程（Electron 内置 Node ≥22.13 会发 DEP0169）。已知 VS Code 内部存在 `url.parse` 调用点（microsoft/vscode#301941 等）；且本仓库 launch.json 未加 `--disable-extensions`，开发宿主会加载全部已启用扩展，第三方扩展的 node 端也可能是来源。

**处置（用户已确认「诊断确认来源+记录」）**：执行阶段用 `NODE_OPTIONS=--trace-deprecation` 临时注入 launch.json 复现，从调用栈确认归属；若属 VS Code 内部/第三方扩展，仅文档记录，不修改 F5 配置（`--disable-extensions` 会影响 F5 时其他扩展可用性，用户未选择该方案）。

## 3. 方案设计

| 变更点 | 文件 | 内容 |
|---|---|---|
| 1. F5 工作区参数 | `.vscode/launch.json` | args 追加 `${workspaceFolder}`（问题 2 根因） |
| 2. stop() 等待退出 | `src/rpc/client.ts` | `stop()` 等待 child 真实退出（`once("exit")`/`once("error")`/已退出短路，5s 超时兜底 resolve） |
| 3. 事件身份过滤 | `src/chat/controller.ts` | `record`/`exit`/`spawnError`/`stderr` 处理器闭包检查 `this.client === client`；旧 client 事件忽略。`record` 过滤的另一必要性：旧 client 迟到的 `extension_ui_request` 若不拦截，会被 `this.client?.writeRaw` 把 `extension_ui_response` 写进**新**进程 stdin（跨 client 污染） |
| 4. restart 即时反馈与防重入 | `src/chat/controller.ts` | `restart()` 重置 status 后立即 `fire({type:"status"})`；防重入守卫：restart 进行中忽略重复点击，且 restart 需处理与进行中 `start()` 的并发（等待或放弃旧 start，避免其迟到的 `setProcessState`/`get_state` 写入覆盖新状态） |
| 4b. 无工作区友好状态 | `src/chat/controller.ts`、`webview-ui/src/components/StatusBar.tsx`、`webview-ui/src/types.ts`、`webview-ui/src/styles.css` | 见「新增需求：未打开文件夹的友好提示」节 |
| 5. 测试钩子 | `src/extension.ts` | `PinelTestApi` 增加 `restart(): Promise<void>` |
| 6. 假 pi 崩溃场景 | `src/test/fixtures/fake-pi.js` | prompt 含 `CRASHME` 时先正常 respond，再 `setTimeout(() => process.exit(1), 1500)` 延迟退出（制造 restart 竞态窗口） |
| 7. 集成测试 | `src/test/extension.test.ts` | 两条新测试（见 4.2） |
| 8. DEP0169 诊断 | 临时改 `.vscode/launch.json` | 注入 `env.NODE_OPTIONS=--trace-deprecation` 复现抓栈，确认后移除；结论记录进本计划与 AGENTS.md |
| 9. 文档同步 | `AGENTS.md` | 新增「F5 调试专项注意」：launch.json 必须显式传入工作区；DEP0169 归属结论 |

**关键取舍**：

- **身份过滤 vs removeAllListeners**：选身份过滤——重启窗口内旧 client 的迟到事件一律忽略（stderr 为 append-only 日志、丢弃无碍；重启前已实时转发的日志不受影响）。同时配 stop() 等待退出，双保险。
- **stop() 超时兜底与恒 resolve**：`taskkill` 失败或进程僵死时不永久挂起 restart，5 秒后强制继续（旧事件此后由身份过滤兜底屏蔽）；`spawnSync`/`process.kill` 异常路径用 try/catch 包裹，约定 `stop()` **永不 reject**（否则 `restart()` 卡死）。POSIX 侧 SIGKILL 2s 与 5s 兜底时序配合正常（2 < 5）。
- **不修改 resolveSpawnSpec / 协议层**：spawn 解析有回归测试且与本次问题无关。
- **不引入新依赖**；不动 webview。

## 3.5 新增需求（用户补充）：未打开文件夹时显示友好提示

当前行为：无工作区时 `start()` 直接置 `processState: "error"`，状态栏显示红色「✕ pi 进程异常」（tooltip 才是「请先打开一个文件夹」），且无任何引导。

目标行为：

1. `ProcessState` 增加 `"no-workspace"`；`start()` 无工作区分支改为 `processState: "no-workspace"` + 友好说明文本（如「当前窗口未打开文件夹。请打开一个文件夹后再使用 Pinel」），并同步发一条 info 级 notice 提示。
2. StatusBar 为 `no-workspace` 渲染温和样式（新增 `.status-warn` 样式，非红色错误态），文案如「⚠ 未打开文件夹」+「重试」按钮（复用既有 restart 消息，无新消息类型）。
3. 自动恢复：controller 监听 `vscode.workspace.onDidChangeWorkspaceFolders`，当状态为 `no-workspace` 且出现文件夹时重置 `startPromise` 并自动 `ensureStarted()` 连接；watcher 在 `dispose()` 中释放。
4. `webview-ui/src/types.ts` 同步镜像 `processState` 新成员（宿主消息协议变更必须同步）。
5. 真正的进程异常（`handleExit`/`handleSpawnError`）仍显示「✕ pi 进程异常」，仅「未打开文件夹」场景不再伪装成进程异常。

**测试**：集成测试尝试用 `vscode.workspace.updateWorkspaceFolders` 覆盖（移除文件夹 → 断言 `no-workspace` + 友好状态 → 恢复文件夹 → 断言自动恢复 running），放在 suite 末尾并在 finally 中恢复文件夹；若测试环境（空工作区）不稳定，则降级为手动验证（临时移除 launch.json 工作区参数复现），计划执行时按实际表现定夺。

## 4. 任务拆解

1. **改 launch.json**：args 追加 `"${workspaceFolder}"`。
2. **改 RpcClient.stop()**：等待退出 + 超时兜底（实现：已退出短路；否则 `once("exit")`/`once("error")` Promise + `Promise.race` 5s 兜底）。
3. **改 ChatController**：
   - 四个事件处理器加身份过滤（helper：`const isCurrent = (c) => this.client === c`）；
   - `restart()` 重置状态后立即广播 + 防重入守卫：restart 进行中忽略重复点击；restart 与进行中 `start()`（首次启动未完成时点击）的并发需等待/放弃旧 start（守卫语义在实现时确定，需覆盖该场景，见评审 F6）；
   - 无工作区友好状态：`ProcessState` 加 `no-workspace`、start() 分支改写、`onDidChangeWorkspaceFolders` 自动恢复、dispose 释放 watcher。
3b. **改 webview**：`StatusBar.tsx` 新增 `no-workspace` 渲染分支（友好文案 + 重试按钮）；`types.ts` 镜像 `processState` 新成员；`styles.css` 新增 `.status-warn` 温和样式。
4. **改 extension.ts**：`PinelTestApi` 暴露 `restart`。
5. **改 fake-pi.js**：`CRASHME` prompt 标记 → 先正常 respond，再 `setTimeout(() => process.exit(1), 1500)`（延迟退出以制造 restart 竞态窗口）。
6. **加集成测试**（均不使用 `waitForSettled`——重启后无新 prompt 时 settled 计数不前进会挂到超时；改用 `waitFor` 轮询断言）：
   - 「pi 崩溃后重启：旧进程 exit 事件不污染新状态」：fake-pi 的 CRASHME 场景设计为「先正常 respond prompt，再 `setTimeout(() => process.exit(1), 1500)`」；测试在 `sendPrompt` resolve 后**立即** `api.restart()`（不等待 error 状态）。未修复代码下，旧 client 的 exit 事件（macrotask）必然落于新进程 running（restart 微任务链）之后，status 被污染 → 测试确定性失败；修复后身份过滤屏蔽 → 确定性通过。断言：restart 后 `waitFor` running + model，再等 600ms 后仍断言 running。
   - 「重启后状态完整恢复」：restart → running、model 正常；快照断言明确为「snapshot 正常发出、消息列表反映**新进程** get_messages 结果（fake-pi 重启后为空列表）」——fake-pi 消息存进程内存、无 session 持久化，不得断言旧消息保留（真实 pi 的历史恢复不在本次测试范围）。
   - 「无工作区友好提示」：`updateWorkspaceFolders` 移除→断言 `no-workspace` 状态与友好文案→恢复→断言自动恢复 running（不稳定则降级手动验证）。
   - 新增测试放在 suite 末尾（现有 5 条集成测试均自含 prompt、顺序无关，末尾追加避免干扰）。
   - 另补 `RpcClient.stop()` 确定性单测（新文件或并入 spawn-spec 风格）：spawn 长命 node 子进程 → `stop()` → 断言 resolve 时子进程已死、resolve 之后不再收到 `exit` 事件。
7. **DEP0169 诊断**：临时给 launch.json 注入 `"env": {"NODE_OPTIONS": "--trace-deprecation"}`，F5 复现抓调用栈；必要时 `--disable-extensions` 对照；确认来源后移除临时配置（**恢复时保留步骤 1 追加的 `${workspaceFolder}` 参数**），把结论写进本计划与 AGENTS.md。
8. **验证**：`npm run compile` + `npm test` 全绿（新增测试外，既有 21 个必须保持通过）；F5 手动验证面板连上真实 pi（状态栏显示模型名、就绪）。
9. **文档同步**：AGENTS.md 增补 F5 注意条目；若 launch.json 变化影响用户行为（开发宿主打开工作区属修复），README 无需改动。

## 5. 涉及文件

- `.vscode/launch.json`（修改）
- `src/rpc/client.ts`（修改 stop()）
- `src/chat/controller.ts`（修改事件绑定 / restart）
- `src/extension.ts`（测试钩子）
- `webview-ui/src/components/StatusBar.tsx`（no-workspace 渲染）
- `webview-ui/src/types.ts`（processState 镜像）
- `webview-ui/src/styles.css`（.status-warn 样式）
- `src/test/extension.test.ts`（新增测试）
- `src/test/fixtures/fake-pi.js`（CRASHME 延迟退出场景）
- `src/test/stop.test.ts`（或并入 spawn-spec 风格，新增 `RpcClient.stop()` 单测）
- `AGENTS.md`（F5 专项注意）
- `.pi/plans/fix-f5-debug-issues.md`（本计划，记录诊断结论）

## 6. 验证方式与风险

**验证**：
- 自动化：`npm run compile`、`npm test`（既有 21 + 新增 3 条（2 集成 + 1 单测）全绿；no-workspace 集成测试若不稳则降级手动验证）。
- 手动：F5 后开发宿主应打开 pinel 仓库工作区；展开面板后状态栏显示模型名与「就绪」；CRASHME 场景仅存在于假 pi（不影响手动）。
- DEP0169：诊断确认来源后，文档记录；警告本身无害（DeprecationWarning，不影响功能），若属 VS Code 内部则随版本升级自然消失。

**风险与缓解**：
- `stop()` 等待退出引入等待：已加 5s 超时兜底，最坏情况回到现状（旧事件靠身份过滤屏蔽）。
- launch.json 修改影响所有开发者 F5：行为变化即「开发宿主打开工作区」，是期望行为；与 VS Code 版本兼容（args 位置参数为官方长期支持形式）。
- 集成测试修改全局配置（piPath）：沿用现有测试的 suiteSetup/Teardown 模式，新增测试不改配置，仅通过 CRASHME 触发崩溃，无配置污染。
- restart 防重入守卫：实现时注意不破坏 `waitForSettled` 相关现有测试（21 个保持通过）。

## 7. 决策点（已与用户确认）

1. 错误现场为「请先打开一个文件夹」→ 问题 2 主因 = launch.json 缺工作区参数；restart 竞态作为独立 bug 一并修复（用户问题「点击重启无任何变化」的另一半场景）。
2. DEP0169 处置 = 诊断确认来源 + 文档记录；不改 F5 扩展加载策略（不加 `--disable-extensions`）。
3. （用户补充）未打开文件夹时不显示「pi 进程异常」，改为友好提示 + 打开文件夹后自动连接（见 §3.5）；真正的进程异常仍保持错误态显示。

## 8. 执行记录（2026-08-13）

**已完成**：
1. launch.json args 追加 `${workspaceFolder}` ✓
2. `RpcClient.stop()` 等待真实退出（5s 兜底、永不 reject）✓
3. controller 事件身份过滤 + restart 即时广播 + 防重入 + 进行中 start() 身份检查 ✓
4. no-workspace 友好状态（宿主 + StatusBar 渲染 + types 镜像 + .status-warn 样式）+ `onDidChangeWorkspaceFolders` 自动连接 ✓
5. `PinelTestApi.restart` 钩子 + fake-pi CRASHME（先 respond 后延迟 exit(1)）✓
6. 测试：竞态回归 + 崩溃重启恢复（main 套件）、`stop()` 单测、空窗口友好状态（独立套件）✓
7. DEP0169 诊断完成（结论见下）✓
8. 文档同步：AGENTS.md（F5 专项注意、测试踩坑）、README、CHANGELOG ✓

**DEP0169 诊断结论**（证据链）：
- 警告在**空窗口测试实例**（无 pinel 面板交互、pi 从未启动）同样出现 → 与 pinel 扩展行为无关；
- 测试日志显示 `[AgentHost:stderr]` 前缀：来源之一是 **VS Code 1.133 内置 AgentHost 进程**（每次实例启动必发）；另一个裸 `(node:...)` 警告来自扩展宿主进程（VS Code 内部代码）；
- 本仓库源码/宿主 bundle/pi 包及依赖树均无 `url.parse`（rg 检索 + bundle 构成逻辑推导）；pi 子进程 stderr 被完全接管不可能进 Debug Console；
- 结论：**VS Code 自身问题，非本仓库可修，警告无害**（DeprecationWarning），随 VS Code 升级自然消失（上游已跟踪 microsoft/vscode#301941）。NODE_OPTIONS 与 `--trace-deprecation` 在 Electron 打包应用中无法生效，未能拿到栈（不影响结论）。

**实现偏差记录**：
- 计划 §4.6 的 no-workspace 集成测试（主套件内 updateWorkspaceFolders 移除/恢复）**不可行**：VS Code 空窗口不支持 `updateWorkspaceFolders` 恢复（实测 add 返回 false，不可逆，且会污染 user-data 导致后续运行 main 实例空窗口）。改为**独立空窗口测试实例**（.vscode-test.mjs 双套件，no-workspace 套件不传 workspaceFolder）+ `scripts/clean-test-userdata.mjs`（每次 npm test 前清理共享 user-data）。「打开文件夹后自动连接」的 watcher 行为在空窗口实例无法断言（openFolder 会重载窗口），列为手动验证项。
- @vscode/test-cli 踩坑：配置里 `launchArgs` 非空时 `workspaceFolder` 被忽略（main 实例空窗口启动）——诊断 flag 不能放 launchArgs。
- 新增 4 条测试（原计划 3 条：竞态回归、崩溃重启恢复、stop() 单测；追加：空窗口友好状态套件），总测试数 21 → 25，连续两次 npm test 全绿。
