/**
 * 批注面板：从选区新建批注，列出、定位、编辑、删除批注，以及打包分享。
 * 列表结构参照 VMark Comments/CommentsPanel，数据改为 docflow 管理的 SQLite 批注库。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus, Package, Pencil, Trash2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { docflow, errorText } from "../../backend";
import { addNote, deleteNote, ensureSaved, selectNote, updateNote } from "../../documentActions";
import { fileName } from "../../paths";
import { anchorFromSelection, noteRanges, type Note, type NoteAnchor } from "../../editor/annotations";
import { getEditor, revealPosition } from "../../editor/editorHandle";
import { useAppStore } from "../../store";
import { StatusLine } from "../../components/Dialog";
import { iconSize } from "../../styles/tokens";

function NoteItem({ note, located, active }: { note: Note; located: boolean; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [error, setError] = useState("");

  const handleReveal = () => {
    selectNote(note.id);
    const editor = getEditor();
    if (!editor) {
      return;
    }
    const range = noteRanges(editor.state).get(note.id);
    if (range) {
      revealPosition(range.from, range.to);
    }
  };

  const handleSave = async () => {
    try {
      await updateNote(note.id, draft.trim());
      setEditing(false);
      setError("");
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteNote(note.id);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <li className={`dc-note${active ? " is-active" : ""}`}>
      <button type="button" className="dc-note-quote" onClick={handleReveal} title="定位到正文">
        {note.quote}
      </button>
      {!located && <span className="dc-badge is-warning">待定位</span>}
      {editing ? (
        <div className="dc-note-edit">
          <textarea className="dc-input dc-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="dc-row-actions">
            <button type="button" className="dc-button" onClick={() => setEditing(false)}>
              取消
            </button>
            <button type="button" className="dc-button is-primary" disabled={!draft.trim()} onClick={() => void handleSave()}>
              保存
            </button>
          </div>
        </div>
      ) : (
        <p className="dc-note-body">{note.body}</p>
      )}
      {!editing && (
        <div className="dc-row-actions">
          <button type="button" className="dc-icon-button" aria-label="编辑批注" title="编辑" onClick={() => setEditing(true)}>
            <Pencil size={iconSize.sm} />
          </button>
          <button type="button" className="dc-icon-button" aria-label="删除批注" title="删除" onClick={() => void handleDelete()}>
            <Trash2 size={iconSize.sm} />
          </button>
        </div>
      )}
      <StatusLine text={error} tone="error" />
    </li>
  );
}

export function CommentsPanel() {
  const filePath = useAppStore((state) => state.filePath);
  const notes = useAppStore((state) => state.notes);
  const activeNoteId = useAppStore((state) => state.activeNoteId);
  const docVersion = useAppStore((state) => state.docVersion);
  const [pending, setPending] = useState<NoteAnchor | null>(null);
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"normal" | "error" | "warning">("normal");

  // 依赖 docVersion：编辑后批注按原文重新定位，定位状态随之变化。
  const located = useMemo(() => {
    const editor = getEditor();
    if (!editor) {
      return new Set<string>();
    }
    return new Set(noteRanges(editor.state).keys());
  }, [notes, docVersion]);

  const show = (text: string, nextTone: "normal" | "error" | "warning" = "normal") => {
    setMessage(text);
    setTone(nextTone);
  };

  const handleStart = () => {
    const editor = getEditor();
    if (!editor) {
      return;
    }
    const anchor = anchorFromSelection(editor.state);
    if (!anchor) {
      show("请先在同一段内选中要批注的文字。", "warning");
      return;
    }
    setPending(anchor);
    setBody("");
    show("");
  };

  // 右键菜单「添加批注」：打开面板后立即为当前选区开始新建批注。
  const commentRequest = useAppStore((state) => state.commentRequest);
  const handledRequest = useRef(commentRequest);
  useEffect(() => {
    if (commentRequest === handledRequest.current) {
      return;
    }
    handledRequest.current = commentRequest;
    handleStart();
  }, [commentRequest]);

  const handleAdd = async () => {
    if (!pending) {
      return;
    }
    try {
      await addNote(pending, body.trim());
      setPending(null);
      setBody("");
      show("");
    } catch (error) {
      show(errorText(error), "error");
    }
  };

  const handleShare = async () => {
    if (!filePath) {
      return;
    }
    const saved = await ensureSaved();
    if (!saved) {
      return;
    }
    const stem = fileName(filePath).replace(/\.(md|markdown)$/i, "");
    const output = await save({
      title: "保存分享包",
      defaultPath: filePath.replace(/[^\\/]+$/, `${stem}-含批注.zip`),
      filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
    });
    if (!output) {
      return;
    }
    try {
      const result = await docflow<{ output: string; notes: number }>(["share", "--source", filePath, "--output", output]);
      show(`已打包 ${result.notes} 条批注：${result.output}。图片等外部附件需另行提供。`);
    } catch (error) {
      show(errorText(error), "error");
    }
  };

  if (!filePath) {
    return <div className="dc-sidebar-empty">打开文档后可添加批注。</div>;
  }

  return (
    <div className="dc-panel-content">
      <div className="dc-panel-toolbar">
        <button type="button" className="dc-button is-primary" onClick={handleStart}>
          <MessageSquarePlus size={iconSize.sm} />
          为选区添加批注
        </button>
        <button type="button" className="dc-button" onClick={() => void handleShare()} title="打包 Markdown 与批注">
          <Package size={iconSize.sm} />
          分享包
        </button>
      </div>
      {pending && (
        <div className="dc-note-draft">
          <blockquote className="dc-note-quote is-static">{pending.quote}</blockquote>
          <textarea
            className="dc-input dc-textarea"
            placeholder="输入批注"
            autoFocus
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="dc-row-actions">
            <button type="button" className="dc-button" onClick={() => setPending(null)}>
              取消
            </button>
            <button type="button" className="dc-button is-primary" disabled={!body.trim()} onClick={() => void handleAdd()}>
              保存批注
            </button>
          </div>
        </div>
      )}
      <StatusLine text={message} tone={tone} />
      {notes.length === 0 ? (
        <div className="dc-sidebar-empty">还没有批注。选中正文后点击「为选区添加批注」。</div>
      ) : (
        <ul className="dc-note-list">
          {notes.map((note) => (
            <NoteItem key={note.id} note={note} located={located.has(note.id)} active={note.id === activeNoteId} />
          ))}
        </ul>
      )}
    </div>
  );
}
