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

/**
 * 按键记忆最新值的尾沿节流（纯逻辑，无 vscode 依赖）：
 * 高频 set(key, value) 合并为固定节奏 flush——用于工具执行更新
 * （toolCallId → ToolCard）：多工具并发时每键只留最新，flush 时逐键回调。
 *
 * 与 StreamFlushThrottle 的差异：cancel 同时丢弃记忆——工具卡是可变状态，
 * 陈旧 ToolCard 迟到广播会让已清空的卡片在 webview 复活；stream 块在重置后
 * 由权威广播覆盖，无此问题。
 */
export class KeyedFlushThrottle<V> {
  private timer: NodeJS.Timeout | null = null;
  private latest = new Map<string, V>();

  constructor(
    private readonly intervalMs: number,
    private readonly flush: (latest: ReadonlyMap<string, V>) => void,
  ) {}

  /** 记录键的最新值并调度刷新（同窗口内重复键覆盖，不叠加定时器）。 */
  push(key: string, value: V): void {
    this.latest.set(key, value);
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.latest;
      this.latest = new Map();
      if (pending.size > 0) {
        this.flush(pending);
      }
    }, this.intervalMs);
  }

  /** 取消待决刷新并丢弃记忆（重置/切换/退出路径，防陈旧值迟到广播）。 */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.latest.clear();
  }
}
