# Change Log

All notable changes to the "pinel" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Changed

- 输入区三行左缘对齐（输入行文本/按钮行/会话信息条统一 21px 基准）；最近回合悬浮条与用户消息卡片样式一致（同背景/同字号/同 padding，去阴影），并改入滚动容器 sticky 钉顶——与消息卡片结构级同宽（滚动条出现自动让位）

- subagent 卡片思考等级直接显示裸值（去「thinking: 」前缀，如 `模型 · high`），全缺时保留 main level 占位

- subagent 卡片：继承主会话时直接显示主会话实际模型名与思考等级（替代 main model/main level 占位）；工具卡片（含 subagent）运行中自动展开实时输出、完成后自动收起（挂后台保持展开），手动点击在状态不变时优先

- 工具调用卡片标题直接显示工具本名（流式块 name → 实时事件 toolName → 结果消息 toolName 三层兕底，三源皆空才兑底 Tool call）；subagent 图标判定同步用兕底后工具名

- 最近回合悬浮条：点击滚回原消息后悬浮条消失（上滚离开该消息或滚到底部时重新出现；切换会话恢复常驻），焦点移交滚动容器保持键盘滚动可达

- 会话信息条 Tree / Compact 按钮移除：会话树导航改**双击 Esc**弹出（锚定顶部栏分支按钮；焦点在输入框或问卷活跃时不响应）；手动压缩改设置面板 **Compact now** 按钮；设置面板 Auto compaction 区块新增**压缩阈值百分比输入**（1–99，换算写全局 settings.json `compaction.reserveTokens`，默认值按 pi 原样 16384 回显，保存成功 notice 提示重启 pi 生效）

### Added

- 扩展管理弹层作用域切换：All/Global/Project 三态视图（切换即重拉列表，启停/卸载后刷新沿用当前视图）；project 视图展示继承的全局包（inherited 徽标 + dimmed，隐藏卸载按钮），开关操作写入项目覆盖条目（`.pi/settings.json` 对象空数组/字符串，upsert 无则新增，按包身份查重防同 repo 不同拼写重复）；all 视图包按身份去重（项目条目优先，对齐 pi dedupe）；全新 workspace 首次覆盖写入自动补建 .pi 目录；无 workspace 时 project 视图提示不可用

- Pinel Pi 插件（npm 包 `@hilariouhiss/pinel`，源码 `pinel-plugin/`）：面板实时推送会话统计快照与会话树（extension_ui setStatus/setWidget 帧，宿主白名单过滤 pinel.* + 防御解析 + 快照重放）、`/pinel-state`、`/pinel-tree` 会话树导航命令（RPC 扩展命令派发，控制消息不渲染不写会话条目）；未安装时扩展管理弹窗顶部一键 Install（settings.json 安装态检测 + 曾安装标记不复活策略）；插件仅在被 Pinel spawn 的 pi（PINEL_PLUGIN=1）内激活，TUI 下惰性

- 会话信息条 Tree / Compact 按钮：会话树选择器（当前分支链消息节点、当前叶高亮、close-on-select 导航）与手动压缩（pi 原生 compact 命令接入，protocol 补 CompactCommand；压缩中按钮禁用）

- markdown 表格渲染：react-markdown 接入 remark-gfm（GFM 表格/删除线/任务列表），表格以紧凑边框表展示（窄面板横向滚动）

### Changed

- 扩展管理弹窗：未安装 Pinel 插件时顶部显示安装区（一键 Install）
- 会话信息条：新增消息计数（💬 图标）与当前模型显示（pinel.state 实时推送）
- 宿主构建：check-plugin 独立类型检查（pinel-plugin 不在主 tsc program，lint 不覆盖该目录）

### Changed

- 问卷 UI 调整：头部去除 (n/m answered) 计数（保留 Questionnaire 标题与提交中提示），进度条改按题数分段（每题一段、已答段高亮、乱序作答按实际位置），题卡去除 [header] 前缀（标题仅在顶部 tab 标签显示、题目正文保留），提交后收起态去除计数

- 最近回合悬浮条简化为纯消息文本：去除 ✓ 已完成状态与流式状态（工具名/流式尾部/Thinking），仅显示最近用户消息，最多 3 行超出 ellipsis 截断，与 header 间距 1px→3px（点击滚回保留）

- @ 添加文件改为文本内联：选中文件后 `@路径` 引用直接插入输入文本（含空格路径自动引号包裹），不再显示输入框上方附件卡片；发送时从文本解析 @引用注入（手打/粘贴/Ctrl+G 回填的 @引用 同等生效，文件列表挂载预热）；修复 panel 层从未透传 fileRefs 导致 UI 链路 @ 引用未端到端生效的隐藏 bug

### Added

- 最近回合悬浮状态条：聊天面板顶部（header 下方）常驻一条紧凑状态条——最近一次输入单行截断 + Pi 处理状态（流式中 spinner + 流式文本尾部/工具名/Thinking…，空闲 ✓ 已完成）；点击滚回原用户消息位置（不被条遮挡）；上滚查看历史时始终可见当前回合上下文

- 消息卡片悬浮复制按钮：鼠标悬浮任意消息卡片（用户/Pi 回复/孤儿工具结果）右下角出现复制按钮，点击复制渲染后纯文本（所见即所得，不含 You/Pi 角色头行；折叠态工具卡片复制截断预览为已知限制）；按钮变 ✓ 1.5s 反馈；webview 内 navigator.clipboard（可选链兑底静默），流式中的消息无按钮，settle 后自动出现

- 输入框高度自适应修复：改按渲染行计高（scrollHeight，软换行计入），修复 Ctrl+G 回填/粘贴大文本后输入框不适应的问题；上限为面板高 60%，超出内部滚动，窗口尺寸变化后自动重算
- subagent 卡片：subagent 工具（pi-subagents 扩展）的调用渲染为专属卡片——标题行任务描述、模型/思考深度行（解析失败或继承主会话时显示 main model / main level）、统计行（运行中实时活动 + 轮次/token；完成后轮次/工具次数/token/耗时），完成/错误/后台态点击展开 Markdown 报告全文；数据全部来自既有工具事件（pi-subagents 未文档化的 details 格式，防御解析 + 字段级降级，解析失败时输出仍可达）
- 模型/思考 chip：输入框按钮行左端常显当前模型（友好名，tooltip 完整 provider/id）与思考深度，点击弹锚定下拉列表切换（打开即拉取、选中即切换，状态回读刷新由既有宿主链路负责）；流式中可切换；无模型时模型 chip 禁用、思考 chip 隐藏

### Changed

- 待办面板行内仅显示标题/摘要，完整描述改为悬停原生 tooltip 显示（折叠态摘要同样支持悬停）
- 设置面板视觉升级：新增 Settings 标题栏与关闭按钮，队列模式改分段控件（segmented control），自动压缩/会话信息开关改 CSS 滑动开关（语义 role=switch 不变），分组间距与标题层级重排
- 扩展管理弹窗改屏幕居中模态：从锚定 footer 按钮的窄浮层改为居中弹窗（420px），新增标题栏与关闭按钮，与设置面板视觉语言一致
- 问卷选项卡标题与描述分两行展示（不再同排拥挤），选项间距加大；顶部新增答题进度条（随作答实时填充）
- 工具调用结果内联：工具结果不再渲染为独立卡片，直接展示在原 assistant 消息的工具调用卡片上（状态 ✓/✕ + 输出预览，点击展开完整参数与输出）；subagent 专属卡片同样内联到工具调用原位（统计行 + Markdown 输出保留）；快照重放（重启/切会话）后输出仍可达（从 toolResult 消息重建）
- 工具卡片图标改用 lucide：普通工具 wrench、subagent bot、完成 check、错误 x（running 保留 spinner），主题自适应（stroke=currentColor）

- 按钮行视觉微调：设置/扩展按钮图标 16→18px、两按钮间距与按钮行 gap 一致（4px）、模型/思考 chip 字号减小 1px（按钮尺寸不变）

- 模型/思考切换入口收敛：设置面板（ConfigPopover）移除模型/思考内嵌展开区，按钮行 chip 为唯一切换入口；面板只留队列模式/自动压缩/会话信息开关

- 问卷多选选择框改用 lucide 图标（check-square/square，未选灰选中蓝，与全扩展 lucide 图标体系一致）

### Fixed

- 命令补全弹窗滑到底：方向键/悬停浏览后 Esc 或退格关闭弹窗，重新输入 `/` 时高亮仍停留在旧的大索引（高亮复位只挂 candidates 数组引用，而空输入 ↔ `/` 的 query 恒为 `""`、引用不变，复位被漏过）——弹窗带着陈旧高亮重开，下一次击键先以陈旧高亮滚到底再复位，首命令不被选中、顶部的高排名匹配项不可见（列表停在底部时只露出尾部低分项，观感为"不逐字匹配"，实测 `fi` 时 /fix 已排第 1）。修复：滚动同步 effect 只跟随高亮变化，高亮复位与 scrollTop=0 合并为同一 effect（依赖弹窗可见性，覆盖重开缺口，同 flush 原子生效）；@ 文件弹窗同构修复（`"" ↔ "@"` 重开同缺口）

- 问卷取消竞态：用户在问卷首帧到达前取消（或测试竞态窗口）时，缓冲为空无帧可回 cancelled，插件 walker 永久等待响应、agent 永不 settle——现置取消补偿标记，匹配帧到达即回 cancelled；修复集成测试偶发失败（问卷取消 waitForSettled 超时 + 级联污染下一测试的 qna-1 响应断言）
- fake-pi 加固：waitForUiResponse 加 10s 超时（按引用移除 waiter + 放弃当前 walker + 补发 settle），挂起不再永久阻塞/污染后续测试

- 问卷多选自动跳题：webview 用 questions 引用比较判断问卷重入，而 postMessage 每条广播都是结构化克隆的新对象（引用恒变）——每次答题广播都被误判重入并重置到首个未答题（多选勾选即跳下一题；单选乱序作答回跳；输入草稿每次广播被清空）。修复：`QuestionnaireView` 增加稳定 `id`（tool_execution_start 的 toolCallId），webview 重入判定与草稿清理均按 id 比较

- `/new` 新建会话：输入框发送 `/new` 直接新建会话（pi 的 slash 命令 RPC 模式不展开，pinel 本地拦截——精确匹配且无附件时改走 `new_session`，带参数/附件原样发送；流式中自动中断并新建；旧会话保留在历史列表可随时切回）

- 图标全面迁移 lucide：webview 全部 UI 图标改用 lucide（lucide-static 1.34.0，ISC）——发送/停止（send/square）、设置/扩展（settings/puzzle）、历史/新建/分支（history/plus/git-fork）、搜索（search）、行内编辑/删除（pencil/trash-2）、统计条（arrow-up/arrow-down/dollar-sign/database 缓存命中率）与待办三态（circle/circle-dot/circle-check-big）；统计条 git 分支符号由 Maple Mono NF 字型（U+F418）改为 lucide git-branch 内联 SVG；主题自适应简化为容器级 color 继承（lucide stroke=currentColor），删除全部 path 级 fill 覆盖规则；旧手绘图标从 media/ 移除（pi-glyph.svg/pi-icon.png 品牌图标保留）

- 待办状态图标 SVG 化：todo 列表任务状态改用图标（todo.svg 空圈/in-progressing.svg 半填充圆/done.svg 勾选圆，主题自适应：pending 前景色/in_progress 蓝/completed 绿；折叠态单行用 in-progressing 图标）

- Maple Mono NF 字体补齐 Bold + Italic 字重（panel.ts 注册 400 normal / 700 normal / 400 italic 三个 @font-face），加粗/斜体不再合成（faux）

- 全扩展统一字体：聊天面板与会话历史视图整体改用 Maple Mono NF（`media/fonts/MapleMono-NF-Regular.ttf`，SIL OFL 1.1），styles.css `:root` 定义 `--pinel-font-family`/`--pinel-mono-font-family` 变量（UI 文本与代码块均以 Maple Mono NF 领先，回退 VS Code 字体）

- 扩展管理：footer 卡片 ⚙ 设置按钮旁新增「扩展」按钮（extension.svg 图标）弹出扩展管理弹层——浏览已安装的 pi 智能体扩展（本地扩展 + settings.json packages 分组，含全局/项目徽标与 filtered 标记），每项提供启用/禁用开关（本地 = 文件重命名 .ts/.js↔.disabled、包 = settings.json 字符串↔对象空数组）与卸载按钮（本地 = 删除文件/目录、npm/git 包 = `pi remove`、本地路径包 = 删 settings 条目）；卸载前确认，任何修改后弹「Reload」确认（点击重启 pi 使变更生效）；不提供安装

- 待办面板对齐与折叠：面板左右边缘与聊天消息/输入框对齐（10px 水平缩进统一）；折叠后仅剩一行并显示进行中任务（● 任务名 · 状态，多个进行中任务显示第一个 +N，无进行中任务时回落显示任务计数），点击一行展开/收起

- footer 单卡片融合：会话信息条与输入框/按钮行融合为一张大卡片（边框/背景/圆角/聚焦高亮统一到外层容器，消除两卡片交汇处圆角不平整；信息条无分隔线显示在卡片内底部，开关关闭时无残留）；按钮行紧凑化：设置/发送/停止按钮边长 ≈27px（随字号自适应）、图标 16→12px、行距收紧，footer 总高度约降 12px

- 图标更新：fork 按钮改用仓库分支风格图标（fork-repo.svg）；活动栏/视图头图标改用 π 品牌镂空字形（pi-glyph.svg，VS Code mask 遮罩渲染要求镂空轮廓）；新增扩展市场发布图标（pi-icon.svg，package.json 顶层 `icon` 字段）

- 会话分支/回溯：顶部栏「分支」按钮（fork-repo.svg）弹出历史用户消息选择器（数据源 pi `get_fork_messages`，序号 + 单行截断预览），选中即从该消息 fork 出新会话文件并自动切换（原会话保留在历史列表可返回；被 fork 消息原文回填输入框，可直接发送或编辑后重发）；弹层底部「Clone current branch」复制当前分支为新会话（clone RPC）；空态/失败/扩展钩子取消均有兜底提示；防御解析 `parseForkMessages`（对齐 commands.ts 模式）

- 会话信息条：设置面板「显示会话信息」开关（pinel.showSessionStats 配置持久化，重启保留）——开启后输入框上方显示上下文占用进度条（<70% 正常 / 70-90% 警告 / >90% 危险配色，压缩后 percent 未知显示占位）、token（总量 + 输入/输出/缓存读/缓存写四项细分）、缓存命中率（对齐 pi CLI：cacheRead/(input+cacheRead+cacheWrite)，无缓存活动时隐藏）与成本（cost>0 才显示）；数据来自 pi `get_session_stats`（docs/rpc.md 已收录），每回合结束/会话切换/新建/启动时刷新，流式中不刷；失败静默保留旧值

- 会话重命名/删除：会话列表（主侧边栏 + header 弹层）行右侧 hover 显示操作按钮——edit.svg 行内编辑重命名（Enter 提交/Esc 取消，当前会话经 RPC `set_session_name`、非当前会话直接追加 session_info 条目到会话文件）；delete.svg 删除会话（删除前模态确认；当前会话禁用，控制器二次校验）；重命名/删除后列表立即刷新（新增 sessionListRefresh 通道绕 5s 节流）；重命名当前会话后 header 标题即时更新

- footer 卡片化：底部输入框与按钮合并为圆角卡片（上半输入框 + 下半左 ⚙ 设置右发送/停止）；状态区移除，错误/无模型/未打开文件夹改输入框上方横幅（附重启/重试）；placeholder 提示「输入消息，Ctrl+G 用编辑器编辑」
- 模型/思考强度移入设置面板：内嵌展开列表选择（复用 get_available_models/set_model 链路，选中后面板保持打开）
- 主侧边栏新会话按钮/搜索框/会话列表左右边距统一对齐
- @ 添加文件：输入框输入 `@` 弹出工作区文件补全列表（ignore 包 gitignore 过滤 + 上限 1000），选中后附件卡片呈现；发送时文本以 `<file name="绝对路径">` 格式注入（对齐 pi CLI file-processor，2MB 截断）、图片转 base64 附件（+ 空 `<file name>` 引用）；用户消息显示层剥离 `<file>` markup（防气泡突变）；pinel 自读自拼（RPC 模式 pi 不支持 @file 参数）
- header 会话标题：聊天顶部栏左侧显示当前会话名（宿主解析 session_info.name 广播，snapshot 携带缓存；无/无名显示「未命名会话」）
- header 新会话独立按钮：弹层内「新会话」移除，顶部右侧新增图标按钮（new-session.svg），一键新建会话
- 会话列表搜索框：弹层与主侧边栏均新增（search.svg 左嵌，本地过滤名称/预览，区分「暂无会话」/「无匹配会话」）；主侧边栏「新会话」按钮改透明描边样式（add.svg 图标）
- 聊天界面会话历史入口：顶部栏「会话历史」按钮（history.svg 图标）弹出右上角下拉列表（复用主侧边栏会话历史资产：名称/摘要/相对时间/当前标记），选择即切换会话；弹层内可直接新建会话；列表每次打开实时扫描（controller.getSessionList 与历史视图共享扫描纯函数）
- 编辑器编辑提示词：聚焦输入框按 **Ctrl+G** 在 VS Code 原生编辑器中编辑提示词（扩展键位注册，when 限定输入框聚焦；带入当前输入内容，`os.tmpdir()` 临时 `.md` 文件）；**Ctrl+S 保存后自动回填输入框**（行尾统一 LF），发送后自动关闭编辑器标签页并删除临时文件；手动关闭标签页同样清理
- 状态栏设置按钮回归：模型显示左侧新增 ⚙ 设置按钮（settings.svg 图标，颜色随主题自适应），点击打开配置面板（队列模式/自动压缩）——此前因 emoji ⚙ 图标过小改为 `/settings` 命令触发，现以正式 SVG 图标恢复按钮入口
- 发送/停止按钮换用 SVG 图标（send.svg/stop.svg，主题自适应：发送图标随按钮前景色、停止图标保持红色警示语义）
- 会话历史（主侧边栏）：点击活动栏 Pinel 图标展示会话历史列表（顶部「新会话」按钮；会话卡片显示名称/首条消息摘要/相对时间/当前会话标记，按最近活动排序；仅显示当前工作目录的会话；损坏文件跳过）；点击会话或「新会话」后聊天界面出现在**次侧边栏（右侧）**（容器 `pinel-chat`；关闭后自动重新打开）；支持 `pinel.sessionDir` 自定义会话目录
- 加载动画三阶段：webview 挂载前主题化 spinner（防空白闪烁）、pi 启动阶段全屏「正在启动 Pi…」动画、会话切换/新建期间半透明遮罩（禁用输入）
- 模型/思考强度下拉选择：状态栏模型名/思考等级点击后弹出下拉列表（数据源 `get_available_models`/`get_available_thinking_levels`，每次点击时拉取，失败提示并关闭），选中即切换（`set_model`/`set_thinking_level`；模型切换后思考等级经 `get_state` 回读同步——pi 切模型会重新钳制思考等级；思考等级有 clamp 语义，回读确认实际生效值；流式中可切换、自下一回合生效；选择由 pi 持久化，重启后保留）
- 设置面板改为独立入口：状态栏右侧新增「⚙ 设置」按钮触发（面板只含队列模式与自动压缩）；模型/思考等级不再循环切换
- 配置面板：状态栏模型名/思考等级变为可点击按钮，弹出配置面板——模型/思考强度点击循环切换（`cycle_model`/`cycle_thinking_level`，模型切换同步更新思考等级，流式中可切换、自下一回合生效）；队列模式（steering/跟进）「全部投递/一次一条」点选；自动压缩开关；选择由 pi 持久化，重启后保留；点击外部/Esc 关闭（面板打开时 Esc 只关面板，不误触中断）；非运行态/无模型时切换区禁用
- 输入框与发送/停止按钮首行同高：按钮高度随 VS Code 字号自适应（等于输入框首行盒高），输入框增长时按钮保持贴底
- 问卷面板标签式改造：题目以横向标签栏排列（header 短标签 + 已答 ✓ 标记），点击切换、同一时刻只显示一道题；单选/自定义答案答完自动切下一未答题（多选用「下一题」按钮）；全部答完自动进入「确认」标签（只读 Q&A + 修改跳转）
- 问卷确认流程：`ask_user_question` 问卷以整卷形式一次展示（题目/选项/多选/自定义答案），自动聚焦首个未答题；答完最后一题弹出确认面板，可「修改」任一题重新作答，确认后自动按序回填给 Pi（含多选数字与哨兵自定义答案的跟进输入）；Esc 放弃整卷；新对话框自动滚动聚焦（所有 ctx.ui 对话框）
- 待办面板移到输入框上方（限高 30vh 内部滚动）
- `/` 命令自动补全：输入框键入 `/` 弹出候选下拉列表（数据源为 pi 的 `get_commands`：扩展命令/提示模板/技能，含描述与来源徽标；启动/agent 空闲/重启时刷新）；↑↓ 选择、Enter/Tab 接受、Esc 关闭（与中断/清空分层）、鼠标可点；接受后插入 `/命令 ` 留在输入框继续输入参数；中文输入法组合输入期间不拦截快捷键
- 扩展 UI 交互：`ctx.ui.*` 对话框（select/confirm/input/editor，如 ask_user_question 插件问卷）渲染为聊天流内联卡片，用户作答/取消后回传 agent
- 待办面板：todo 工具任务列表（适配 rpiv-todo）在聊天流顶部固定面板展示（可折叠）
- 模型状态自愈：启动时 get_state 重试（最多 4 次，间隔 2s/5s/10s），仍无模型自动重启 pi 一次；自愈耗尽后状态栏显示「⚠ 无可用模型」警告态 + 重启按钮

### Changed

- 会话信息条 p10k 风格环境段：与输入卡同宽，左侧环境段 `folderName on  branch [!?↑↓]`（Maple Mono NF 字体打包，分支图标 U+F418）、右侧指标段按 git/上下文/缓存读/缓存写/缓存命中率/成本 顺序两头分占；git 状态富化（ahead/behind/改动/未跟踪，`[gone]`/单边 bracket 覆盖）；`gitStatus` 消息更名 `sessionEnv`（folderName + git）；整个聊天面板与宿主 notice/error 文案改英文
- 会话信息条融合进输入框卡片：改为叠放在输入卡正后方、仅下方探出（第二张卡样式），元素间 `·` 分隔符去除（改 gap 左对齐）、两侧留白；输入卡按钮行上下留白略减
- 聊天 header 会话历史入口 UI 微调：按钮去除「会话历史」文字只留图标（补 aria-label）；弹窗缩小（240px 宽 / 40vh 高 / 列表项紧凑）；弹层内「新会话」按钮改为顶部紧凑胶囊样式（主侧边栏历史视图样式不受影响）
- 输入框改为单行起步（随输入换行增长，8 行封顶后内部滚动）；发送/停止按钮改为正方形（边长随 VS Code 字号自适应，与输入框首行同高）
- 输入框 placeholder 改为「输入消息或 / 命令」（流式输出中仍显示队列提示）
- 移除 `/settings` 命令触发设置面板的本地拦截：`/settings` 输入恢复为普通文本发送给模型；设置面板唯一入口为状态栏 ⚙ 设置按钮
- 未打开文件夹时不再显示「pi 进程异常」，改为友好提示「⚠ 未打开文件夹」；打开文件夹后自动连接 pi
- pi 停止改为优雅退出优先：先关闭 stdin 让 pi 自行 flush 会话/释放锁（优雅期 2.5s），超时后硬杀兜底（总时长 5s 契约不变）；窗口关闭/重载时等待退出完成
- 状态栏 `running` 态延后到首次状态同步成功后置位（慢启动期间显示「启动中…」而非假警告）；模型为空时隐藏思考等级显示
- 移除「添加图片」按钮（保留 Ctrl+V 粘贴图片）
- 更换扩展图标为高清版 SVG

### Fixed

- 切换/新建会话（含 fork/clone）后待办面板残留旧会话任务——会话变更成功后仅重置了流装配/工具卡片，未清空 todo 快照；现在待办随新会话清零

- 调查问卷提交后不再钉在消息流底部展开挡住最新消息——点击 Submit 后自动收起为一行状态条「✓ Questionnaire answered (n/n)」并插入消息流原位（提交瞬间的消息位置），后续消息（工具结果/流式回复）出现在其下方随流上移，行为如正常消息；settle 后随问卷清除消失（权威转录中工具结果卡保留答案信封）

- 会话面板卡「切换中」且后续点击无响应——新建/切换会话在「无工作区」「pi 不可用」前置路径返回时不广播切换状态复位（历史面板本地乐观置位后无法恢复）；现所有路径保证广播 `sessionSwitching:false`
- 次侧边栏容器标题「Pinel 聊天」改为「Pinel」
- 设置面板改由 `/settings` 命令触发（输入框发送时拦截，不发给模型——pi 的 `/settings` 是 TUI 内置命令，RPC 模式下发送无效），移除状态栏 ⚙ 设置按钮
- 聊天界面没有出现在右侧边栏——次侧边栏视图容器 id 含点号（`pinel.chat`）违反 VS Code 容器 id 字符校验（仅允许字母数字/`_`/`-`），容器注册失败、聊天视图被降级到资源管理器；容器 id 改为 `pinel-chat`（视图 id/命令不变）
- 发送提示词后用户消息显示两次——pi 对用户消息也发 message_start/message_end 事件，宿主重复推送；现门控跳过（乐观渲染保留，权威列表由快照提供）
- 命令补全弹窗：修复 hover 高亮时描述/来源徽标看不清（激活行内文字未跟随焦点前景色）——现与 VS Code QuickPick 一致：激活行全部文字用焦点前景色、描述/徽标降不透明度分层，徽标边框随文字色；修复方向键导航到底部时列表不滚动——高亮项现在自动滚入可视区（只滚弹窗不牵动消息列表）
- 切换文件夹（窗口重载）后状态栏显示「未选择模型 medium ·就绪」且无法手动修复——running 态无重启按钮、模型状态只读一次不刷新；现由模型自愈 + 警告态覆盖
- F5 调试时开发宿主未打开工作区（launch.json 未传工作区参数）导致面板提示「请先打开一个文件夹」且重启无效
- 重启 pi 后旧进程迟到的退出事件可能把状态栏打回「pi 进程异常」（restart 竞态）
- 工具调用结果左侧多余缩进，与其他消息左对齐
- 活动栏图标显示为黑色方块（图标含全幅背景，被 VS Code mask 染色渲染吞没）——替换为单色 π 轮廓

- Initial release
