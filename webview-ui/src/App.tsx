import { useCallback, useEffect, useRef, useState } from "react";
import { vscode } from "./index";
import type { ChatMessage, ChatStatus, HostMessage, ModelInfo, QuestionnaireView, SlashCommand, StreamBlock, TodoTask, ToolCard, UiRequest } from "./types";
import { Composer } from "./components/Composer";
import { ConfigPopover } from "./components/ConfigPopover";
import { ListPopover, type ListItem } from "./components/ListPopover";
import { MessageView } from "./components/MessageView";
import { Notices } from "./components/Notices";
import { StatusBar } from "./components/StatusBar";
import { TodoPanel } from "./components/TodoPanel";
import { UiDialogs } from "./components/UiDialogs";
import { Questionnaire } from "./components/Questionnaire";

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

/** 弹窗互斥：任一时刻只开一个（模型列表 / 思考强度列表 / ⚙ 设置面板）。 */
type PopoverKind = "model" | "thinking" | "config" | null;

/** 模型项复合键（Model.id 跨 provider 可能重复）。 */
function modelItemId(m: ModelInfo): string {
  return `${m.provider}:${m.id}`;
}

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
  /** 列表锚定：状态栏按钮元素引用（ListPopover 定位/焦点还原依赖）。 */
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const thinkingBtnRef = useRef<HTMLButtonElement>(null);
  /** 当前会话文件（快照替换语义：会话变化时清空本地 tools）。 */
  const sessionFileRef = useRef<string | undefined>(undefined);
  /** 会话切换/新建进行中（切换遮罩）。 */
  const [switching, setSwitching] = useState(false);
  /** 新对话框卡片 id：到达时强制滚动+聚焦（快照重放不触发）。 */
  const [focusDialogId, setFocusDialogId] = useState<string | null>(null);
  /** 问卷推送版本：每次收到 questionnaire 消息（非快照）自增，驱动问卷重新聚焦。 */
  const [qnaFocusVersion, setQnaFocusVersion] = useState(0);
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
        // 空数组 = 拉取失败信号（宿主已 notice）：关闭弹窗，不展示空列表
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

  // 模型列表：点击时拉取（每次点击重新请求，保证与 pi 配置同步）
  const openModelList = () => {
    setPopover((prev) => (prev === "model" ? null : "model")); // 已开则关闭（toggle）
    setModelLoading(true);
    setModels([]);
    vscode.postMessage({ type: "getModels" });
  };

  const openThinkingList = () => {
    setPopover((prev) => (prev === "thinking" ? null : "thinking"));
    setThinkingLoading(true);
    setThinkingLevels([]);
    vscode.postMessage({ type: "getThinkingLevels" });
  };

  const openConfig = () => setPopover((prev) => (prev === "config" ? null : "config"));

  const modelItems: ListItem[] = models.map((m) => ({
    id: modelItemId(m),
    label: m.name ?? m.id ?? "",
    detail: m.provider,
  }));

  const thinkingItems: ListItem[] = thinkingLevels.map((level) => ({ id: level, label: level }));

  const selectModel = (item: ListItem) => {
    setPopover(null);
    const selected = models.find((m) => modelItemId(m) === item.id);
    if (selected && typeof selected.provider === "string" && typeof selected.id === "string") {
      vscode.postMessage({ type: "setModel", provider: selected.provider, modelId: selected.id });
    }
  };

  const selectThinkingLevel = (item: ListItem) => {
    setPopover(null);
    vscode.postMessage({ type: "setThinkingLevel", level: item.id });
  };

  return (
    <div className="pinel-root">
      <Notices notices={notices} onDismiss={dismissNotice} />
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
      <Composer
        status={status}
        commands={commands}
        popoverOpen={popover !== null}
        onSettings={openConfig}
      />
      <StatusBar
        status={status}
        modelListOpen={popover === "model"}
        thinkingListOpen={popover === "thinking"}
        onOpenModelList={openModelList}
        onOpenThinkingList={openThinkingList}
        modelBtnRef={modelBtnRef}
        thinkingBtnRef={thinkingBtnRef}
      />
      <ListPopover
        anchor={popover === "model" ? modelBtnRef.current : null}
        items={modelItems}
        selectedId={status.model ? modelItemId(status.model) : null}
        loading={modelLoading}
        emptyText="无可用模型"
        onSelect={selectModel}
        onClose={() => setPopover(null)}
      />
      <ListPopover
        anchor={popover === "thinking" ? thinkingBtnRef.current : null}
        items={thinkingItems}
        selectedId={status.thinkingLevel}
        loading={thinkingLoading}
        emptyText="无可用思考强度"
        onSelect={selectThinkingLevel}
        onClose={() => setPopover(null)}
      />
      <ConfigPopover status={status} open={popover === "config"} onClose={() => setPopover(null)} />
    </div>
  );
}
