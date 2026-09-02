import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { vscode } from "./index";
import type { CatalogItem, ChatMessage, ChatStatus, ContentBlock, ExtensionItem, ExtensionUpdateEntry, FileItem, ForkMessageItem, HostMessage, ModeState, ModelInfo, PinelMcp, PinelPluginState, PinelPrompt, PinelWorkflow, PonytailStatus, QuestionnaireView, SessionEnv, SessionListItem, SessionStats, SlashCommand, StreamBlock, TodoTask, ToolCard, UiRequest } from "./types";
import { Composer } from "./components/Composer";
import { ConfigPopover } from "./components/ConfigPopover";
import { ModelPopover } from "./components/ModelPopover";
import { ExtensionPopover } from "./components/ExtensionPopover";
import { ModePopover } from "./components/ModePopover";
import { SessionListPopover } from "./components/SessionListPopover";
import { ForkPopover } from "./components/ForkPopover";
import { SessionStatsBar } from "./components/SessionStatsBar";
import { ContextBar } from "./components/ContextBar";
import { WorkflowBar } from "./components/WorkflowBar";
import { MessageView, userText, type ToolResultInfo } from "./components/MessageView";
import { RecentRoundBar } from "./components/RecentRoundBar";
import { resolveVisibleUser } from "./roundbar-rule";
import { extensionRowKey, mergeExtensionUpdates, updatableItems } from "./extension-updates";
import { Notices } from "./components/Notices";
import { TodoPanel } from "./components/TodoPanel";
import { UiDialogs } from "./components/UiDialogs";
import { Questionnaire } from "./components/Questionnaire";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import historyIcon from "lucide-static/icons/history.svg";
import newSessionIcon from "lucide-static/icons/plus.svg";
import forkIcon from "lucide-static/icons/git-fork.svg";
import reloadIcon from "lucide-static/icons/rotate-cw.svg";

const initialStatus: ChatStatus = {
  processState: "stopped",
  isStreaming: false,
  isCompacting: false,
  model: null,
  thinkingLevel: "medium",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  autoCompactPercent: null,
  autoCommitEnabled: false,
  showSessionStats: false,
  steering: [],
  followUp: [],
};

let noticeSeq = 0;

/** 弹窗互斥：任一时刻只开一个（⚙ 设置面板 / 扩展管理 / 会话历史 / 分支选择器）。 */
type PopoverKind = "config" | "session" | "fork" | "ext" | "model" | "thinking" | "mode" | null;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamBlocks, setStreamBlocks] = useState<StreamBlock[]>([]);
  const [tools, setTools] = useState<Record<string, ToolCard>>({});
  const [status, setStatus] = useState<ChatStatus>(initialStatus);
  const [pendingUi, setPendingUi] = useState<UiRequest[]>([]);
  const [todos, setTodos] = useState<TodoTask[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [questionnaire, setQuestionnaire] = useState<QuestionnaireView | null>(null);
  /** 弹窗互斥状态（模型/思考 chip 下拉 / ⚙ 设置面板 / 会话历史等）。 */
  const [popover, setPopover] = useState<PopoverKind>(null);
  /** 模型列表数据与加载态（宿主 models 消息填充；空数组 = 失败信号，关闭弹窗）。 */
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  /** 思考强度列表数据与加载态。 */
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [thinkingLoading, setThinkingLoading] = useState(false);
  /** 会话历史按钮元素引用（SessionListPopover 锚定）。 */
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  /** 新会话按钮元素引用（锚定不需要，与 historyBtnRef 同组）。 */
  const newSessionBtnRef = useRef<HTMLButtonElement>(null);
  /** 分支按钮元素引用（ForkPopover 锚定）。 */
  const forkBtnRef = useRef<HTMLButtonElement>(null);
  /** Extensions chip 元素引用（ExtensionPopover 开关信号 + 焦点还原锚；chip 在 ContextBar 渲染）。 */
  const extensionChipRef = useRef<HTMLButtonElement>(null);
  /** 模式 chip 元素引用（ModePopover 开关信号 + 焦点还原锚；chip 在 ContextBar 渲染）。 */
  const modeChipRef = useRef<HTMLButtonElement>(null);
  /** 模型/思考 chip 元素引用（ModelPopover 锚定）。 */
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const thinkingChipRef = useRef<HTMLButtonElement>(null);
  /** 可 fork 的历史用户消息（getForkMessages 响应填充；打开时拉取）。 */
  const [forkMessages, setForkMessages] = useState<ForkMessageItem[]>([]);
  /** 模式状态（getModeState 响应填充；打开弹层拉取，操作后宿主重发）。 */
  const [modeState, setModeState] = useState<ModeState | null>(null);
  /** 扩展列表（getExtensionList 响应填充；挂载预热 + 打开管理弹层拉取，启停/卸载后宿主重发）。 */
  const [extensions, setExtensions] = useState<ExtensionItem[]>([]);
  /** 扩展弹层当前视图（All/Catalog 切换；All 时重拉列表）。 */
  const [extensionView, setExtensionView] = useState<"all" | "catalog">("all");
  /** 更新检查条目（extensionUpdates 消息填充；与 extensions 经 useMemo 合并渲染）。 */
  const [updateEntries, setUpdateEntries] = useState<ExtensionUpdateEntry[]>([]);
  /** 更新中的行键（乐观置忙；extensionList/extensionUpdates 到达即清）。 */
  const [updatingKeys, setUpdatingKeys] = useState<Set<string>>(new Set());
  /** 合并更新态的列表（ExtensionPopover 渲染源）。 */
  const mergedExtensions = useMemo(
    () => mergeExtensionUpdates(extensions, updateEntries),
    [extensions, updateEntries],
  );
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  /** 安装中的 spec（防重复点击；catalogState 刷新时清除）。 */
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  /** 会话历史列表（header 弹层数据；getSessionList 响应填充）。 */
  const [sessionItems, setSessionItems] = useState<SessionListItem[]>([]);
  /** 会话统计（get_session_stats 推送；null=尚未拉取）。 */
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  /** ponytail 状态（ponytail 插件自推帧解析；null=未收到/未装，信息条隐藏）。 */
  const [ponytailStatus, setPonytailStatus] = useState<PonytailStatus | null>(null);
  /** MCP 服务器明细（宿主 statusKey "pinel.mcp" 帧；null=未收到帧 → MCP chip 隐藏）。 */
  const [pinelMcp, setPinelMcp] = useState<PinelMcp | null>(null);
  /** pinel.workflow 工作流运行状态（rpiv-workflow 生命周期推送；null=无运行/会话已切）。 */
  const [pinelWorkflow, setPinelWorkflow] = useState<PinelWorkflow | null>(null);
  /** pinel.prompt 提示词组成（插件 agent_start 推送；null=未收到 → 组成 chip 隐藏）。 */
  const [pinelPrompt, setPinelPrompt] = useState<PinelPrompt | null>(null);
  /** Pinel 插件安装态（扩展管理弹层安装区数据）。 */
  const [pinelPluginState, setPinelPluginState] = useState<PinelPluginState | null>(null);
  /** 会话信息条环境段（宿主 sessionEnv 推送；含文件夹名 + git 状态）。 */
  const [sessionEnv, setSessionEnv] = useState<SessionEnv | null>(null);
  /** 工作区文件列表（@ 添加文件数据；getFileList 响应填充）。 */
  const [fileList, setFileList] = useState<FileItem[]>([]);
  /** 当前会话标题（宿主 sessionTitle 广播；snapshot 重放恢复）。 */
  const [sessionTitle, setSessionTitle] = useState<string | undefined>(undefined);
  /** 当前会话文件（快照替换语义：会话变化时清空本地 tools）。 */
  const sessionFileRef = useRef<string | undefined>(undefined);
  /** 会话切换/新建进行中（切换遮罩）。 */
  const [switching, setSwitching] = useState(false);
  /** 新对话框卡片 id：到达时强制滚动+聚焦（快照重放不触发）。 */
  const [focusDialogId, setFocusDialogId] = useState<string | null>(null);
  /** 问卷推送版本：每次收到 questionnaire 消息（非快照）自增，驱动问卷重新聚焦。 */
  const [qnaFocusVersion, setQnaFocusVersion] = useState(0);
  /** 问卷提交后收起状态条在消息流中的插入位置（提交瞬间的消息数；null=未捕获/无）。 */
  const [qnaFlowIndex, setQnaFlowIndex] = useState<number | null>(null);
  /** Ctrl+G 编辑器保存回填（seq 递增驱动 Composer 重复回填）。 */
  const [fill, setFill] = useState<{ seq: number; text: string }>({ seq: 0, text: "" });
  /** Ctrl+G 命令触发版本（宿主 pinel.editPrompt 命令广播；webview 取输入内容发起编辑）。 */
  const [editPromptTrigger, setEditPromptTrigger] = useState(0);
  const [notices, setNotices] = useState<Array<{ id: number; level: string; text: string }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** 用户滚动意图标记：wheel/pointer/touch 后短窗内（400ms）到达的 scroll 事件才算用户滚动。
   *  浏览器 scroll anchoring 与程序性滚动（自动跟随）同样产生 scroll 事件，
   *  若按位置重算 stickToBottom 会被锚定补偿误关（长文本回流/思考卡触顶时停止跟随）。 */
  const userScrollIntent = useRef(false);
  const intentTimer = useRef<number | undefined>(undefined);
  const markUserScrollIntent = useCallback(() => {
    userScrollIntent.current = true;
    window.clearTimeout(intentTimer.current);
    intentTimer.current = window.setTimeout(() => {
      userScrollIntent.current = false;
    }, 400);
  }, []);
  /** 悬浮条隐藏态：点击滚回后隐藏，上滚离开该消息/滚到底部时重现（computeVisible 内判定）。 */
  const [roundBarHidden, setRoundBarHidden] = useState(false);

  /** toolResult 结果映射（toolCallId → 权威输出/isError/toolName；快照重放可重建）
   *  + 命中集合（assistant 消息或流式块中出现的 toolCall id）。命中集合含流式块：
   *  toolResult 消息先于 assistant message_end 到达时仍能跳过独立卡片（防闪现）。 */
  // 用户消息索引列表（悬浮条滚动联动数据源）：messages 中 role==="user" 的全局索引
  //（控制消息 /pinel-* 不写条目天然排除；图片消息文案兕底见 roundBarText）
  const userMsgIndexes = useMemo(() => {
    const idx: number[] = [];
    messages.forEach((m, i) => {
      if (m.role === "user") {
        idx.push(i);
      }
    });
    return idx;
  }, [messages]);
  /** 悬浮条当前显示的用户消息索引（null = 隐藏；computeVisible 未跑过时保持 null，首帧不闪现）。 */
  const [visibleUserIndex, setVisibleUserIndex] = useState<number | null>(null);
  /** 悬浮条文案：仅图片用户消息兕底 "📎 图片"；无显示索引 → 空串（组件不渲染）。 */
  const roundBarText =
    visibleUserIndex !== null ? userText(messages[visibleUserIndex]?.content) || "📎 图片" : "";

  // 按当前滚动位置重算悬浮条应显示的用户消息（规则见 roundbar-rule.ts 纯函数）。
  // 同时维护隐藏态重现：点击滚回后 hidden，仅当应显示的消息离开视口才重现。
  const computeVisible = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    if (userMsgIndexes.length === 0) {
      setVisibleUserIndex(null);
      return;
    }
    const y = el.getBoundingClientRect().top;
    const relTops = userMsgIndexes.map((mi) => {
      const msgEl = el.querySelector<HTMLElement>(`[data-msg-index="${mi}"]`);
      return msgEl ? msgEl.getBoundingClientRect().top - y : null;
    });
    const vi = resolveVisibleUser(relTops, stickToBottom.current);
    const visMsgIdx = vi < 0 ? null : userMsgIndexes[vi];
    // 隐藏态重现判定：应显示的消息与视口相交（部分可见）→ 保持隐藏；离开 → 重现
    let inView = false;
    if (visMsgIdx !== null) {
      const msgEl = el.querySelector<HTMLElement>(`[data-msg-index="${visMsgIdx}"]`);
      if (msgEl) {
        const r = msgEl.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        inView = r.bottom > c.top && r.top < c.bottom;
      }
    }
    setVisibleUserIndex(visMsgIdx);
    setRoundBarHidden((hidden) => (hidden ? (inView ? hidden : false) : hidden));
  }, [userMsgIndexes]);

  // 点击悬浮条滚回当前显示的用户消息（scroll-margin-top 防遮挡；stickToBottom 由 onScroll 自然更新）
  // 点击即隐藏悬浮条：滚回后消息已在视口，无需导航条遮挡内容（上滚离开后 computeVisible 重现）
  const locateLastUser = () => {
    if (visibleUserIndex === null) {
      return;
    }
    setRoundBarHidden(true);
    const el = scrollRef.current?.querySelector(`[data-msg-index="${visibleUserIndex}"]`);
    el?.scrollIntoView({ block: "start" });
    // 焦点移交滚动容器：悬浮条卸载后焦点不落 body，键盘 ↑↓ 仍可滚动
    scrollRef.current?.focus();
  };

  const toolResults = useMemo(() => {
    const results: Record<string, ToolResultInfo> = {};
    const matched = new Set<string>();
    for (const b of streamBlocks) {
      if (b.kind === "toolCall" && b.toolCall?.id) {
        matched.add(b.toolCall.id);
      }
    }
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content as ContentBlock[]) {
          if (b.type === "toolCall" && typeof b.id === "string") {
            matched.add(b.id);
          }
        }
      } else if (m.role === "toolResult" && typeof m.toolCallId === "string") {
        const raw = Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
        results[m.toolCallId] = {
          text: raw
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n"),
          isError: Boolean(m.isError),
          toolName: typeof m.toolName === "string" ? m.toolName : "",
        };
      }
    }
    return { results, matched };
  }, [messages, streamBlocks]);

  const handleMessage = useCallback((event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case "snapshot":
        // 快照替换语义：会话文件变化（切换/新建/重启后）→ 清空本地工具卡片
        //（旧 toolCallId 可能在新会话同 id 消息上错配工具卡片）
        if (msg.status.sessionFile !== sessionFileRef.current) {
          setTools({});
          sessionFileRef.current = msg.status.sessionFile;
          // 分支弹层数据属于旧会话：关闭弹层并清空，防选中旧 entryId 报错（评审 S2）
          setPopover((prev) => (prev === "fork" ? null : prev));
          setForkMessages([]);
          // 消息列表整体替换：问卷收起条位置失效，置 null 由捕获 effect 重新捕获
          //（同会话 agent_end 快照不动这里——submitted 问卷尚在，状态条保持原位）
          setQnaFlowIndex(null);
          // 新会话恢复悬浮条常驻（重置键用 sessionFile：消息数相同的切换/clone 时 index 不变）
          setRoundBarHidden(false);
        }
        setMessages(msg.messages);
        setStreamBlocks([]);
        setStatus(msg.status);
        setSessionStats(msg.sessionStats ?? null); // 快照恢复（重显/重启不留长期占位）
        setSessionEnv(msg.sessionEnv ?? null);
        setPinelWorkflow(msg.pinelWorkflow);
        setPinelPrompt(msg.pinelPrompt ?? null);
        setPinelPluginState(msg.pinelPluginState);
        setPonytailStatus(msg.ponytailStatus);
        setPinelMcp(msg.pinelMcp ?? null);
        setPendingUi(msg.pendingUi ?? []);
        setTodos(msg.todos ?? []);
        setCommands(msg.commands ?? []);
        setQuestionnaire(msg.questionnaire ?? null);
        setSessionTitle(msg.sessionTitle);
        break;
      case "stream":
        setStreamBlocks(msg.blocks);
        break;
      case "message":
        // 用户消息（乐观渲染）→ 强制回底：手动上滚后再发送也回到最新（后续 stickToBottom 由 onScroll 维护）
        if (msg.message.role === "user") {
          stickToBottom.current = true;
        }
        // assistant 落定与清流同帧提交：占位槽 key = m-${messages.length} 与落定消息
        // key 相同 → React 原地复用 DOM（settle 不重挂载，入场动效/卡片展开态不重放）
        if (msg.message.role === "assistant") {
          setStreamBlocks([]);
        }
        setMessages((prev) => [...prev, msg.message]);
        break;
      case "bash":
        // 终端命令卡：本地键（pinelBashId）替换更新流式输出；新卡插入时强制回底
        //（更新不碰 stickToBottom——长输出期间用户上滚查看历史不受打扰）
        setMessages((prev) => {
          const id = msg.message.pinelBashId;
          if (id) {
            const idx = prev.findIndex((m) => m.pinelBashId === id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = msg.message;
              return next;
            }
          }
          stickToBottom.current = true;
          return [...prev, msg.message];
        });
        break;
      case "tool":
        setTools((prev) => ({ ...prev, [msg.tool.toolCallId]: msg.tool }));
        break;
      case "status":
        setStatus(msg.status);
        break;
      case "uiRequest":
        setPendingUi((prev) => [...prev, msg.request]);
        setFocusDialogId(msg.request.id); // 新卡片强制滚动+聚焦
        break;
      case "uiResolved":
        setPendingUi((prev) => prev.filter((r) => r.id !== msg.id));
        break;
      case "uiCleared":
        setPendingUi([]);
        break;
      case "todos":
        setTodos(msg.todos);
        break;
      case "commands":
        setCommands(msg.commands);
        break;
      case "models":
        // 空数组 = 拉取失败信号（宿主已 notice）：关闭模型 chip 下拉
        if (msg.models.length === 0) {
          setModelLoading(false);
          setPopover((prev) => (prev === "model" ? null : prev));
        } else {
          setModels(msg.models);
          setModelLoading(false);
        }
        break;
      case "thinkingLevels":
        if (msg.levels.length === 0) {
          setThinkingLoading(false);
          setPopover((prev) => (prev === "thinking" ? null : prev));
        } else {
          setThinkingLevels(msg.levels);
          setThinkingLoading(false);
        }
        break;
      case "questionnaire":
        setQuestionnaire(msg.questionnaire);
        setQnaFocusVersion((v) => v + 1); // 新问卷推送：触发聚焦（快照恢复不触发）
        // 答题/确认阶段的广播（含重入问卷——enterQuestionnaire 不广播
        // questionnaireCleared）：旧收起条位置作废，等提交时重新捕获
        if (msg.questionnaire.phase !== "submitting" && msg.questionnaire.phase !== "submitted") {
          setQnaFlowIndex(null);
        }
        break;
      case "questionnaireCleared":
        setQuestionnaire(null);
        setQnaFlowIndex(null);
        break;
      case "sessionSwitching":
        setSwitching(msg.switching);
        if (msg.switching) {
          setPopover(null); // 切换期间关闭弹窗（互斥枚举置空）
        }
        break;
      case "sessionListChanged":
        // 仅会话历史视图消费；聊天视图忽略
        break;
      case "sessionListRefresh":
        // 重命名/删除后的立即刷新信号：仅会话历史视图消费；聊天视图忽略
        //（弹层数据在宿主操作成功后由 panel 重拉 post sessionList 覆盖）
        break;
      case "sessionList":
        setSessionItems(msg.items);
        break;
      case "sessionStats":
        setSessionStats(msg.stats);
        break;
      case "ponytailStatus":
        setPonytailStatus(msg.status);
        break;
      case "pinelMcp":
        setPinelMcp(msg.mcp);
        break;
      case "pinelWorkflow":
        setPinelWorkflow(msg.workflow);
        break;
      case "pinelPrompt":
        setPinelPrompt(msg.prompt);
        break;
      case "pinelPluginState":
        setPinelPluginState(msg.state);
        break;
      case "sessionEnv":
        setSessionEnv(msg.env);
        break;
      case "fileList":
        setFileList(msg.items);
        break;
      case "forkMessages":
        setForkMessages(msg.messages);
        break;
      case "extensionList":
        setExtensions(msg.items);
        setUpdatingKeys(new Set()); // 更新流程后列表重发 = 清乐观忙态
        break;
      case "extensionUpdates":
        setUpdateEntries(msg.entries);
        setUpdatingKeys(new Set());
        break;
      case "catalogState":
        setCatalog(msg.entries);
        setInstalling(new Set()); // 安装回执已到：清除 busy 标记
        break;
      case "modeState":
        setModeState(msg.state);
        break;
      case "triggerEditPrompt":
        setEditPromptTrigger((v) => v + 1);
        break;
      case "fillPrompt":
        setFill((prev) => ({ seq: prev.seq + 1, text: msg.text }));
        break;
      case "sessionTitle":
        setSessionTitle(msg.title);
        break;
      case "notice": {
        const id = ++noticeSeq;
        setNotices((prev) => [...prev, { id, level: msg.level, text: msg.text }]);
        break;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    vscode.postMessage({ type: "ready" });
    // 挂载预热拉取文件列表：手打/粘贴 @引用 发送时解析依赖 fileList，
    // 不预热的场景（无 atTrigger 击键）fileList 可能为空导致引用静默丢失
    vscode.postMessage({ type: "getFileList" });
    // 预热拉取扩展列表：信息条 Extensions chip 常驻显示计数（装/卸/启停后宿主重推）
    vscode.postMessage({ type: "getExtensionList" });
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // 新对话框卡片：强制滚入视野 + 按方法聚焦输入/首选项（webview 不可见时跳过）
  useEffect(() => {
    if (!focusDialogId) {
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-dialog-id="${focusDialogId}"]`);
    if (el && document.hasFocus()) {
      el.scrollIntoView({ block: "nearest" });
      const target =
        el.querySelector<HTMLElement>("input, textarea") ?? el.querySelector<HTMLElement>("button");
      target?.focus();
      // 同步 stickToBottom（防后续消息更新把视图拉回或停住）
      const sc = scrollRef.current;
      if (sc) {
        stickToBottom.current = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
      }
    }
    setFocusDialogId(null);
  }, [focusDialogId]);

  const dismissNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // 自动滚动到底部（用户上滚查看历史时不打扰）；pendingUi 新卡片出现在
  // 流末尾时也滚动，确保对话框可见。useLayoutEffect：paint 前完成滚动，
  // 无中间帧错位；rAF 兕底：图片/字体等异步布局在首帧后仍可能增长，下一帧再校正。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) {
      return;
    }
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      if (stickToBottom.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, streamBlocks, tools, pendingUi]);

  // 消息列表变化（新回合/快照替换）后按当前滚动位置重算悬浮条显示目标。
  // 声明在自动滚动 effect 之后：先完成 scrollTop 赋值再读 rect，防瞬态错值（评审 S4）
  useEffect(() => {
    computeVisible();
  }, [computeVisible]);

  // 问卷提交后收起为一行状态条：捕获提交瞬间的消息数作为流内插入位置。
  // 答题/确认期间 agent 被对话框阻塞、无新 message 事件，消息数恒定；
  // 仅位置未知时捕获（同会话 agent_end 快照重放不移动已捕获位置）。
  useEffect(() => {
    if (
      questionnaire &&
      (questionnaire.phase === "submitting" || questionnaire.phase === "submitted") &&
      qnaFlowIndex === null
    ) {
      setQnaFlowIndex(messages.length);
    }
  }, [questionnaire, qnaFlowIndex, messages]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    // 仅用户滚动更新跟随态；锚定补偿/程序性滚动不碰 stickToBottom（见 markUserScrollIntent）
    if (userScrollIntent.current) {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }
    // 悬浮条随视口切换显示上下文用户消息；隐藏态重现判定（应显示消息离开
    // 视口 → 重现）已并入 computeVisible（函数式 setState，无陈旧闭包）
    computeVisible();
  }, [computeVisible]);

  const hasConversation = messages.length > 0 || streamBlocks.length > 0;

  /** 旧消息延迟渲染阈值：末尾 40 条保持完整渲染（回底/流式跟随落点精确），
   *  更早的消息套 .msg-stale（content-visibility 跳过离屏布局/绘制）。 */
  const staleCutoff = messages.length - 40;

  // 问卷提交后收起为一行状态条：插入消息流原位（最后一条已完成消息之后、
  // 流式气泡之上），后续消息（toolResult/流式回复）落在其下方随流上移——
  // 行为如正常消息。越界兜底（消息列表被重建且更短）：状态条回落末尾。
  const qnaCollapsed =
    questionnaire !== null &&
    (questionnaire.phase === "submitting" || questionnaire.phase === "submitted");
  const qnaMid =
    qnaFlowIndex !== null && qnaFlowIndex <= messages.length ? qnaFlowIndex : messages.length;

  // 启动动画（阶段 2）：pi 启动/重启期间且无会话内容；error（错误横幅）与
  // no-workspace（引导文案）态有各自 UI，不覆盖
  const showBootAnimation =
    !hasConversation && (status.processState === "starting" || status.processState === "stopped");

  // 模型/思考 chip 锚定下拉：toggle 打开并拉取列表（打开即清列表 + loading；
  // 关闭不重拉），选中后的状态回读刷新由宿主 set_model → get_state 链路负责
  const openModel = () => {
    if (popover === "model") {
      setPopover(null);
      return;
    }
    setPopover("model");
    setModelLoading(true);
    setModels([]);
    vscode.postMessage({ type: "getModels" });
  };

  const openThinking = () => {
    if (popover === "thinking") {
      setPopover(null);
      return;
    }
    setPopover("thinking");
    setThinkingLoading(true);
    setThinkingLevels([]);
    vscode.postMessage({ type: "getThinkingLevels" });
  };

  // 选中模型/思考：发 set 消息并关闭下拉（状态回读刷新由宿主链路广播）
  const selectModel = (provider: string, modelId: string) => {
    setPopover(null);
    vscode.postMessage({ type: "setModel", provider, modelId });
  };

  const selectThinkingLevel = (level: string) => {
    setPopover(null);
    vscode.postMessage({ type: "setThinkingLevel", level });
  };

  const openConfig = () => setPopover((prev) => (prev === "config" ? null : "config"));

  // 模式弹层：打开时拉取模式状态（实时扫描本地 skills + 读 pinel.modes）
  const openModes = () => {
    setPopover((prev) => (prev === "mode" ? null : "mode")); // 已开则关闭（toggle）
    vscode.postMessage({ type: "getModeState" });
  };
  const switchMode = (name: string | null) => {
    vscode.postMessage({ type: "switchMode", name });
  };
  const createMode = (name: string) => vscode.postMessage({ type: "createMode", name });
  const deleteMode = (name: string) => vscode.postMessage({ type: "deleteMode", name });
  const updateModeSkills = (name: string, skills: string[], extensions: string[]) =>
    vscode.postMessage({ type: "updateModeSkills", name, skills, extensions });

  // 会话历史弹层：打开时拉取最新列表（每次打开实时扫描）
  const openSessionList = () => {
    setPopover((prev) => (prev === "session" ? null : "session")); // 已开则关闭（toggle）
    setSessionItems([]);
    vscode.postMessage({ type: "getSessionList" });
  };

  // 分支选择器弹层：打开时拉取可 fork 消息（打开期间快照语义，不实时刷新）
  const openFork = () => {
    setPopover((prev) => (prev === "fork" ? null : "fork")); // 已开则关闭（toggle）
    setForkMessages([]);
    vscode.postMessage({ type: "getForkMessages" });
  };

  // 扩展管理弹层：打开时按当前视图拉取列表（每次打开实时扫描）+ 目录状态
  const openExtensions = () => {
    setPopover((prev) => (prev === "ext" ? null : "ext")); // 已开则关闭（toggle）
    // 不清空 extensions：信息条 chip 常驻显示，宿主重扫后整体替换
    // catalog 为本地视图：宿主按 all 刷新扩展列表（背景），目录状态单独拉
    vscode.postMessage({ type: "getExtensionList" });
    vscode.postMessage({ type: "checkExtensionUpdates", force: false });
    vscode.postMessage({ type: "getCatalogState" });
  };

  // 扩展弹层视图切换：catalog 本地视图只拉目录；All 发宿主重拉
  const changeExtensionView = (view: "all" | "catalog") => {
    setExtensionView(view);
    if (view === "catalog") {
      vscode.postMessage({ type: "getCatalogState" });
    } else {
      vscode.postMessage({ type: "getExtensionList" });
      vscode.postMessage({ type: "checkExtensionUpdates", force: false });
    }
  };

  // 更新检查：弹层打开/视图切换自动（force=false）；标题栏刷新按钮 force=true 绕过缓存
  const checkExtensionUpdates = (force: boolean) => {
    vscode.postMessage({ type: "checkExtensionUpdates", force });
  };

  // 单行 / 批量更新：乐观置忙，结果经 extensionList + extensionUpdates 回流清除
  const updateExtensionItem = (item: ExtensionItem) => {
    setUpdatingKeys((prev) => new Set(prev).add(extensionRowKey(item)));
    vscode.postMessage({
      type: "updateExtension",
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      source: item.source,
    });
  };

  const updateAllExtensionItems = (targets: ExtensionItem[]) => {
    setUpdatingKeys((prev) => {
      const next = new Set(prev);
      for (const i of targets) next.add(extensionRowKey(i));
      return next;
    });
    vscode.postMessage({
      type: "updateAllExtensions",
      entries: targets.map((i) => ({
        id: i.id,
        kind: i.kind,
        scope: i.scope,
        source: i.source,
      })),
    });
  };

  // 启停扩展：发 setExtensionEnabled（宿主执行后重发列表 + reload 提示）
  const toggleExtension = (item: ExtensionItem, enabled: boolean) => {
    vscode.postMessage({
      type: "setExtensionEnabled",
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      enabled,
    });
  };

  // 卸载扩展：发 uninstallExtension（宿主确认后执行 + 重发列表 + reload 提示）
  const uninstallExtension = (item: ExtensionItem) => {
    vscode.postMessage({
      type: "uninstallExtension",
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      source: item.source,
      name: item.name,
    });
  };

  // 选择会话/新会话：乐观置位 switching（controller 的 sessionSwitching 广播在
  // ensureStarted 之后才发，点击到广播之间需本地禁点防重开弹层——HistoryApp 同款）
  const selectSession = (path: string) => {
    setPopover(null);
    setSwitching(true);
    vscode.postMessage({ type: "switchSession", path });
  };

  /** header 新会话按钮（独立入口；弹层内已移除）。 */
  const headerNewSession = () => {
    setSwitching(true);
    vscode.postMessage({ type: "newSession" });
  };

  // 状态横幅：仅三类关键态显示（就绪/运行中/启动中静默）
  const banner =
    status.processState === "error" ? (
      <div className="status-banner status-banner-error">
        <span className="status-banner-text">✕ {status.error ?? "pi process error"}</span>
        <button className="status-banner-btn" onClick={() => vscode.postMessage({ type: "restart" })}>
          Restart
        </button>
      </div>
    ) : status.processState === "no-workspace" ? (
      <div className="status-banner status-banner-warn">
        <span className="status-banner-text">⚠ {status.error ?? "No folder open"}</span>
        <button className="status-banner-btn" onClick={() => vscode.postMessage({ type: "restart" })}>
          Retry
        </button>
      </div>
    ) : status.processState === "running" && status.model === null ? (
      <div className="status-banner status-banner-warn">
        <span className="status-banner-text">⚠ No model available, check pi auth then retry</span>
        <button className="status-banner-btn" onClick={() => vscode.postMessage({ type: "restart" })}>
          Restart
        </button>
      </div>
    ) : null;

  // 主会话模型短名/思考等级：subagent 卡片继承主会话时的兜底显示（name 优先于 id）
  const mainModelName = status.model ? (status.model.name ?? status.model.id ?? null) : null;
  const mainThinkingLevel = status.thinkingLevel;

  return (
    <div className="pinel-root">
      <div className="chat-header">
        <span className="chat-header-title" title={sessionTitle ?? "Untitled session"}>
          {sessionTitle ?? "Untitled session"}
        </span>
        <span className="chat-header-buttons">
          <button
            ref={forkBtnRef}
            className="chat-fork-btn"
            title="Fork from a previous message"
            aria-label="Fork from a previous message"
            aria-haspopup="dialog"
            aria-expanded={popover === "fork"}
            onClick={openFork}
            disabled={switching}
            dangerouslySetInnerHTML={{ __html: forkIcon }}
          />
          <button
            ref={historyBtnRef}
            className="chat-history-btn"
            title="Session history (click to switch)"
            aria-label="Session history"
            aria-haspopup="dialog"
            aria-expanded={popover === "session"}
            onClick={openSessionList}
            disabled={switching}
            dangerouslySetInnerHTML={{ __html: historyIcon }}
          />
          <button
            ref={newSessionBtnRef}
            className="chat-new-session-btn"
            title="New session"
            aria-label="New session"
            onClick={headerNewSession}
            disabled={switching}
            dangerouslySetInnerHTML={{ __html: newSessionIcon }}
          />
          <button
            className="chat-reload-btn"
            title="Reload pi (restart process, keep session)"
            aria-label="Reload pi"
            onClick={() => vscode.postMessage({ type: "restart" })}
            disabled={switching}
            dangerouslySetInnerHTML={{ __html: reloadIcon }}
          />
        </span>
        {/* 通知横幅：悬浮于 header 正下方（absolute 定位上下文 = chat-header，
            top:calc(100%+3px)，不挤压布局；见 styles.css .notices） */}
        <Notices notices={notices} onDismiss={dismissNotice} />
      </div>
      {showBootAnimation && (
        <div className="session-boot-overlay">
          <div className="boot-spinner" />
          <div className="session-boot-text">Starting Pi…</div>
        </div>
      )}
      {switching && (
        <div className="session-switch-overlay">
          <div className="boot-spinner" />
          <div className="session-boot-text">Switching session…</div>
        </div>
      )}
      <div
        className="pinel-scroll"
        ref={scrollRef}
        tabIndex={-1}
        onScroll={onScroll}
        onWheel={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        onTouchStart={markUserScrollIntent}
      >
        {/* 最近回合悬浮条：高 0 sticky 锚点钉在滚动视口顶部（不随内容滚走），
            宽度 = 滚动内容区宽 → 与消息卡片结构级严格同宽（见 styles.css
            .recent-round-anchor） */}
        <div className="recent-round-anchor">
          <RecentRoundBar lastUserText={!roundBarHidden ? roundBarText : ""} onLocate={locateLastUser} />
        </div>
        {!hasConversation && (
          <div className="pinel-empty">
            <div className="pinel-empty-title">Pinel — Pi for VS Code</div>
            <div className="pinel-empty-hint">
              Type a message below and the Pi coding agent will reply here.
              <br />
              Type / to autocomplete commands; paste images to attach; press Esc or click stop to interrupt streaming.
            </div>
          </div>
        )}
        {messages.slice(0, qnaMid).map((m, i) => (
          <MessageView key={`m-${i}`} message={m} tools={tools} toolResults={toolResults} msgIndex={i} mainModelName={mainModelName} mainThinkingLevel={mainThinkingLevel} stale={i < staleCutoff} />
        ))}
        {qnaCollapsed && questionnaire && (
          <Questionnaire questionnaire={questionnaire} focusVersion={qnaFocusVersion} />
        )}
        {messages.slice(qnaMid).map((m, i) => (
          <MessageView key={`m-${qnaMid + i}`} message={m} tools={tools} toolResults={toolResults} msgIndex={qnaMid + i} mainModelName={mainModelName} mainThinkingLevel={mainThinkingLevel} stale={qnaMid + i < staleCutoff} />
        ))}
        {streamBlocks.length > 0 && (
          <MessageView
            /* key = 落定后将获得的 m-${messages.length}：settle 同 key 原地切换到权威 content */
            key={`m-${messages.length}`}
            message={{ role: "assistant", content: [] }}
            streamBlocks={streamBlocks}
            tools={tools}
            toolResults={toolResults}
            mainModelName={mainModelName}
            mainThinkingLevel={mainThinkingLevel}
          />
        )}
        <UiDialogs requests={pendingUi} />
        {!qnaCollapsed && questionnaire && (
          <Questionnaire questionnaire={questionnaire} focusVersion={qnaFocusVersion} />
        )}
      </div>
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {banner}
      <div className="composer-stack">
        {/* 上下文状态条（Context 常驻 / Skills / Prompts / Extensions / MCP 计数 chip）：
            Context 占位态不隐藏；Extensions chip 兼任扩展管理入口 */}
        <ContextBar
          commands={commands}
          pinelMcp={pinelMcp}
          pinelPrompt={pinelPrompt}
          extensions={extensions}
          onOpenExtensions={openExtensions}
          extensionsOpen={popover === "ext"}
          extensionChipRef={extensionChipRef}
          modeName={status.modeName}
          modesOpen={popover === "mode"}
          onOpenModes={openModes}
          modeChipRef={modeChipRef}
        />
        <Composer
          status={status}
          commands={commands}
          popoverOpen={popover !== null}
          fill={fill}
          editPromptTrigger={editPromptTrigger}
          settingsOpen={popover === "config"}
          onOpenSettings={openConfig}
          modelOpen={popover === "model"}
          onOpenModel={openModel}
          modelChipRef={modelChipRef}
          thinkingOpen={popover === "thinking"}
          onOpenThinking={openThinking}
          thinkingChipRef={thinkingChipRef}
          fileList={fileList}
        />
        {status.showSessionStats && (
          <SessionStatsBar stats={sessionStats} env={sessionEnv} ponytailStatus={ponytailStatus} />
        )}
        <WorkflowBar workflow={pinelWorkflow} />
      </div>
      {/* key 随开合切换：每次打开重挂载，阈值输入 defaultValue 取最新回显（非受控免草稿态） */}
      <ConfigPopover
        key={popover === "config" ? "cfg-open" : "cfg-closed"}
        status={status}
        open={popover === "config"}
        onClose={() => setPopover(null)}
      />
      <ModelPopover
        anchor={popover === "model" ? modelChipRef.current : null}
        kind="model"
        models={models}
        modelLoading={modelLoading}
        thinkingLevels={thinkingLevels}
        thinkingLoading={thinkingLoading}
        currentModelKey={status.model ? `${status.model.provider ?? ""}:${status.model.id ?? ""}` : null}
        currentThinkingLevel={status.thinkingLevel}
        onSelectModel={selectModel}
        onSelectThinkingLevel={selectThinkingLevel}
        onClose={() => setPopover(null)}
      />
      <ModelPopover
        anchor={popover === "thinking" ? thinkingChipRef.current : null}
        kind="thinking"
        models={models}
        modelLoading={modelLoading}
        thinkingLevels={thinkingLevels}
        thinkingLoading={thinkingLoading}
        currentModelKey={null}
        currentThinkingLevel={status.thinkingLevel}
        onSelectModel={selectModel}
        onSelectThinkingLevel={selectThinkingLevel}
        onClose={() => setPopover(null)}
      />
      <SessionListPopover
        anchor={popover === "session" ? historyBtnRef.current : null}
        items={sessionItems}
        currentSessionFile={status.sessionFile}
        switching={switching}
        onSelect={selectSession}
        onClose={() => setPopover(null)}
      />
      <ModePopover
        anchor={popover === "mode" ? modeChipRef.current : null}
        state={modeState}
        onSwitch={switchMode}
        onCreate={createMode}
        onDelete={deleteMode}
        onUpdateSkills={updateModeSkills}
        onClose={() => setPopover(null)}
      />
      <ForkPopover
        anchor={popover === "fork" ? forkBtnRef.current : null}
        messages={forkMessages}
        switching={switching}
        onClose={() => setPopover(null)}
      />
      <ExtensionPopover
        anchor={popover === "ext" ? extensionChipRef.current : null}
        items={mergedExtensions}
        view={extensionView}
        pinelPluginState={pinelPluginState}
        catalog={catalog}
        installing={installing}
        updating={updatingKeys}
        onCheckUpdates={checkExtensionUpdates}
        onUpdate={updateExtensionItem}
        onUpdateAll={updateAllExtensionItems}
        onInstallPinelPlugin={() => vscode.postMessage({ type: "installPinelPlugin" })}
        onInstallCatalogEntry={(spec) => {
          setInstalling((prev) => new Set(prev).add(spec));
          vscode.postMessage({ type: "installCatalogEntry", spec });
        }}
        onInstallCatalogGroup={(group, specs) => {
          setInstalling((prev) => {
            const next = new Set(prev);
            for (const s of specs) next.add(s);
            return next;
          });
          vscode.postMessage({ type: "installCatalogGroup", group });
        }}
        onChangeView={changeExtensionView}
        onToggle={toggleExtension}
        onUninstall={uninstallExtension}
        onClose={() => setPopover(null)}
      />
    </div>
  );
}
