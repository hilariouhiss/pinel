import type { StreamBlock } from "./stream-assembly";

/**
 * 流式广播节流（纯逻辑，无 vscode 依赖，可单测）：
 * 增量事件高频到达时合并为固定节奏的尾部刷新——webview 端渲染频率均匀，
 * 消除逐 delta 重绘的视觉卡顿（一段一段）。
 *
 * 语义：push 只记录最新块引用（装配就地累加，引用内容持续增长），
 * 定时器触发时 flush 最新内容；同期间内多次 push 只 flush 一次（尾部）。
 */
export class StreamFlushThrottle {
  private timer: NodeJS.Timeout | null = null;
  private latest: StreamBlock[] | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly flush: (blocks: StreamBlock[]) => void,
  ) {}

  /** 记录最新块并调度刷新（已有待决定时器时仅更新内容，不叠加定时器）。 */
  push(blocks: StreamBlock[]): void {
    this.latest = blocks;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.latest;
      this.latest = null;
      if (pending) {
        this.flush(pending);
      }
    }, this.intervalMs);
  }

  /** 取消待决刷新（重置/权威替换/进程退出路径，防陈旧块迟到广播）。 */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
