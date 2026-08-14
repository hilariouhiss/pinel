import { useCallback, useEffect, useRef, useState } from "react";
import { vscode } from "./index";
import type { ChatMessage, ChatStatus, HostMessage, QuestionnaireView, SlashCommand, StreamBlock, TodoTask, ToolCard, UiRequest } from "./types";
import { Composer } from "./components/Composer";
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
  steering: [],
  followUp: [],
};

let noticeSeq = 0;

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamBlocks, setStreamBlocks] = useState<StreamBlock[]>([]);
  const [tools, setTools] = useState<Record<string, ToolCard>>({});
  const [status, setStatus] = useState<ChatStatus>(initialStatus);
  const [pendingUi, setPendingUi] = useState<UiRequest[]>([]);
  const [todos, setTodos] = useState<TodoTask[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [questionnaire, setQuestionnaire] = useState<QuestionnaireView | null>(null);
  /** 新对话框卡片 id：到达时强制滚动+聚焦（快照重放不触发）。 */
  const [focusDialogId, setFocusDialogId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Array<{ id: number; level: string; text: string }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const handleMessage = useCallback((event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case "snapshot":
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
      case "questionnaire":
        setQuestionnaire(msg.questionnaire);
        break;
      case "questionnaireCleared":
        setQuestionnaire(null);
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

  return (
    <div className="pinel-root">
      <Notices notices={notices} onDismiss={dismissNotice} />
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
        {questionnaire && <Questionnaire questionnaire={questionnaire} />}
      </div>
      {todos.length > 0 && <TodoPanel todos={todos} />}
      <Composer status={status} commands={commands} />
      <StatusBar status={status} />
    </div>
  );
}
