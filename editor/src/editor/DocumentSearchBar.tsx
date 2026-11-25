/** 文档内搜索栏：输入查询、命中计数、前后定位和关闭，状态与正文分开保存。 */
import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useAppStore } from "../store";
import { iconSize, iconStroke } from "../styles/tokens";
import { closeDocumentSearch, moveDocumentSearch, updateDocumentSearch, useDocumentSearch } from "./documentSearch";

const QUERY_DELAY_MS = 120;

export function DocumentSearchBar({ editor }: { editor: Editor | null }) {
  const open = useDocumentSearch((state) => state.open);
  const query = useDocumentSearch((state) => state.query);
  const setQuery = useDocumentSearch((state) => state.setQuery);
  const total = useDocumentSearch((state) => state.total);
  const index = useDocumentSearch((state) => state.index);
  const focusRequest = useDocumentSearch((state) => state.focusRequest);
  const filePath = useAppStore((state) => state.filePath);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open, focusRequest]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    if (!filePath) {
      closeDocumentSearch(editor);
      return;
    }
    if (!open || !query) {
      updateDocumentSearch(editor, "", false);
      return;
    }
    const timer = window.setTimeout(() => updateDocumentSearch(editor, query), QUERY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [editor, filePath, open, query]);

  useEffect(() => {
    if (!open || !editor) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      const { overlay, preview } = useAppStore.getState();
      if (event.isComposing || event.defaultPrevented || overlay || preview) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.(".dc-main")) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDocumentSearch(editor);
      } else if (event.code === "F3" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        moveDocumentSearch(editor, event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, editor]);

  if (!open || !filePath) {
    return null;
  }

  return (
    <div className="dc-document-search" role="search" aria-label="当前文档搜索">
      <Search size={iconSize.sm} strokeWidth={iconStroke.regular} />
      <input
        ref={input}
        className="dc-input dc-document-search-input"
        aria-label="搜索当前 Markdown 文档内容"
        placeholder="在当前文档中搜索"
        value={query}
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key !== "Enter" || !editor) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          moveDocumentSearch(editor, event.shiftKey ? -1 : 1);
        }}
      />
      <span className="dc-document-search-count" role="status" aria-live="polite">
        {query && total === 0 ? "无匹配" : `${index + 1} / ${total}`}
      </span>
      <div className="dc-document-search-actions">
        <button type="button" className="dc-icon-button" aria-label="上一处匹配" title="上一处（Shift+Enter / Shift+F3）" disabled={!editor || total === 0} onClick={() => editor && moveDocumentSearch(editor, -1)}>
          <ChevronUp size={iconSize.sm} />
        </button>
        <button type="button" className="dc-icon-button" aria-label="下一处匹配" title="下一处（Enter / F3）" disabled={!editor || total === 0} onClick={() => editor && moveDocumentSearch(editor, 1)}>
          <ChevronDown size={iconSize.sm} />
        </button>
        <button type="button" className="dc-icon-button" aria-label="关闭文档搜索" title="关闭（Esc）" onClick={() => closeDocumentSearch(editor)}>
          <X size={iconSize.sm} />
        </button>
      </div>
    </div>
  );
}
