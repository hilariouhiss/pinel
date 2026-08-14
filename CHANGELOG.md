# Change Log

All notable changes to the "pinel" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- `/` 命令自动补全：输入框键入 `/` 弹出候选下拉列表（数据源为 pi 的 `get_commands`：扩展命令/提示模板/技能，含描述与来源徽标；启动/agent 空闲/重启时刷新）；↑↓ 选择、Enter/Tab 接受、Esc 关闭（与中断/清空分层）、鼠标可点；接受后插入 `/命令 ` 留在输入框继续输入参数；中文输入法组合输入期间不拦截快捷键
- 扩展 UI 交互：`ctx.ui.*` 对话框（select/confirm/input/editor，如 ask_user_question 插件问卷）渲染为聊天流内联卡片，用户作答/取消后回传 agent
- 待办面板：todo 工具任务列表（适配 rpiv-todo）在聊天流顶部固定面板展示（可折叠）
- 模型状态自愈：启动时 get_state 重试（最多 4 次，间隔 2s/5s/10s），仍无模型自动重启 pi 一次；自愈耗尽后状态栏显示「⚠ 无可用模型」警告态 + 重启按钮

### Changed

- 未打开文件夹时不再显示「pi 进程异常」，改为友好提示「⚠ 未打开文件夹」；打开文件夹后自动连接 pi
- pi 停止改为优雅退出优先：先关闭 stdin 让 pi 自行 flush 会话/释放锁（优雅期 2.5s），超时后硬杀兜底（总时长 5s 契约不变）；窗口关闭/重载时等待退出完成
- 状态栏 `running` 态延后到首次状态同步成功后置位（慢启动期间显示「启动中…」而非假警告）；模型为空时隐藏思考等级显示
- 移除「添加图片」按钮（保留 Ctrl+V 粘贴图片）
- 更换扩展图标为高清版 SVG

### Fixed

- 切换文件夹（窗口重载）后状态栏显示「未选择模型 medium ·就绪」且无法手动修复——running 态无重启按钮、模型状态只读一次不刷新；现由模型自愈 + 警告态覆盖
- F5 调试时开发宿主未打开工作区（launch.json 未传工作区参数）导致面板提示「请先打开一个文件夹」且重启无效
- 重启 pi 后旧进程迟到的退出事件可能把状态栏打回「pi 进程异常」（restart 竞态）
- 工具调用结果左侧多余缩进，与其他消息左对齐
- 活动栏图标显示为黑色方块（图标含全幅背景，被 VS Code mask 染色渲染吞没）——替换为单色 π 轮廓

- Initial release
