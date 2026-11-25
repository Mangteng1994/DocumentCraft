/**
 * 所见即所得 Markdown 编辑区。
 */

import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { createExtensions } from "./extensions";
import { differsFromClean, extractDocumentHeadings, getEditor, setEditor } from "./editorHandle";
import { selectNote } from "../documentActions";
import { captureEditorSelection } from "../features/copilot/actions";
import { useAppStore } from "../store";
import { syncWordCounts } from "./wordCount";
import { DocumentSearchBar } from "./DocumentSearchBar";

// 大纲在输入停顿后再刷新，长文档连续输入时不逐键重建。
const OUTLINE_DELAY_MS = 150;
// 拖选过程中不逐次更新 Copilot 的选区徽标。
const SELECTION_DELAY_MS = 250;

export function MarkdownEditor() {
  const filePath = useAppStore((state) => state.filePath);
  const outlineTimer = useRef<number | undefined>(undefined);
  const outlinedDocument = useRef<Editor["state"]["doc"] | null>(null);
  const selectionTimer = useRef<number | undefined>(undefined);

  /** 用当前文档内容和同一份选区刷新大纲，避免用旧标题位置判断新正文。 */
  function refreshOutline(editor: Editor, position = editor.state.selection.head): void {
    window.clearTimeout(outlineTimer.current);
    outlineTimer.current = undefined;
    outlinedDocument.current = editor.state.doc;
    const store = useAppStore.getState();
    store.setHeadings(extractDocumentHeadings(editor), position);
    store.bumpDocVersion();
  }

  const editor = useEditor({
    extensions: createExtensions(),
    editorProps: {
      attributes: {
        class: "dc-document",
        spellcheck: "false",
      },
      handleDOMEvents: {
        click: (view, event) => {
          if (event.button === 0) {
            const clickedPosition = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const position = clickedPosition?.pos ?? view.state.selection.head;
            if (outlinedDocument.current !== view.state.doc) {
              const current = getEditor();
              if (current?.view === view) {
                refreshOutline(current, position);
              }
            }
            // 再次点击同一节时，也允许把手动滚离的标题带回可见范围。
            useAppStore.getState().setOutlinePosition(position, true);
          }
          const target = event.target as HTMLElement | null;
          // 点击图片：在图片下方显示路径浮窗（DC-079）。路径取自 data-src，即 Markdown 中的原始写法。
          if (target instanceof HTMLImageElement) {
            const rect = target.getBoundingClientRect();
            const source = target.dataset.src ?? "";
            useAppStore.getState().setImagePopover({
              src: source,
              missing: target.classList.contains("is-missing"),
              left: rect.left,
              top: rect.top,
              bottom: rect.bottom,
            });
            return false;
          }
          const highlight = target?.closest<HTMLElement>("[data-note-id]");
          if (!highlight) {
            return false;
          }
          const store = useAppStore.getState();
          selectNote(highlight.dataset.noteId ?? null);
          store.setRightPanel("comments");
          return false;
        },
        // 右键弹出编辑区菜单（插入表格、表格行列、批注、Copilot）。
        contextmenu: (_view, event) => {
          event.preventDefault();
          useAppStore.getState().setContextMenu({ x: event.clientX, y: event.clientY });
          return true;
        },
      },
    },
    onSelectionUpdate: () => {
      // 选中文字后自动作为 Copilot 的选区上下文，与 Obsidian Copilot 一致。
      window.clearTimeout(selectionTimer.current);
      selectionTimer.current = window.setTimeout(captureEditorSelection, SELECTION_DELAY_MS);
    },
    onTransaction: ({ editor: changed, transaction }) => {
      if (transaction.docChanged || transaction.selectionSet) {
        syncWordCounts(changed);
      }
      if (!transaction.docChanged) {
        // 拖选时让大纲保持稳定，普通光标移动或跳转则跟随。
        if (transaction.selectionSet && changed.state.selection.empty && outlinedDocument.current === changed.state.doc) {
          useAppStore.getState().setOutlinePosition(changed.state.selection.head);
        }
        return;
      }
      window.clearTimeout(outlineTimer.current);
      outlineTimer.current = window.setTimeout(() => {
        refreshOutline(changed);
      }, OUTLINE_DELAY_MS);
    },
    onUpdate: () => {
      const store = useAppStore.getState();
      // 已是未保存状态时无需再比较；首次变化才序列化一次，排除载入后编辑器自行规范文档造成的更新。
      if (!store.dirty && !differsFromClean()) {
        return;
      }
      store.setDirty(true);
    },
  });

  // StrictMode 下旧实例的销毁可能晚于新实例创建，只清除仍指向自身的登记。
  useEffect(() => {
    if (!editor) {
      return;
    }
    setEditor(editor);
    return () => {
      if (getEditor() === editor) {
        setEditor(null);
      }
    };
  }, [editor]);

  // 切换文档时整体替换 EditorState，不经过事务，需要在这里重建大纲。
  useEffect(() => {
    if (!editor) {
      return;
    }
    syncWordCounts(editor);
    refreshOutline(editor);
  }, [editor, filePath]);

  useEffect(() => {
    return () => {
      window.clearTimeout(outlineTimer.current);
      window.clearTimeout(selectionTimer.current);
    };
  }, []);

  return (
    <>
      <DocumentSearchBar editor={editor} />
      <div className="dc-editor-scroll">
        <EditorContent editor={editor} className="dc-editor-host" />
      </div>
    </>
  );
}
