/**
 * Copilot 侧栏视图，交互对应 Obsidian Copilot 的 Quick Chat：
 * 顶栏有新对话、保存对话（关闭自动保存时）、对话记录和设置；中间为消息列表，生成时跟随滚动，
 * 向上翻阅时不打断；底部为输入区。
 */

import { useEffect, useRef, useState } from "react";
import { ArrowDown, History, MessageSquarePlus, Save, Settings, Trash2 } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { errorText } from "../../backend";
import { useSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";
import { iconSize } from "../../styles/tokens";
import { loadAiStatus } from "../settings/aiStatus";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { saveCurrentConversation, useCopilot } from "./copilotStore";
import { deleteConversation, listConversations, type ConversationFile } from "./history";

/** 距底部小于该像素数时视为「在底部」，新内容到达时继续跟随。 */
const FOLLOW_THRESHOLD_PX = 48;

function HistoryPopover({ onClose }: { onClose: () => void }) {
  const openConversation = useCopilot((state) => state.openConversation);
  const conversationPath = useCopilot((state) => state.conversationPath);
  const [items, setItems] = useState<ConversationFile[]>([]);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");

  const refresh = () => {
    void listConversations().then(setItems);
  };
  useEffect(refresh, []);

  const remove = async (item: ConversationFile) => {
    const confirmed = await ask(`删除对话「${item.title}」？该记录文件会被永久删除，无法恢复。`, {
      title: "删除对话",
      kind: "warning",
      okLabel: "删除",
      cancelLabel: "取消",
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteConversation(item.path);
      if (item.path === conversationPath) {
        useCopilot.setState({ conversationPath: null });
      }
      refresh();
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const visible = items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="dc-popover dc-history" role="dialog" aria-label="对话记录">
      <input className="dc-input" placeholder="搜索对话" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Escape" && onClose()} />
      {visible.length === 0 && <p className="dc-sidebar-empty">还没有保存的对话。</p>}
      <ul className="dc-history-list">
        {visible.map((item) => (
          <li key={item.path} className={item.path === conversationPath ? "is-active" : undefined}>
            <button
              type="button"
              className="dc-history-open"
              onClick={() => {
                void openConversation(item.path);
                onClose();
              }}
            >
              {item.title}
            </button>
            <button type="button" className="dc-icon-button" aria-label="删除对话" title="删除" onClick={() => void remove(item)}>
              <Trash2 size={iconSize.sm} />
            </button>
          </li>
        ))}
      </ul>
      {message && <p className="dc-status-line is-error">{message}</p>}
    </div>
  );
}

export function CopilotView() {
  const messages = useCopilot((state) => state.messages);
  const streamingId = useCopilot((state) => state.streamingId);
  const error = useCopilot((state) => state.error);
  const newChat = useCopilot((state) => state.newChat);
  const setModelLabel = useCopilot((state) => state.setModelLabel);
  const workspace = useAppStore((state) => state.workspace);
  const overlay = useAppStore((state) => state.overlay);
  const openSettings = useAppStore((state) => state.openSettings);
  const autosave = useSettings((state) => state.settings.copilot.autosave);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const [notice, setNotice] = useState("");
  const list = useRef<HTMLDivElement>(null);

  // 关闭设置后刷新模型名称，AI 连接可能已更改。
  useEffect(() => {
    if (overlay !== null) {
      return;
    }
    loadAiStatus()
      .then((status) => {
        const model = status.provider === "chatgpt" ? status.chatgpt_model : status.model;
        const provider = status.provider === "chatgpt" ? "ChatGPT" : "API";
        setModelLabel(model ? `${provider} · ${model}` : "");
      })
      .catch(() => setModelLabel(""));
  }, [overlay, setModelLabel]);

  useEffect(() => {
    const element = list.current;
    if (element && following) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, following]);

  const handleScroll = () => {
    const element = list.current;
    if (!element) {
      return;
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowing(distance < FOLLOW_THRESHOLD_PX);
  };

  const handleSave = async () => {
    try {
      const path = await saveCurrentConversation();
      setNotice(path ? "对话已保存。" : "没有可保存的对话。");
    } catch (failure) {
      setNotice(errorText(failure));
    }
  };

  return (
    <div className="dc-copilot">
      <div className="dc-copilot-bar">
        <button type="button" className="dc-icon-button" title="新对话" aria-label="新对话" disabled={streamingId !== null} onClick={() => {
          newChat();
          setNotice("");
        }}>
          <MessageSquarePlus size={iconSize.md} />
        </button>
        {!autosave && (
          <button type="button" className="dc-icon-button" title="保存对话为笔记" aria-label="保存对话为笔记" onClick={() => void handleSave()}>
            <Save size={iconSize.md} />
          </button>
        )}
        <button type="button" className="dc-icon-button" title="对话记录" aria-label="对话记录" disabled={!workspace} onClick={() => setHistoryOpen(!historyOpen)}>
          <History size={iconSize.md} />
        </button>
        <span className="dc-toolbar-spacer" />
        <button type="button" className="dc-icon-button" title="Copilot 设置" aria-label="Copilot 设置" onClick={() => openSettings("copilot")}>
          <Settings size={iconSize.md} />
        </button>
        {historyOpen && <HistoryPopover onClose={() => setHistoryOpen(false)} />}
      </div>

      <div className="dc-chat-list" ref={list} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="dc-chat-empty">
            <p>向 Copilot 提问，当前笔记会自动作为上下文。</p>
            <p>输入 / 使用命令，[[ 引用笔记；在编辑区选中文字可一并发送。</p>
          </div>
        ) : (
          messages.map((message) => <MessageItem key={message.id} message={message} />)
        )}
      </div>
      {!following && (
        <button type="button" className="dc-chat-follow" aria-label="滚动到最新" onClick={() => setFollowing(true)}>
          <ArrowDown size={iconSize.sm} />
        </button>
      )}
      {(error || notice) && <p className={`dc-status-line dc-copilot-status${error ? " is-error" : ""}`}>{error || notice}</p>}
      <Composer />
    </div>
  );
}
