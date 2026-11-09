/**
 * Quick Ask 与命令结果面板，对应 Obsidian Copilot 的 Quick Ask / 编辑器命令。
 *
 * 不打开对话侧栏，直接就选区或当前位置提问；从右键菜单运行命令时自动以该命令的提示词提问。
 * 回答可复制、插入到光标处或替换原选区，也可以在面板内继续追问。
 */

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Copy, Replace, Send, Square, X } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { errorText } from "../../backend";
import { currentSelection, type EditorSelection } from "../../editor/editorCommands";
import { getEditor, insertMarkdownAt, replaceRangeWithMarkdown } from "../../editor/editorHandle";
import { getSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";
import { iconSize } from "../../styles/tokens";
import { streamChat, type ApiMessage, type ChatRequest } from "./chatClient";
import { buildContextBlock, composeSystemPrompt, type ContextItem } from "./context";
import { renderPrompt } from "./customCommands";
import { useCopilot } from "./copilotStore";
import { renderMarkdown } from "./markdownRender";

interface Turn {
  question: string;
  answer: string;
  error?: string;
}

function Answer({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) {
      renderMarkdown(text, ref.current);
    }
  }, [text]);
  return <div ref={ref} className="dc-chat-markdown dc-document" />;
}

export function QuickAsk({ commandName }: { commandName?: string }) {
  const setOverlay = useAppStore((state) => state.setOverlay);
  const filePath = useAppStore((state) => state.filePath);
  const commands = useCopilot((state) => state.commands);
  // 打开面板时记下选区与光标，之后编辑器失焦也能插入或替换到原处。
  const [origin] = useState<{ selection: EditorSelection | null; cursor: number }>(() => {
    const selection = currentSelection();
    const cursor = getEditor()?.state.selection.to ?? 0;
    return { selection, cursor };
  });
  const [includeNote, setIncludeNote] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const request = useRef<ChatRequest | null>(null);
  const started = useRef(false);
  // 命令提示词已展开选区内容时，不再把选区作为上下文重复发送；替换选区仍以原选区为准。
  const selectionInPrompt = useRef(false);

  const close = () => {
    void request.current?.cancel();
    setOverlay(null);
    getEditor()?.commands.focus();
  };

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setNotice("");
    setQuestion("");
    const index = turns.length;
    setTurns((previous) => [...previous, { question: trimmed, answer: "" }]);
    try {
      const items: ContextItem[] = [];
      if (origin.selection && filePath && !selectionInPrompt.current) {
        items.push({ kind: "selection", path: filePath, text: origin.selection.text });
      }
      if (includeNote && filePath) {
        items.push({ kind: "activeNote", path: filePath });
      }
      // 上下文只随第一问发送一次，追问沿用对话历史。
      const contextBlock = index === 0 ? await buildContextBlock(items, []) : "";
      const history: ApiMessage[] = [];
      for (const turn of turns) {
        history.push({ role: "user", content: turn.question });
        if (turn.answer) {
          history.push({ role: "assistant", content: turn.answer });
        }
      }
      const content = contextBlock ? `${trimmed}\n\n${contextBlock}` : trimmed;
      history.push({ role: "user", content });
      const system = composeSystemPrompt(getSettings().copilot.systemPrompt);
      const append = (delta: string) => {
        setTurns((previous) => previous.map((turn, position) => (position === index ? { ...turn, answer: turn.answer + delta } : turn)));
      };
      const current = streamChat(system, history, append);
      request.current = current;
      await current.done;
    } catch (error) {
      const message = errorText(error);
      setTurns((previous) => previous.map((turn, position) => (position === index ? { ...turn, error: message } : turn)));
    } finally {
      request.current = null;
      setBusy(false);
    }
  };

  // 从命令进入时，展开命令提示词后自动提问。
  useEffect(() => {
    if (!commandName || started.current) {
      return;
    }
    const command = commands.find((item) => item.name === commandName);
    if (!command) {
      return;
    }
    started.current = true;
    void renderPrompt(command.prompt, { selection: origin.selection?.text ?? null, activeNotePath: filePath }).then((prompt) => {
      selectionInPrompt.current = true;
      void ask(prompt);
    });
  }, [commandName, commands]);

  const last = turns[turns.length - 1];
  const finished = last && !busy && last.answer && !last.error;

  const replace = () => {
    if (!last || !origin.selection) {
      return;
    }
    const { from, to, text } = origin.selection;
    const replaced = replaceRangeWithMarkdown(from, to, text, last.answer);
    if (!replaced) {
      setNotice("原选区已被修改，无法安全替换。可以复制回答后手动粘贴。");
      return;
    }
    close();
  };

  return (
    <div className="dc-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}>
      <div className="dc-dialog dc-quick-ask" role="dialog" aria-label={commandName ? `命令：${commandName}` : "Quick Ask"}>
        <header className="dc-dialog-header">
          <h2 className="dc-dialog-title">{commandName ? commandName : "Quick Ask"}</h2>
          <button type="button" className="dc-icon-button" aria-label="关闭" onClick={close}>
            <X size={iconSize.md} />
          </button>
        </header>
        <div className="dc-dialog-body">
          {origin.selection && <blockquote className="dc-note-quote is-static">{origin.selection.text}</blockquote>}
          {turns.map((turn, index) => (
            <div key={index} className="dc-quick-turn">
              {!(commandName && index === 0) && <p className="dc-quick-question">{turn.question}</p>}
              {turn.answer ? <Answer text={turn.answer} /> : busy && index === turns.length - 1 && <span className="dc-chat-typing">正在生成…</span>}
              {turn.error && <p className="dc-status-line is-error">{turn.error}</p>}
            </div>
          ))}
          {notice && <p className="dc-status-line is-warning">{notice}</p>}
          <div className="dc-quick-input">
            <textarea
              className="dc-input dc-textarea"
              placeholder={turns.length === 0 ? (origin.selection ? "就选中的内容提问或给出改写要求" : "提问") : "继续追问"}
              autoFocus={!commandName}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void ask(question);
                }
                if (event.key === "Escape") {
                  close();
                }
              }}
            />
            <label className="dc-check" title="把整篇当前笔记作为上下文">
              <input type="checkbox" checked={includeNote} disabled={turns.length > 0} onChange={(event) => setIncludeNote(event.target.checked)} />
              附带整篇笔记
            </label>
          </div>
        </div>
        <footer className="dc-dialog-footer">
          {busy ? (
            <button type="button" className="dc-button" onClick={() => void request.current?.cancel()}>
              <Square size={iconSize.sm} />
              停止
            </button>
          ) : (
            <>
              {finished && (
                <>
                  <button type="button" className="dc-button" onClick={() => void writeClipboard(last.answer)}>
                    <Copy size={iconSize.sm} />
                    复制
                  </button>
                  <button
                    type="button"
                    className="dc-button"
                    onClick={() => {
                      insertMarkdownAt(origin.cursor, last.answer);
                      close();
                    }}
                  >
                    <ArrowDownToLine size={iconSize.sm} />
                    插入到光标处
                  </button>
                  {origin.selection && (
                    <button type="button" className="dc-button is-primary" onClick={replace}>
                      <Replace size={iconSize.sm} />
                      替换选区
                    </button>
                  )}
                </>
              )}
              <button type="button" className="dc-button is-primary" disabled={!question.trim()} onClick={() => void ask(question)}>
                <Send size={iconSize.sm} />
                {turns.length === 0 ? "提问" : "追问"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
