import { useCallback, useEffect, useRef, useState } from "react";
import { vscode } from "./index";
import type { ChatMessage, ChatStatus, FileItem, HostMessage, ModelInfo, QuestionnaireView, SessionListItem, SlashCommand, StreamBlock, TodoTask, ToolCard, UiRequest } from "./types";
import { Composer } from "./components/Composer";
import { ConfigPopover } from "./components/ConfigPopover";
import { SessionListPopover } from "./components/SessionListPopover";
import { MessageView } from "./components/MessageView";
import { Notices } from "./components/Notices";
import { TodoPanel } from "./components/TodoPanel";
import { UiDialogs } from "./components/UiDialogs";
import { Questionnaire } from "./components/Questionnaire";
// SVG 图标原始文本（esbuild text loader 内联；CSS 覆盖 fill 实现主题自适应）
import historyIcon from "../../media/history.svg";
import newSessionIcon from "../../media/new-session.svg";

const initialStatus: ChatStatus = {
  processState: "stopped",
  isStreaming: false,
  isCompacting: false,
  model: null,
  thinkingLevel: "medium",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  steering: [],
  followUp: [],
};

let noticeSeq = 0;

/** 弹窗互斥：任一时刻只开一个（⚙ 设置面板 / 会话历史）。 */
type PopoverKind = "config" | "session" | null;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamBlocks, setStreamBlocks] = useState<StreamBlock[]>([]);
  const [tools, setTools] = useState<Record<string, ToolCard>>({});
  const [status, setStatus] = useState<ChatStatus>(initialStatus);
  const [pendingUi, setPendingUi] = useState<UiRequest[]>([]);
  const [todos, setTodos] = useState<TodoTask[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [questionnaire, setQuestionnaire] = useState<QuestionnaireView | null>(null);
  /** 弹窗互斥状态（模型列表 / 思考强度列表 / ⚙ 设置面板）。 */
  const [popover, setPopover] = useState<PopoverKind>(null);
  /** 模型列表数据与加载态（宿主 models 消息填充；空数组 = 失败信号，关闭弹窗）。 */
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  /** 思考强度列表数据与加载态。 */
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [thinkingLoading, setThinkingLoading] = useState(false);
  /** 设置面板内嵌展开区（模型/思考；null=收起）。 */
  const [expandedSection, setExpandedSection] = useState<"model" | "thinking" | null>(null);
  /** 会话历史按钮元素引用（SessionListPopover 锚定）。 */
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  /** 新会话按钮元素引用（锚定不需要，与 historyBtnRef 同组）。 */
  const newSessionBtnRef = useRef<HTMLButtonElement>(null);
  /** 会话历史列表（header 弹层数据；getSessionList 响应填充）。 */
  const [sessionItems, setSessionItems] = useState<SessionListItem[]>([]);
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
  /** Ctrl+G 编辑器保存回填（seq 递增驱动 Composer 重复回填）。 */
  const [fill, setFill] = useState<{ seq: number; text: string }>({ seq: 0, text: "" });
  /** Ctrl+G 命令触发版本（宿主 pinel.editPrompt 命令广播；webview 取输入内容发起编辑）。 */
  const [editPromptTrigger, setEditPromptTrigger] = useState(0);
  const [notices, setNotices] = useState<Array<{ id: number; level: string; text: string }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const handleMessage = useCallback((event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case "snapshot":
        // 快照替换语义：会话文件变化（切换/新建/重启后）→ 清空本地工具卡片
        //（旧 toolCallId 可能在新会话同 id 消息上错配工具卡片）
        if (msg.status.sessionFile !== sessionFileRef.current) {
          setTools({});
          sessionFileRef.current = msg.status.sessionFile;
        }
        setMessages(msg.messages);
        setStreamBlocks([]);
        setStatus(msg.status);
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
        setMessages((prev) => [...prev, msg.message]);
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
        // 空数组 = 拉取失败信号（宿主已 notice）：收起内嵌展开区（面板保持打开）
        if (msg.models.length === 0) {
          setModelLoading(false);
          setExpandedSection((prev) => (prev === "model" ? null : prev));
        } else {
          setModels(msg.models);
          setModelLoading(false);
        }
        break;
      case "thinkingLevels":
        if (msg.levels.length === 0) {
          setThinkingLoading(false);
          setExpandedSection((prev) => (prev === "thinking" ? null : prev));
        } else {
          setThinkingLevels(msg.levels);
          setThinkingLoading(false);
        }
        break;
      case "questionnaire":
        setQuestionnaire(msg.questionnaire);
        setQnaFocusVersion((v) => v + 1); // 新问卷推送：触发聚焦（快照恢复不触发）
        break;
      case "questionnaireCleared":
        setQuestionnaire(null);
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
      case "sessionList":
        setSessionItems(msg.items);
        break;
      case "fileList":
        setFileList(msg.items);
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
  // 流末尾时也滚动，确保对话框可见
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamBlocks, tools, pendingUi]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const hasConversation = messages.length > 0 || streamBlocks.length > 0;

  // 启动动画（阶段 2）：pi 启动/重启期间且无会话内容；error（错误横幅）与
  // no-workspace（引导文案）态有各自 UI，不覆盖
  const showBootAnimation =
    !hasConversation && (status.processState === "starting" || status.processState === "stopped");

  // 设置面板内嵌列表展开：模型/思考（toggle；展开时拉取数据）
  const toggleExpandedSection = (section: "model" | "thinking" | null) => {
    setExpandedSection((prev) => {
      const next = section === prev ? null : section;
      if (next === "model") {
        setModelLoading(true);
        setModels([]);
        vscode.postMessage({ type: "getModels" });
      } else if (next === "thinking") {
        setThinkingLoading(true);
        setThinkingLevels([]);
        vscode.postMessage({ type: "getThinkingLevels" });
      }
      return next;
    });
  };

  // 选中模型/思考：发 set 消息，面板保持打开、仅收起展开区
  const selectModel = (provider: string, modelId: string) => {
    setExpandedSection(null);
    vscode.postMessage({ type: "setModel", provider, modelId });
  };

  const selectThinkingLevel = (level: string) => {
    setExpandedSection(null);
    vscode.postMessage({ type: "setThinkingLevel", level });
  };

  const openConfig = () => setPopover((prev) => (prev === "config" ? null : "config"));

  // 会话历史弹层：打开时拉取最新列表（每次打开实时扫描）
  const openSessionList = () => {
    setPopover((prev) => (prev === "session" ? null : "session")); // 已开则关闭（toggle）
    setSessionItems([]);
    vscode.postMessage({ type: "getSessionList" });
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
        <span className="status-banner-text">✕ {status.error ?? "pi 进程异常"}</span>
        <button className="status-banner-btn" onClick={() => vscode.postMessage({ type: "restart" })}>
          重启
        </button>
      </div>
    ) : status.processState === "no-workspace" ? (
      <div className="status-banner status-banner-warn">
        <span className="status-banner-text">⚠ {status.error ?? "未打开文件夹"}</span>
        <button className="status-banner-btn" onClick={() => vscode.postMessage({ type: "restart" })}>
          重试
        </button>
      </div>
    ) : status.processState === "running" && status.model === null ? (
      <div className="status-banner status-banner-warn">
        <span className="status-banner-text">⚠ 无可用模型，请检查 pi 认证后重试</span>
        <button className="status-banner-btn" onClick={() => vscode.postMessage({ type: "restart" })}>
          重启
        </button>
      </div>
    ) : null;

  return (
    <div className="pinel-root">
      <Notices notices={notices} onDismiss={dismissNotice} />
      <div className="chat-header">
        <span className="chat-header-title" title={sessionTitle ?? "未命名会话"}>
          {sessionTitle ?? "未命名会话"}
        </span>
        <span className="chat-header-buttons">
          <button
            ref={historyBtnRef}
            className="chat-history-btn"
            title="会话历史（点击选择切换会话）"
            aria-label="会话历史"
            aria-haspopup="dialog"
            aria-expanded={popover === "session"}
            onClick={openSessionList}
            disabled={switching}
            dangerouslySetInnerHTML={{ __html: historyIcon }}
          />
          <button
            ref={newSessionBtnRef}
            className="chat-new-session-btn"
            title="新会话"
            aria-label="新会话"
            onClick={headerNewSession}
            disabled={switching}
            dangerouslySetInnerHTML={{ __html: newSessionIcon }}
          />
        </span>
      </div>
      {showBootAnimation && (
        <div className="session-boot-overlay">
          <div className="boot-spinner" />
          <div className="session-boot-text">正在启动 Pi…</div>
        </div>
      )}
      {switching && (
        <div className="session-switch-overlay">
          <div className="boot-spinner" />
          <div className="session-boot-text">正在切换会话…</div>
        </div>
      )}
      <div className="pinel-scroll" ref={scrollRef} onScroll={onScroll}>
        {!hasConversation && (
          <div className="pinel-empty">
            <div className="pinel-empty-title">Pinel — Pi for VS Code</div>
            <div className="pinel-empty-hint">
              在下方输入消息，Pi 编码智能体将在这里流式回复。
              <br />
              输入 / 可补全命令；支持粘贴图片；流式输出中按 Esc 或点击停止可中断。
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView key={`m-${i}`} message={m} tools={tools} />
        ))}
        {streamBlocks.length > 0 && (
          <MessageView
            key="streaming"
            message={{ role: "assistant", content: [] }}
            streamBlocks={streamBlocks}
            tools={tools}
          />
        )}
        <UiDialogs requests={pendingUi} />
        {questionnaire && <Questionnaire questionnaire={questionnaire} focusVersion={qnaFocusVersion} />}
      </div>
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {banner}
      <Composer
        status={status}
        commands={commands}
        popoverOpen={popover !== null}
        fill={fill}
        editPromptTrigger={editPromptTrigger}
        settingsOpen={popover === "config"}
        onOpenSettings={openConfig}
        fileList={fileList}
      />
      <ConfigPopover
        status={status}
        open={popover === "config"}
        onClose={() => setPopover(null)}
        models={models}
        modelLoading={modelLoading}
        thinkingLevels={thinkingLevels}
        thinkingLoading={thinkingLoading}
        expandedSection={expandedSection}
        onToggleSection={toggleExpandedSection}
        onSelectModel={selectModel}
        onSelectThinkingLevel={selectThinkingLevel}
      />
      <SessionListPopover
        anchor={popover === "session" ? historyBtnRef.current : null}
        items={sessionItems}
        currentSessionFile={status.sessionFile}
        switching={switching}
        onSelect={selectSession}
        onClose={() => setPopover(null)}
      />
    </div>
  );
}
