/**
 * 所见即所得 Markdown 编辑区。
 */

import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { createExtensions } from "./extensions";
import { extractDocumentHeadings, getEditor, setEditor } from "./editorHandle";
import { selectNote } from "../documentActions";
import { useAppStore } from "../store";

// 大纲在输入停顿后再刷新，长文档连续输入时不逐键重建。
const OUTLINE_DELAY_MS = 150;

export function MarkdownEditor() {
  const filePath = useAppStore((state) => state.filePath);
  const outlineTimer = useRef<number | undefined>(undefined);

  const editor = useEditor({
    extensions: createExtensions(),
    editorProps: {
      attributes: {
        class: "dc-document",
        spellcheck: "false",
      },
      handleDOMEvents: {
        click: (_view, event) => {
          const target = event.target as HTMLElement | null;
          const highlight = target?.closest<HTMLElement>("[data-note-id]");
          if (!highlight) {
            return false;
          }
          const store = useAppStore.getState();
          selectNote(highlight.dataset.noteId ?? null);
          store.setRightPanel("comments");
          return false;
        },
      },
    },
    onTransaction: ({ editor: changed, transaction }) => {
      if (!transaction.docChanged) {
        return;
      }
      window.clearTimeout(outlineTimer.current);
      outlineTimer.current = window.setTimeout(() => {
        const store = useAppStore.getState();
        store.setHeadings(extractDocumentHeadings(changed));
        store.bumpDocVersion();
      }, OUTLINE_DELAY_MS);
    },
    onUpdate: () => {
      useAppStore.getState().setDirty(true);
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
    const store = useAppStore.getState();
    store.setHeadings(extractDocumentHeadings(editor));
    store.bumpDocVersion();
  }, [editor, filePath]);

  useEffect(() => {
    return () => window.clearTimeout(outlineTimer.current);
  }, []);

  return (
    <div className="dc-editor-scroll">
      <EditorContent editor={editor} className="dc-editor-host" />
    </div>
  );
}
