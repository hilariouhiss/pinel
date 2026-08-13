# Change Log

All notable changes to the "pinel" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Fixed

- F5 调试时开发宿主未打开工作区（launch.json 未传工作区参数）导致面板提示「请先打开一个文件夹」且重启无效
- 重启 pi 后旧进程迟到的退出事件可能把状态栏打回「pi 进程异常」（restart 竞态）

### Changed

- 未打开文件夹时不再显示「pi 进程异常」，改为友好提示「⚠ 未打开文件夹」；打开文件夹后自动连接 pi

- Initial release