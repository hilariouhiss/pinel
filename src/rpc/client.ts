import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { JsonlDecoder, encodeRecord } from "./framing";
import type { ClientCommand, RpcRecord, RpcResponse } from "./protocol";

const IS_WIN = process.platform === "win32";

/** stop() 优雅期：关闭 stdin 触发 pi 优雅退出（flush 会话/释放锁），等待真实退出。 */
const STOP_GRACE_MS = 2500;
/** stop() 总时长契约：优雅期 + 硬杀兜底等待，超时不再挂起。 */
const STOP_TOTAL_MS = 5000;

/** spawn 解析结果。 */
export interface SpawnSpec {
  cmd: string;
  args: string[];
  options: SpawnOptions;
}

/** 拼接进 shell 命令串的参数转义：含空白时加引号（cmd.exe / shell 模式）。 */
function quoteIfNeeded(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * 解析 pi 启动方式（Windows shim 处理）。
 *
 * 规则：
 * 1. `command` 是存在的文件路径：
 *    - `.cmd` / `.bat` → 通过 `cmd.exe /d /s /c` 包装执行（CreateProcess 无法
 *      直接执行批处理 shim）；
 *    - 其他 → 直接 spawn。
 * 2. `command` 是含空格/参数的非路径字符串（如 `node "/path/fake-pi.js"`）→
 *    作为完整 shell 命令执行（shell: true）。
 * 3. 裸命令名（如 `pi`）→ Windows 上用 `shell: true` 交给 cmd.exe：
 *    实测发现 PATH 中同时存在无扩展名的 `pi`（shell 脚本）与 `pi.cmd` 时，
 *    libuv/where.exe 都会优先命中前者，直接 spawn 报 ENOENT；
 *    而 cmd.exe 自身会按 PATHEXT 正确解析到 `pi.cmd`（npm shim 的设计场景）。
 *    POSIX 上直接 spawn（PATH 查找）。
 *    注意：shell: true 时参数不自动转义，rpcArgs 必须是不含特殊字符的字面量。
 */
export function resolveSpawnSpec(command: string, rpcArgs: string[], cwd: string): SpawnSpec {
  const looksLikePath = command.includes("/") || command.includes("\\");

  if (looksLikePath && fs.existsSync(command)) {
    return specForExistingPath(command, rpcArgs, cwd);
  }

  if (looksLikePath && !fs.existsSync(command)) {
    // 完整命令字符串（含参数），交给 shell 执行——用于测试/自定义脚本场景。
    // 注意：把 --mode rpc 拼入命令串（shell 模式不使用独立 args 数组）；
    // 含空白的参数（如 --session-dir 的路径）加引号防解析破坏
    return {
      cmd: `${command} ${rpcArgs.map(quoteIfNeeded).join(" ")}`,
      args: [],
      options: { cwd, shell: true, windowsHide: true },
    };
  }

  if (IS_WIN) {
    // where.exe 返回全部匹配（可能同时有无扩展名 sh 与 .cmd shim），
    // 优先 .cmd/.bat 行——实测无扩展名 sh 无法被 CreateProcess 执行
    const found = whereWindows(command);
    const picked =
      found.find((line) => /\.(cmd|bat)$/i.test(line.trim())) ?? found[0];
    if (picked && fs.existsSync(picked)) {
      return specForExistingPath(picked, rpcArgs, cwd);
    }
  }

  return { cmd: command, args: rpcArgs, options: { cwd, windowsHide: true } };
}

/** 用 where.exe 解析可执行文件真实路径（返回全部匹配行）。 */
function whereWindows(command: string): string[] {
  try {
    const result = spawnSync("where.exe", [command], { windowsHide: true, encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    }
  } catch {
    // where.exe 不可用时回退裸命令名
  }
  return [];
}

function specForExistingPath(filePath: string, rpcArgs: string[], cwd: string): SpawnSpec {
  const lower = filePath.toLowerCase();
  if (IS_WIN && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    // cmd.exe 包装（npm shim 同款）：
    // - 必须用 windowsVerbatimArguments：Node 默认会用反斜杠转义参数中的引号，
    //   而 cmd.exe 不解析该转义，会导致整个命令串被当作命令名；
    // - /s /c 后整条命令用双重引号包裹（/s 会剥离首尾引号）；
    // - cmd 路径用 ComSpec（反斜杠形式）；实测正斜杠路径会破坏 cmd 参数解析；
    // - 含空白的参数（--session-dir 路径）加引号防解析破坏
    return {
      cmd: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `""${filePath}" ${rpcArgs.map(quoteIfNeeded).join(" ")}"`],
      options: { cwd, windowsHide: true, windowsVerbatimArguments: true },
    };
  }
  return { cmd: filePath, args: rpcArgs, options: { cwd, windowsHide: true } };
}

interface PendingRequest {
  command: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  onSettled?: () => void;
}

export interface RpcClientEvents {
  record: (record: RpcRecord) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawnError: (err: Error) => void;
  stderr: (line: string) => void;
}

/**
 * pi RPC 子进程客户端：spawn + 严格 LF framing + id 关联 + 事件分发。
 *
 * - stdout 按协议严格切分（自实现 LF 切分，禁用 Node readline）；
 * - 每个命令带自增 id，响应按 id 关联；不带 id 的响应按 command 兜底；
 * - `stop()` 终止整个进程树（Windows: taskkill /T /F；POSIX: 信号），
 *   避免 pi 的 bash 工具子进程成为孤儿。
 */
export class RpcClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private decoder = new JsonlDecoder();
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private stoppedIntentionally = false;

  override on<K extends keyof RpcClientEvents>(event: K, listener: RpcClientEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof RpcClientEvents>(event: K, ...args: Parameters<RpcClientEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 启动子进程（重复调用前需先 stop）。extraArgs 追加到 `--mode rpc` 之后。 */
  async start(command: string, cwd: string, env: NodeJS.ProcessEnv, extraArgs?: string[]): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.stoppedIntentionally = false;
    this.decoder = new JsonlDecoder();
    const spec = resolveSpawnSpec(command, ["--mode", "rpc", ...(extraArgs ?? [])], cwd);
    const options: SpawnOptions = { ...spec.options, env, stdio: ["pipe", "pipe", "pipe"] };
    if (!IS_WIN && !options.shell) {
      // POSIX：独立进程组，使 stop() 的负 PID 组 kill 生效（bash 工具子进程随组终止）
      options.detached = true;
    }
    const child = spawn(spec.cmd, spec.args, options);
    this.child = child;

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");

    child.stdout!.on("data", (chunk: string) => {
      for (const line of this.decoder.push(chunk)) {
        this.handleLine(line);
      }
    });

    // stdin 在子进程退出时可能异步报 EPIPE：挂空监听静默兜底（stop() 另有 try/catch）
    child.stdin!.on("error", () => {});

    let stderrBuf = "";
    child.stderr!.on("data", (chunk: string) => {
      stderrBuf += chunk;
      let idx: number;
      while ((idx = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, idx).replace(/\r$/, "");
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line.trim().length > 0) {
          this.emit("stderr", line);
        }
      }
    });

    child.on("error", (err) => {
      // spawn 失败（ENOENT 等）
      this.child = null;
      this.rejectAllPending(new Error(`无法启动 pi 进程: ${err.message}`));
      this.emit("spawnError", err);
    });

    child.on("exit", (code, signal) => {
      this.child = null;
      if (!this.stoppedIntentionally) {
        this.rejectAllPending(new Error(`pi 进程已退出 (code=${code}, signal=${signal})`));
      }
      this.emit("exit", code, signal);
    });
  }

  /**
   * 发送命令并等待响应，resolve 为响应中的 `data`；失败 reject。
   * 默认 30s 超时：错误配置（如 piPath 指向交互模式的命令）不应让面板
   * 永久停在“启动中”。
   */
  send<T = unknown>(command: ClientCommand, timeoutMs = 30_000): Promise<T> {
    if (!this.isRunning) {
      return Promise.reject(new Error("pi 进程未运行"));
    }
    const id = String(this.nextId++);
    const record: RpcRecord = { id, ...command };
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        command: command.type,
        resolve: (d) => resolve(d as T),
        reject,
      };
      this.pending.set(id, entry);
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`命令 ${command.type} 超时（${timeoutMs}ms）`));
        }
      }, timeoutMs);
      timer.unref?.();
      entry.onSettled = () => clearTimeout(timer);
      this.writeRaw(record);
    });
  }

  /** 直接写一帧（用于 extension_ui_response 等无需响应的记录）。 */
  writeRaw(record: unknown): void {
    if (!this.isRunning) {
      return;
    }
    this.child!.stdin!.write(encodeRecord(record));
  }

  /**
   * 终止整个进程树，并等待子进程真正退出。
   *
   * 两级策略（总时长 5s 契约不变）：
   * 1. 优雅期（≤2.5s）：关闭 stdin 触发 pi 优雅退出（RPC 模式在 stdin EOF
   *    时自行 flush 会话、释放锁并退出），等待真实退出；
   * 2. 兜底硬杀（剩余时间）：Windows taskkill /T /F（含 bash 工具子进程），
   *    POSIX 进程组 SIGTERM → 2s 后 SIGKILL，继续等待真实退出。
   *
   * 等待退出的必要性：taskkill 同步返回后，子进程的 exit 事件要到下一轮
   * 事件循环才派发；若不等待，restart() 会在新进程启动后收到旧进程的
   * exit 事件，污染状态（见 ChatController 的身份过滤）。
   * 约定：永不 reject（kill/taskkill 异常均吞掉）；5s 超时兜底防止挂起。
   */
  async stop(): Promise<void> {
    const child = this.child;
    this.stoppedIntentionally = true;
    this.rejectAllPending(new Error("pi 进程已停止"));
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      // 已退出：不存在迟到的 exit 事件，立即返回
      return;
    }

    // 等待真实退出（spawn 失败场景由 error 事件兜底）
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });

    const deadline = Date.now() + STOP_TOTAL_MS;

    // 优雅期：关闭 stdin 让 pi 自行清理退出
    try {
      child.stdin?.end();
    } catch {
      // stdin 已销毁（进程退出竞态），忽略
    }
    const graceTimedOut = await Promise.race([
      exited.then(() => false),
      sleep(STOP_GRACE_MS).then(() => true),
    ]);
    if (!graceTimedOut) {
      return; // 已优雅退出
    }

    const kill = (sig: NodeJS.Signals): void => {
      try {
        child.kill(sig);
      } catch {
        // 进程已退出（竞态），忽略
      }
    };

    const pid = child.pid;
    if (!pid) {
      kill("SIGKILL");
    } else if (IS_WIN) {
      // 终止整棵进程树（含 bash 工具派生的子进程）
      try {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      } catch {
        kill("SIGKILL");
      }
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        kill("SIGTERM");
      }
      const sigkillTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          kill("SIGKILL");
        }
      }, 2000);
      sigkillTimer.unref();
      // 进程提前退出时取消兜底定时器（避免对已回收 PID 再发信号）
      void exited.then(() => clearTimeout(sigkillTimer));
    }

    // 硬杀后继续等待真实退出，至 5s 总截止（进程僵死时不永久挂起 restart）
    await Promise.race([exited, sleep(Math.max(deadline - Date.now(), 0))]);
  }

  private handleLine(line: string): void {
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch {
      // JSONL 解码容错：跳过无法解析的帧
      this.emit("stderr", `[Pinel] 无法解析的 RPC 帧: ${line.slice(0, 200)}`);
      return;
    }
    if (record.type === "response") {
      this.handleResponse(record as RpcResponse);
    } else {
      this.emit("record", record);
    }
  }

  private handleResponse(res: RpcResponse): void {
    let entry: PendingRequest | undefined;
    let key: string | undefined;
    if (res.id) {
      key = res.id;
      entry = this.pending.get(key);
    }
    if (!entry) {
      // 不带 id 的响应：按 command 字段兜底关联
      for (const [k, v] of this.pending) {
        if (v.command === res.command) {
          key = k;
          entry = v;
          break;
        }
      }
    }
    if (!entry || !key) {
      return; // 与任何请求无关的响应，忽略
    }
    this.pending.delete(key);
    entry.onSettled?.();
    if (res.success) {
      entry.resolve(res.data);
    } else {
      entry.reject(new Error(res.error ?? `命令 ${res.command} 失败`));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      entry.onSettled?.();
      entry.reject(err);
    }
    this.pending.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.(); // 仅用于 stop() 竞速等待：不阻止宿主进程退出
  });
}
