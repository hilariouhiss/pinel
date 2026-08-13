import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
	{
		label: 'main',
		files: 'out/test/**/*.test.js',
		workspaceFolder: '.',
		mocha: {
			ui: 'tdd',
			timeout: 30000,
		},
	},
	{
		// 无工作区窗口实例：验证「未打开文件夹」的友好提示路径
		// （不传 workspaceFolder 即空窗口启动）
		label: 'no-workspace',
		files: 'out/test-no-workspace/**/*.test.js',
		mocha: {
			ui: 'tdd',
			timeout: 30000,
		},
	},
]);
