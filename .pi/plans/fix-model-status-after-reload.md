# 计划：修复换文件夹重载后状态栏显示"未选择模型 medium ·就绪"

> 状态：✅ 已执行完成（2026-08-14，全量测试 38/38 通过）
> 日期：2026-08-14
> 目标仓库：`C:/source_code/Other/pinel`

## 1. 背景与目标

**用户报告**：在 VS Code 中尝试打开已打开的当前文件夹（无反应，属 VS Code 原生行为，已确认为背景描述），随后打开另一个文件夹（触发窗口重载），扩展面板状态栏显示"**未选择模型 medium ·就绪**"。

**现状分析（已通过代码阅读与实测确认）**：

1. 该显示 = `processState: "running"` + `model: null` + `thinkingLevel: "medium"`（默认值）。`StatusBar.tsx` 在 running 态只显示"● 就绪"，**不提供重启按钮**（重启按钮仅在 error/no-workspace 态出现）——用户无法从面板手动修复（用户实测确认"没有显示重启按钮"）。
2. `ChatController.start()` 只在启动时执行**一次** `get_state`，此后永不刷新模型状态。三种情形都会落入上述显示且永久保持：
   - `get_state` 超时/失败（默认 30s 超时；窗口重载后 pi 冷启动 + 认证/可用性刷新可能更慢）→ 保留默认值 `model: null` + `"medium"`；
   - `get_state` 成功但 `model: null` → pi 的会话模型在进程创建时一次性解析（`findInitialModel`），RPC 模式下若当时认证/模型快照未就绪，`session.model` 在整个进程生命周期内**不会自动恢复**。
3. 窗口重载链路：deactivate → `taskkill /T /F` **硬杀**旧 pi（`void controller.dispose()`，VS Code 不等待）→ 新扩展宿主立即 spawn 新 pi。pi 的 RPC 模式支持**优雅退出**（stdin EOF → flush 会话、释放锁、退出），但 Pinel 从未使用。
4. 本机实测（pi 0.84.1）：硬杀后立即重启 pi 可正常解析模型（约 2.3s），说明该问题依赖特定时机（启动慢/瞬时认证故障），非必现——因此修复应**防御性**覆盖全部三类情形。

> 注：第 2 条中 pi 内部行为（`findInitialModel` 一次性解析、stdin EOF 优雅退出）来自对 pi 0.84.1 dist 源码的核对与实测；pi 版本变更时行为可能变化，硬杀兜底保证扩展侧契约不破。

**目标**：换文件夹重载（或任何启动竞态）后，面板自动恢复正确的模型显示；无法恢复时给出准确的警告态与可操作提示，不再显示矛盾的"未选择模型 + 就绪"。

## 2. 方案设计

### 2.1 模型状态自愈（ChatController，核心）

启动时 `get_state` 改为**有界重试 + 自动重启一次**的自愈流程：

```
start() → spawn 完成
  → processState 保持 "starting"（首次 get_state 成功前不置 running，
     避免健康慢启动在同步窗口内闪现警告态）
  → syncInitialState():
     get_state（每次 30s 超时；语义：首次 + 最多 3 次重试 = 4 次尝试，
       间隔 2s/5s/10s；失败详情只进 Output channel，不在每次失败时 notice）
     成功且 model 非空 → 置 "running" + 广播状态 → 继续 get_messages
     4 次尝试后仍为空：
       - 若 modelHealRestarted 未置位 → notice("正在自动重启 pi 以恢复模型…")
         → 调用 restartInternal(fromSelfHeal=true)，标记置位，本次 start()
         **链式 return 该 promise**（ensureStarted 的重启完成前不 resolve，
         避免 sendPrompt 拿到"pi 进程不可用"的误导提示）
       - 若已置位 → 短路重试：置 "running"（model 仍 null）→ 进入 2.3 警告态
         + 诊断输出（各次 get_state 结果摘要进 Output channel）+ 一次 notice
         提示检查 pi 认证（命令行运行 pi 验证）
```

**控制流关键点（审查修订）**：

- **手动/自动重启入口区分（防无限循环）**：`restart()` 拆为公共手动入口与内部 `restartInternal(fromSelfHeal: boolean)`。公共 `restart()`（面板 "restart" 消息、`PinelTestApi.restart` 调用）**重置** `modelHealRestarted`；自愈路径调用 `restartInternal(true)` 前**置位**标记，`restartInternal` 本身不重置。`restartInternal` 顶部增加 `disposed` 守卫。
- **disposed / client 身份检查**：syncInitialState 的**每次迭代前**与**触发自愈重启前**均检查 `this.disposed` 与 `this.client === client`，不满足即静默放弃（沿用现有"已被 restart 取代"模式，避免 dispose 后 fire 抛异常、二次自动重启）。
- **与进行中手动重启竞争**：若自愈触发时 `restarting` 守卫命中（用户恰在手动重启），自愈放弃重启、直接落到警告态，不静默悬空。
- **最坏时延（已在计划中定界）**：典型场景（get_state 快速返回 null）约 17s 重试 + 一次重启（~2.5s）≈ 20-30s；病态场景（每次 get_state 均 30s 超时，即 pi 本身无响应）首进程 ≤ ~137s，重启后因标记短路仅 1 次尝试 ≤ 30s，总计 ≤ ~3 分钟后进入警告态。
- **测试钩子**：暴露自愈信息（如 `getModelHealInfo()`：重试次数、是否自动重启过），供集成测试断言。

### 2.2 优雅退出优先的停止流程（RpcClient.stop + deactivate）

pi RPC 模式在 **stdin EOF** 时优雅退出（实测其 `rpc-mode.js`：`process.stdin.on("end")` → `shutdown()` → `runtimeHost.dispose()` 释放锁/flush 状态）。把 `stop()` 改为两级、**总时长契约保持 5s 不变**：

1. **优雅期（≤2.5s）**：`child.stdin.end()`（`child.stdin` 挂 `on("error", () => {})` 静默兜底，防异步 EPIPE 抛异常）→ 等待真实 exit；
2. **兜底硬杀（剩余 ~2.5s）**：超时未退 → 现有逻辑（Windows `taskkill /pid /T /F`；POSIX 进程组 SIGTERM → 2s 后 SIGKILL），继续等待真实 exit 至 5s 总截止。

保持既有契约："永不 reject、exit 事件先于 resolve 派发、总 5s 兜底"（`stop.test.ts` 依赖，见 §5）。`client.ts` 中"5s 总兜底"注释同步更新。

- `restart()` 复用 `stop()`，自动受益。
- `extension.ts`：subscription dispose 回调从 `{ dispose: () => void controller.dispose() }` 改为返回 Promise（`{ dispose: () => controller.dispose() }`），让 VS Code 在窗口重载/deactivate 时**等待**优雅退出完成。**执行期验证项**：实测 VS Code 是否 await Thenable dispose 回调；若不等待，改为 `deactivate()` 中显式 `await controller.dispose()`（dispose 幂等，双调用安全）。
- **收益与边界（如实记录）**：宿主进程死亡时 OS 会关闭管道，pi 的 stdin 仍会收到 EOF 自行优雅退出，但新 pi 的 spawn 与旧 pi 的 flush 时序不受扩展控制。因此优雅退出对窗口重载场景是**降概率**的根因预防，不承诺完全消除竞态；扩展侧兜底由 2.1 自愈保证。验证项补充：F5 实测重载时 extension host 存活时长是否 ≥ 优雅期。

### 2.3 状态显示修正（StatusBar.tsx）

- `processState === "running"` 且 `status.model` 为空 → 状态改为**警告态**：`⚠ 无可用模型`（title 提示检查认证/查看 Output 面板输出）+ **重启按钮**（复用 `status-restart` 样式与现有 `"restart"` 消息）。不再显示"● 就绪"。
- 模型标签在警告态下显示"无可用模型"；警告态下**隐藏 thinkingLevel 显示**（此时为默认值，无信息量）。
- 由于 2.1 中 `running` 在首次 get_state 成功前不置位，健康慢启动期间显示"启动中…"而非警告态，无闪现问题。
- webview 侧直接由 `status.model === null && status.processState === "running"` 推导，**不新增协议字段**（`webview-ui/src/types.ts` 无需改动）。

**关键取舍**：

| 决策 | 选择 | 理由 |
|---|---|---|
| 模型为空时的处理 | 重试 + 自动重启一次（用户已确认"自动自愈"） | 覆盖全部三类根因；重启让 pi 重跑 findInitialModel，忠实于用户既有配置 |
| 是否自动补选模型（get_available_models + set_model） | 不做（用户已确认不选该项） | 自动选模型可能不符合用户偏好；属 v0.2 模型选择范畴，本次不提前实现 |
| 优雅退出 | 纳入（用户已确认），stdin EOF 优先（2.5s）+ 硬杀兜底，总 5s 契约不变 | 根因预防；硬超时兜底保证不死锁 |
| `running` 置位时机 | 首次 get_state 成功后 | 避免健康慢启动闪现警告态；沿用现有 processState 字段，不新增协议 |
| 超时参数 | 每次 get_state 仍 30s，靠重试覆盖慢启动 | 不改全局 send 超时语义，避免影响其他命令路径 |
| 打开已打开文件夹"没反应" | 不处理（用户已确认为背景） | VS Code 原生行为，不触发任何扩展事件 |
| settle 后刷新模型状态 | 本次不做（列入后续可选） | 用户未要求，避免范围膨胀；与本次自愈逻辑独立 |

## 3. 任务拆解

1. **RpcClient.stop() 优雅退出改造**：stdin EOF 优雅期 2.5s（`stdin.on("error")` 静默兜底）→ 硬杀兜底至 5s 总截止；保持"等待真实退出、永不 reject、exit 先于 resolve"契约与 POSIX 进程组逻辑；更新 `client.ts` 注释。
2. **fixtures 更新（stop 测试配套）**：`long-running.js` 增加「stdin EOF → 退出」行为，环境变量 `PINEL_LONG_NO_EOF=1` 时保持常驻（供兜底硬杀路径测试）；`fake-pi.js` 同样增加 stdin EOF → 退出（保证既有集成测试中 4 处 restart 不因优雅期各多等 2.5s）。
3. **stop.test.ts 扩展**：新增「EOF 后自行退出 → stop resolve 前 exit 已派发、进程已死」与「`PINEL_LONG_NO_EOF=1` 拒不退出 → 兜底硬杀后 exit 已派发」两条路径；现有测试保持。
4. **extension.ts dispose Promise 化**：subscription dispose 返回 Promise；F5 实测 VS Code 是否等待 Thenable dispose（不等待则改为 deactivate 显式 await，二者取一）。
5. **ChatController 启动状态同步重试**：`running` 置位移至首次 get_state 成功后；抽出 `syncInitialState()`（4 次尝试、间隔 2s/5s/10s、失败详情仅进 Output channel）；迭代间 disposed/client 身份检查。
6. **ChatController 自动重启自愈**：`restartInternal(fromSelfHeal)` + `modelHealRestarted` 标记（手动 restart 重置；自愈置位后短路重试）+ 链式 return + `restarting` 竞争处理 + disposed 守卫 + 测试钩子 + 最终 notice/诊断输出。
7. **fake-pi NULLMODEL 场景**：激活机制用**环境变量** `PINEL_FAKE_PI_SCENARIO`（进程启动时读取，作用于 get_state——首次 get_state 发生在任何 prompt 之前，子串标记机制不可用）：`NULLMODEL-FIRST`（前 2 次 get_state 返回 model:null，之后正常 → 验证重试即恢复、无重启）、`NULLMODEL-FOREVER`（恒 null → 验证自动重启恰好一次 + 警告态）。场景名避免与既有子串（ABORTME/UIREQUEST/CRASHME 等）互相包含。
8. **集成测试（extension.test.ts）**：NULLMODEL 测试需**独立进程**——测试内先 `process.env.PINEL_FAKE_PI_SCENARIO = ...`，再 `api.restart()` 触发新 spawn，用 `waitFor` 轮询断言（**勿用 waitForSettled**，见 AGENTS.md 踩坑），结束后恢复 env 与再次 restart；断言：NULLMODEL-FIRST 最终 model 非空且自愈钩子显示未重启；NULLMODEL-FOREVER 自动重启恰好一次（假 pi 日志计数）后 model 仍 null、processState 为 running（警告态前提）。suiteSetup 的"waitFor running + model"断言在 `running` 置位时机调整后依然成立。
9. **StatusBar 警告态**：running + 模型为空 → "⚠ 无可用模型" + 重启按钮 + 模型标签"无可用模型" + 隐藏 thinkingLevel。
10. **验证与文档**：`npm run compile`（含 webview bundle 重建，勿漏 `node webview-ui/esbuild.js`）+ `npm test` 全绿（34 旧测试 + 新增）；README/CHANGELOG 同步；AGENTS.md 增补（见下）。

## 4. 涉及的文件

| 文件 | 改动 |
|---|---|
| `src/chat/controller.ts` | `running` 置位时机、`syncInitialState` 重试、`restartInternal`/自愈标记、disposed 守卫、诊断输出、测试钩子 |
| `src/rpc/client.ts` | `stop()` 优雅退出（stdin EOF 优先、硬杀兜底、5s 总契约） |
| `src/extension.ts` | dispose 回调 Promise 化（或 deactivate 显式 await） |
| `webview-ui/src/components/StatusBar.tsx` | running + 模型为空警告态 + 重启按钮 + 隐藏 thinkingLevel |
| `src/test/fixtures/long-running.js` | stdin EOF → 退出 + `PINEL_LONG_NO_EOF` 开关 |
| `src/test/fixtures/fake-pi.js` | stdin EOF → 退出 + `PINEL_FAKE_PI_SCENARIO` NULLMODEL 场景 |
| `src/test/stop.test.ts` | 优雅退出与兜底硬杀测试 |
| `src/test/extension.test.ts` | NULLMODEL 自愈路径集成测试 |
| `README.md` / `CHANGELOG.md` / `AGENTS.md` | 文档同步 |

不改动：`src/rpc/protocol.ts`、`webview-ui/src/types.ts`（无协议变更，webview 侧由现有字段推导）。

**AGENTS.md 增补条款（执行时落实）**：
- 进程终止规则由"taskkill /T /F"更新为"stdin EOF 优雅期 2.5s → 硬杀兜底，总 5s 契约"（含 `stop.test.ts` 两条新路径）。
- 自愈规则：get_state 4 次尝试（间隔 2s/5s/10s）、自动重启一次（`modelHealRestarted` 手动入口重置）、警告态由 webview 推导不新增协议字段、`running` 在首次 get_state 成功后才置位。
- 测试注意：NULLMODEL 场景经 `PINEL_FAKE_PI_SCENARIO` 环境变量在 spawn 时激活（prompt 子串机制不可用于首次 get_state）；重启类测试仍禁用 waitForSettled；fake-pi/long-running 的 EOF 退出保证重启流程不付优雅期等待。

## 5. 验证方式与风险

**自动化**：
- 新增单测：stop 优雅退出两条路径（EOF 自退 / 拒不退出兜底硬杀，断言 exit 先于 resolve 派发）；
- 新增集成测试：NULLMODEL-FIRST（重试即恢复、无自动重启）、NULLMODEL-FOREVER（自动重启恰好一次 → 警告态前提成立）；
- 34 个既有测试全部保持通过（尤其 `stop.test.ts`、`extension.test.ts` 重启竞态回归——fake-pi 加 EOF 退出后重启时序不受优雅期影响）。

**人工验证**：
- F5 调试：正常打开面板模型正常显示、启动期间显示"启动中…"；用 `NULLMODEL-*` 场景观察自愈流程与警告态（重启按钮出现且生效）；
- 真实场景：打开其他文件夹触发窗口重载，确认模型自动恢复或显示警告态 + 重启按钮生效；观察 Output 面板诊断输出；
- 关闭/重载 VS Code：观察退出不再硬杀（Output 无残留、退出时长 ≤5s）；记录重载时 extension host 存活时长是否 ≥ 优雅期（如实评估优雅退出对 reload 场景的实际收益）。

**风险与对策**：
| 风险 | 对策 |
|---|---|
| 自愈无限重启循环 | `modelHealRestarted` 置位短路 + 手动/自动入口区分（§2.1 控制流要点） |
| dispose/手动 restart 竞态下的迟到自愈 | 每次迭代与重启前 disposed + client 身份检查；`restartInternal` disposed 守卫 |
| 优雅退出拖慢窗口关闭 | 总 5s 契约不变（优雅 2.5s + 硬杀兜底 2.5s）；最坏时长有界 |
| 自动重启打断用户操作 | 仅模型为空时触发（此时无法对话），无实际打断；最多一次 |
| VS Code 不等待 Thenable dispose | 执行期实测，fallback 为 deactivate 显式 await（dispose 幂等） |
| pi 未来版本改变 stdin EOF / 模型解析行为 | 硬杀兜底保证任何情况下不死锁；自愈不依赖 pi 内部具体实现，仅依赖 get_state 结果 |
| 自愈期间用户发 prompt 被 pi 拒绝（无模型） | 已有统一错误提示；且 ensureStarted 链式等待自愈完成（§2.1），窗口极小 |
| 病态慢启动下自愈最长 ~3 分钟 | 仅当 get_state 反复 30s 超时（pi 无响应）才发生；期间显示"启动中…"，结束后必落警告态 + 重启按钮 |

## 6. 需要用户确认的决策点

- ✅ **自动自愈**：已确认（重试 get_state + 自动重启一次）。
- ✅ **优雅退出**：已确认（stdin EOF 优先 + 硬杀兜底）。
- ✅ **"打开已打开文件夹没反应"**：已确认为背景描述，不处理。
- ✅ **不提前实现模型自动补选**（get_available_models + set_model）：已确认。
- ✅ **subagent 完整性审查**：已完成（2 项阻断级控制流缺陷、4 项高危、若干中低危问题均已修订进本计划）。
- ✅ **本计划整体**：已确认并执行。

## 7. 执行记录（2026-08-14）

- 全部任务按计划完成；`npm run compile` + `npm test` 全绿（**38/38**：34 旧测试 + stop 优雅退出/兜底硬杀 ×2 + 自愈集成 ×2）。
- **与计划的偏差**：
  1. 自愈重启循环实现于 `startWithHeal()` 内**顺序执行**，未走 `restartInternal(fromSelfHeal)` 参数化方案——首次集成测试实测发现：自愈嵌套在手动重启链内时会被 `restarting` 防重入守卫拦截（FOREVER 场景静默停在 stopped 态）。顺序循环方案等价且更简洁（`restart()` 保持无参）。
  2. dispose Promise 化采用双保险：subscription dispose 回调返回 Thenable + `deactivate()` 显式 `await controller.dispose()`（dispose 幂等），不再依赖「VS Code 是否 await Thenable dispose」的实测结论。
  3. stop 优雅期后的硬杀等待按 5s 总截止预算（优雅 ≤2.5s + 硬杀等待剩余），契约描述与实现一致。
- **真实 pi 冒烟验证**（pi 0.84.1）：stdin EOF 后 41ms 内 code=0 优雅退出，优雅期 2.5s 充裕；硬杀后立即重启可正常解析模型（约 2.3s）。
- **遗留人工验证项**（自动化无法覆盖，建议用户在下次换文件夹重载时顺带观察）：换文件夹重载后模型自动恢复或显示警告态 + 重启按钮生效；关闭/重载 VS Code 时退出时长 ≤5s。
