/**
 * 单条对话消息。悬停显示操作：
 * 用户消息：复制、编辑、删除；回答：插入或替换到光标处、复制、重新生成、删除。
 */

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Copy, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { insertMarkdown, revealText } from "../../editor/editorHandle";
import { openDocument } from "../../documentActions";
import { joinPath } from "../../paths";
import { useAppStore } from "../../store";
import { iconSize } from "../../styles/tokens";
import { renderMarkdown } from "./markdownRender";
import { useCopilot, type ChatMessage } from "./copilotStore";
import type { SearchSource } from "./context";

function MarkdownBody({ text, streaming }: { text: string; streaming: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) {
      renderMarkdown(text, ref.current);
    }
  }, [text]);
  return (
    <div
      ref={ref}
      className={`dc-chat-markdown dc-document${streaming ? " is-streaming" : ""}`}
      onClick={(event) => {
        // 回答中的链接不在应用窗口内跳转。
        if ((event.target as HTMLElement).closest("a")) {
          event.preventDefault();
        }
      }}
    />
  );
}

function Sources({ sources }: { sources: SearchSource[] }) {
  const workspace = useAppStore((state) => state.workspace);
  if (sources.length === 0 || !workspace) {
    return null;
  }
  const jump = async (source: SearchSource) => {
    const opened = await openDocument(joinPath(workspace, source.path));
    if (!opened) {
      return;
    }
    const firstLine = source.excerpt.split("\n")[0] ?? "";
    // 摘录取自 Markdown 原文，去掉行首的标题、列表和引用标记后在正文中查找。
    const probe = firstLine.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").slice(0, 40);
    window.setTimeout(() => revealText(probe), 0);
  };
  return (
    <details className="dc-chat-sources">
      <summary>来源 {sources.length} 条</summary>
      <ul>
        {sources.map((source) => (
          <li key={source.id}>
            <button type="button" className="dc-link-button" onClick={() => void jump(source)} title={source.excerpt}>
              [{source.id}] {source.path}:{source.line}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function MessageItem({ message }: { message: ChatMessage }) {
  const streamingId = useCopilot((state) => state.streamingId);
  const regenerate = useCopilot((state) => state.regenerate);
  const editUserMessage = useCopilot((state) => state.editUserMessage);
  const deleteMessage = useCopilot((state) => state.deleteMessage);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [expanded, setExpanded] = useState(false);
  const streaming = streamingId === message.id;
  const busy = streamingId !== null;
  const isUser = message.role === "user";
  const longUserMessage = isUser && message.text.split("\n").length > 12;

  const copy = () => void writeClipboard(message.text);

  if (editing) {
    return (
      <div className="dc-chat-message is-user">
        <textarea className="dc-input dc-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />
        <div className="dc-row-actions">
          <button type="button" className="dc-button" onClick={() => setEditing(false)}>
            取消
          </button>
          <button
            type="button"
            className="dc-button is-primary"
            disabled={!draft.trim() || busy}
            onClick={() => {
              setEditing(false);
              void editUserMessage(message.id, draft);
            }}
          >
            保存并重新发送
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`dc-chat-message ${isUser ? "is-user" : "is-assistant"}`}>
      {isUser && message.contextLabels.length > 0 && (
        <div className="dc-chat-context-line">
          {message.contextLabels.map((label) => (
            <span key={label} className="dc-chip is-static">
              {label}
            </span>
          ))}
        </div>
      )}
      <div className={longUserMessage && !expanded ? "dc-chat-clamp" : undefined}>
        {message.text ? <MarkdownBody text={message.text} streaming={streaming} /> : streaming && <span className="dc-chat-typing">正在生成…</span>}
      </div>
      {longUserMessage && (
        <button type="button" className="dc-link-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : "显示全部"}
        </button>
      )}
      {message.error && <p className="dc-status-line is-error">{message.error}</p>}
      {!isUser && <Sources sources={message.sources} />}
      {!streaming && (
        <div className="dc-chat-actions">
          {!isUser && message.text && (
            <button type="button" className="dc-icon-button" title="插入或替换到光标处" aria-label="插入或替换到光标处" onClick={() => insertMarkdown(message.text)}>
              <ArrowDownToLine size={iconSize.sm} />
            </button>
          )}
          <button type="button" className="dc-icon-button" title="复制" aria-label="复制" onClick={copy}>
            <Copy size={iconSize.sm} />
          </button>
          {isUser ? (
            <button type="button" className="dc-icon-button" title="编辑" aria-label="编辑" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil size={iconSize.sm} />
            </button>
          ) : (
            <button type="button" className="dc-icon-button" title="重新生成" aria-label="重新生成" disabled={busy} onClick={() => void regenerate(message.id)}>
              <RefreshCw size={iconSize.sm} />
            </button>
          )}
          <button type="button" className="dc-icon-button" title="删除" aria-label="删除" disabled={busy} onClick={() => deleteMessage(message.id)}>
            <Trash2 size={iconSize.sm} />
          </button>
        </div>
      )}
    </div>
  );
}
