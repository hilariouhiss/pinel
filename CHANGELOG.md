# Change Log

All notable changes to the "pinel" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- 扩展 UI 交互：`ctx.ui.*` 对话框（select/confirm/input/editor，如 ask_user_question 插件问卷）渲染为聊天流内联卡片，用户作答/取消后回传 agent
- 待办面板：todo 工具任务列表（适配 rpiv-todo）在聊天流顶部固定面板展示（可折叠）

### Changed

- 未打开文件夹时不再显示「pi 进程异常」，改为友好提示「⚠ 未打开文件夹」；打开文件夹后自动连接 pi
- 移除「添加图片」按钮（保留 Ctrl+V 粘贴图片）

### Fixed

- F5 调试时开发宿主未打开工作区（launch.json 未传工作区参数）导致面板提示「请先打开一个文件夹」且重启无效
- 重启 pi 后旧进程迟到的退出事件可能把状态栏打回「pi 进程异常」（restart 竞态）
- 工具调用结果左侧多余缩进，与其他消息左对齐

- Initial release