/**
 * Copilot 输入区。
 *
 * - 上方徽标显示将随消息发送的上下文：当前笔记（常驻，可移除）、选区和手动添加的笔记（仅下一条）。
 * - 「+」或输入 @ 添加上下文；输入 [[ 引用笔记；在开头输入 / 选择保存的命令。
 * - Enter 发送（可在设置中改为 Shift+Enter），生成中显示停止按钮。
 */

import { useMemo, useRef, useState } from "react";
import { FileText, Plus, Search, Send, Square, TextSelect, X } from "lucide-react";
import { noteTitle, relativePath } from "../../paths";
import { useSettings } from "../../settings/settingsStore";
import { useAppStore, workspaceFiles } from "../../store";
import { iconSize } from "../../styles/tokens";
import { contextLabel, type ContextItem } from "./context";
import { useCopilot } from "./copilotStore";

const SUGGESTION_LIMIT = 30;

type Suggestion =
  | { kind: "command"; name: string; prompt: string }
  | { kind: "note"; path: string }
  | { kind: "activeNote"; path: string };

interface Trigger {
  type: "slash" | "wiki" | "at";
  query: string;
  start: number;
}

/** 找出光标前正在输入的触发符：开头的 /、未闭合的 [[、或 @。 */
function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = before.match(/^\/([^\s]*)$/);
  if (slash) {
    return { type: "slash", query: slash[1], start: 0 };
  }
  const wiki = before.match(/\[\[([^\]\n]*)$/);
  if (wiki && wiki.index !== undefined) {
    return { type: "wiki", query: wiki[1], start: wiki.index };
  }
  const at = before.match(/(^|\s)@([^\s@]*)$/);
  if (at && at.index !== undefined) {
    return { type: "at", query: at[2], start: at.index + at[1].length };
  }
  return null;
}

function Badge({ item, onRemove }: { item: ContextItem; onRemove: () => void }) {
  const icon = item.kind === "selection" ? <TextSelect size={iconSize.sm} /> : <FileText size={iconSize.sm} />;
  const hint = item.kind === "activeNote" ? "当前笔记" : item.kind === "selection" ? "选区" : "笔记";
  return (
    <span className="dc-chip" title={`${hint}：${item.path}`}>
      {icon}
      <span className="dc-chip-label">{contextLabel(item)}</span>
      {item.kind === "activeNote" && <span className="dc-chip-hint">当前</span>}
      <button type="button" className="dc-chip-remove" aria-label="移除上下文" onClick={onRemove}>
        <X size={iconSize.sm} />
      </button>
    </span>
  );
}

export function Composer() {
  const draft = useCopilot((state) => state.draft);
  const setDraft = useCopilot((state) => state.setDraft);
  const selection = useCopilot((state) => state.selection);
  const setSelection = useCopilot((state) => state.setSelection);
  const attachments = useCopilot((state) => state.attachments);
  const addAttachment = useCopilot((state) => state.addAttachment);
  const removeAttachment = useCopilot((state) => state.removeAttachment);
  const activeNoteDetached = useCopilot((state) => state.activeNoteDetached);
  const detachActiveNote = useCopilot((state) => state.detachActiveNote);
  const commands = useCopilot((state) => state.commands);
  const streamingId = useCopilot((state) => state.streamingId);
  const modelLabel = useCopilot((state) => state.modelLabel);
  const send = useCopilot((state) => state.send);
  const stop = useCopilot((state) => state.stop);
  const filePath = useAppStore((state) => state.filePath);
  const workspace = useAppStore((state) => state.workspace);
  const tree = useAppStore((state) => state.tree);
  const openSettings = useAppStore((state) => state.openSettings);
  const copilotSettings = useSettings((state) => state.settings.copilot);
  const updateSettings = useSettings((state) => state.update);

  const textarea = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const files = useMemo(() => workspaceFiles(tree), [tree]);
  const showActiveNote = Boolean(filePath && copilotSettings.autoAttachActiveNote && !activeNoteDetached);

  const suggestions = useMemo<Suggestion[]>(() => {
    const query = (pickerOpen ? pickerQuery : trigger?.query ?? "").toLowerCase();
    if (!pickerOpen && !trigger) {
      return [];
    }
    if (trigger?.type === "slash" && !pickerOpen) {
      return commands
        .filter((command) => command.showInSlashMenu && command.name.toLowerCase().includes(query))
        .slice(0, SUGGESTION_LIMIT)
        .map((command) => ({ kind: "command", name: command.name, prompt: command.prompt }));
    }
    const notes: Suggestion[] = files
      .filter((path) => noteTitle(path).toLowerCase().includes(query) || (workspace && relativePath(workspace, path).toLowerCase().includes(query)))
      .slice(0, SUGGESTION_LIMIT)
      .map((path) => ({ kind: "note", path }));
    const offerActive = (pickerOpen || trigger?.type === "at") && filePath && !showActiveNote && "当前笔记".includes(query);
    return offerActive && filePath ? [{ kind: "activeNote", path: filePath }, ...notes] : notes;
  }, [trigger, pickerOpen, pickerQuery, commands, files, workspace, filePath, showActiveNote]);

  const updateTrigger = (text: string, caret: number) => {
    const found = findTrigger(text, caret);
    setTrigger(found);
    setHighlight(0);
  };

  const replaceTrigger = (replacement: string) => {
    if (!trigger) {
      return;
    }
    const caret = textarea.current?.selectionStart ?? draft.length;
    const next = draft.slice(0, trigger.start) + replacement + draft.slice(caret);
    setDraft(next);
    setTrigger(null);
    const position = trigger.start + replacement.length;
    window.setTimeout(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(position, position);
    }, 0);
  };

  const choose = (suggestion: Suggestion) => {
    if (suggestion.kind === "command") {
      replaceTrigger(`/${suggestion.name} `);
      return;
    }
    if (suggestion.kind === "activeNote") {
      detachActiveNote(false);
    } else if (trigger?.type === "wiki" && !pickerOpen) {
      replaceTrigger(`[[${noteTitle(suggestion.path)}]] `);
      return;
    } else {
      addAttachment({ kind: "note", path: suggestion.path });
    }
    if (trigger?.type === "at" && !pickerOpen) {
      replaceTrigger("");
    }
    setPickerOpen(false);
    setPickerQuery("");
    textarea.current?.focus();
  };

  const submit = () => {
    setTrigger(null);
    void send(draft);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (suggestions.length > 0 && trigger) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((highlight + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((highlight - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(suggestions[highlight]);
        return;
      }
    }
    if (event.key === "Escape" && trigger) {
      event.preventDefault();
      setTrigger(null);
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    const sendWithShift = copilotSettings.sendShortcut === "shift-enter";
    if (sendWithShift === event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      submit();
    }
  };

  const suggestionTitle = pickerOpen ? "添加上下文" : trigger?.type === "slash" ? "命令" : trigger?.type === "wiki" ? "引用笔记" : "添加上下文";
  const showSuggestions = (pickerOpen || trigger !== null) && (pickerOpen || suggestions.length > 0);

  return (
    <div className="dc-composer">
      {showSuggestions && (
        <div className="dc-suggestions" role="listbox" aria-label={suggestionTitle}>
          <div className="dc-suggestions-title">{suggestionTitle}</div>
          {pickerOpen && (
            <input
              className="dc-input"
              placeholder="搜索笔记"
              autoFocus
              value={pickerQuery}
              onChange={(event) => setPickerQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setPickerOpen(false);
                }
                if (event.key === "Enter" && suggestions[0]) {
                  choose(suggestions[0]);
                }
              }}
            />
          )}
          {suggestions.length === 0 && <div className="dc-suggestion is-empty">{workspace ? "没有匹配项" : "打开工作区后可引用笔记"}</div>}
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.kind === "command" ? `c:${suggestion.name}` : `${suggestion.kind}:${suggestion.path}`}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className={`dc-suggestion${index === highlight ? " is-highlighted" : ""}`}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(suggestion);
              }}
            >
              {suggestion.kind === "command" ? (
                <>
                  <span className="dc-suggestion-name">/{suggestion.name}</span>
                  <span className="dc-suggestion-detail">{suggestion.prompt.slice(0, 40)}</span>
                </>
              ) : (
                <>
                  <span className="dc-suggestion-name">{suggestion.kind === "activeNote" ? `当前笔记 · ${noteTitle(suggestion.path)}` : noteTitle(suggestion.path)}</span>
                  {workspace && <span className="dc-suggestion-detail">{relativePath(workspace, suggestion.path)}</span>}
                </>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="dc-composer-box">
        <div className="dc-chip-row">
          <button
            type="button"
            className="dc-chip is-add"
            title="添加上下文"
            aria-label="添加上下文"
            onClick={() => {
              setPickerOpen(!pickerOpen);
              setPickerQuery("");
              setTrigger(null);
            }}
          >
            <Plus size={iconSize.sm} />
          </button>
          {showActiveNote && filePath && <Badge item={{ kind: "activeNote", path: filePath }} onRemove={() => detachActiveNote(true)} />}
          {selection && <Badge item={selection} onRemove={() => setSelection(null)} />}
          {attachments.map((item) => (
            <Badge key={contextLabel(item) + item.path} item={item} onRemove={() => removeAttachment(item)} />
          ))}
        </div>
        <textarea
          ref={textarea}
          className="dc-composer-input"
          placeholder="提问，或输入 / 使用命令，[[ 引用笔记，@ 添加上下文"
          value={draft}
          rows={3}
          onChange={(event) => {
            setDraft(event.target.value);
            updateTrigger(event.target.value, event.target.selectionStart);
          }}
          onClick={(event) => updateTrigger(draft, event.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          onBlur={() => window.setTimeout(() => setTrigger(null), 150)}
        />
        <div className="dc-composer-footer">
          <div className="dc-segmented is-compact" role="radiogroup" aria-label="对话模式">
            <button
              type="button"
              role="radio"
              aria-checked={copilotSettings.mode === "chat"}
              className={`dc-segment${copilotSettings.mode === "chat" ? " is-selected" : ""}`}
              onClick={() => updateSettings("copilot", { mode: "chat" })}
              title="只依据附带的上下文回答"
            >
              对话
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={copilotSettings.mode === "vault"}
              className={`dc-segment${copilotSettings.mode === "vault" ? " is-selected" : ""}`}
              onClick={() => updateSettings("copilot", { mode: "vault" })}
              title="发送前在工作区内本地检索相关摘录"
            >
              <Search size={iconSize.sm} />
              工作区检索
            </button>
          </div>
          <button type="button" className="dc-model-label" title="在设置中更改 AI 连接与模型" onClick={() => openSettings("ai")}>
            {modelLabel || "未配置模型"}
          </button>
          {streamingId ? (
            <button type="button" className="dc-icon-button is-filled" title="停止" aria-label="停止生成" onClick={() => void stop()}>
              <Square size={iconSize.sm} />
            </button>
          ) : (
            <button type="button" className="dc-icon-button is-filled" title="发送" aria-label="发送" disabled={!draft.trim()} onClick={submit}>
              <Send size={iconSize.sm} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
