import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";

/**
 * 提示词编辑器管理（Ctrl+G 在 VS Code 原生编辑器中编辑提示词）。
 *
 * 流程：编辑（edit）→ 临时文件 + 打开编辑器 → 用户编辑并保存
 * （onDidSaveTextDocument）→ 内容经 onFilled 回调回填输入框 → 发送时
 * （disposeForSend）关闭编辑器标签页 + 删除临时文件；用户手动关闭标签页
 * → 清理临时文件（回填已发生，输入框内容保留）。
 *
 * 载体选型：真实临时文件而非 Untitled 文档——untitled 保存时不触发
 * onDidSaveTextDocument（保存转 file uri 后原 uri 被 dispose，vscode#25729）。
 *
 * 已知限制：用户 Save As 后 doc.uri 变化，保存监听失效、原文件残留
 * （用户主动偏离流程，接受）。
 */
export class PromptEditorManager {
  private pendingUri: vscode.Uri | undefined;
  /** 编辑操作 in-flight 守卫（writeFile + showTextDocument 异步，快速连按防重入）。 */
  private editInFlight = false;
  private readonly saveSub: vscode.Disposable;
  private readonly closeTabSub: vscode.Disposable;

  constructor(private readonly onFilled: (text: string) => void) {
    this.saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (this.pendingUri && doc.uri.toString() === this.pendingUri.toString()) {
        // 行尾规范化：Windows 编辑器保存会把 \n 转 \r\n，回填统一为 LF
        //（与 webview 输入框/pi RPC 的 LF 惯例一致）
        this.onFilled(doc.getText().replace(/\r\n?/g, "\n"));
      }
    });
    // 注意：不能用 onDidCloseTextDocument 做标签页关闭监听——它跟踪文档对象
    // 生命周期而非编辑器 UI，关闭标签页后可能延迟数分钟才触发（vscode#199282/#84505）；
    // tabGroups.onDidChangeTabs 的 event.closed 随标签页关闭立即触发。
    this.closeTabSub = vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        if (
          this.pendingUri &&
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === this.pendingUri.toString()
        ) {
          void this.removeFile(this.pendingUri);
          this.pendingUri = undefined;
        }
      }
    });
  }

  /** 测试钩子：当前待决临时文件 uri（未编辑/已清理时为 undefined）。 */
  getPendingUri(): vscode.Uri | undefined {
    return this.pendingUri;
  }

  /**
   * 打开编辑器编辑提示词。
   * 已有 pending 编辑器时先关闭旧标签页（丢弃未保存修改——用户主动再按 Ctrl+G
   * 的预期行为）并删除旧文件，再新建。
   */
  async edit(initialText: string): Promise<void> {
    if (this.editInFlight) {
      return;
    }
    this.editInFlight = true;
    try {
      if (this.pendingUri) {
        await this.closeEditorTab(this.pendingUri);
        await this.removeFile(this.pendingUri);
        this.pendingUri = undefined;
      }
      // 临时文件用 .md：提示词常含 markdown 代码块，编辑时有高亮
      const uri = vscode.Uri.file(path.join(os.tmpdir(), `pinel-prompt-${Date.now()}.md`));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(initialText, "utf8"));
      const doc = await vscode.workspace.openTextDocument(uri);
      // preview:false 固定标签：preview 标签会被用户打开其他文件时替换并触发
      // close 清理（丢失编辑），发送后关闭不堆积
      await vscode.window.showTextDocument(doc, { preview: false });
      this.pendingUri = uri;
    } finally {
      this.editInFlight = false;
    }
  }

  /** 发送时清理：关闭编辑器标签页 + 删除临时文件（幂等；找不到标签时仅删文件）。 */
  async disposeForSend(): Promise<void> {
    const uri = this.pendingUri;
    if (!uri) {
      return;
    }
    // 先清状态再关标签：close 处理器过滤不命中，防双删竞态
    this.pendingUri = undefined;
    await this.closeEditorTab(uri);
    await this.removeFile(uri);
  }

  dispose(): void {
    this.saveSub.dispose();
    this.closeTabSub.dispose();
  }

  private async closeEditorTab(uri: vscode.Uri): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
          await vscode.window.tabGroups.close(tab);
          return;
        }
      }
    }
  }

  private async removeFile(uri: vscode.Uri): Promise<void> {
    try {
      // maxRetries：Windows 上文档句柄释放延迟（EBUSY）时重试
      await fs.rm(uri.fsPath, { force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 删除失败：tmpdir 残留无害（OS 清理）
    }
  }
}
