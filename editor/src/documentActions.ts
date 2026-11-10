/**
 * 打开工作区、切换文档、保存与批注读写。
 */

import { ask, open } from "@tauri-apps/plugin-dialog";
import { createFolder, createMarkdown, docflow, errorText, listTree, readText, writeText } from "./backend";
import { setDocumentDirectory } from "./editor/assets";
import { currentMarkdown, getEditor, loadMarkdown, markClean } from "./editor/editorHandle";
import { setAnnotationMeta, type Note, type NoteAnchor } from "./editor/annotations";
import { fileName, parentDirectory } from "./paths";
import { useSettings } from "./settings/settingsStore";
import { useAppStore } from "./store";

/** 有未保存修改时询问是否保存，返回 false 表示用户取消了后续操作。 */
async function confirmLeave(): Promise<boolean> {
  const { dirty, filePath } = useAppStore.getState();
  if (!dirty || !filePath) {
    return true;
  }
  const save = await ask(`「${fileName(filePath)}」有未保存的修改，是否先保存？`, {
    title: "DocumentCraft",
    kind: "warning",
    okLabel: "保存",
    cancelLabel: "不保存",
  });
  if (save) {
    return saveDocument();
  }
  return true;
}

function showAllFiles(): boolean {
  return useSettings.getState().settings.files.showAllFiles;
}

/** 在目录下新建 Markdown 并打开。名称缺少 .md 扩展名时自动补上。成功返回新文件路径，失败返回 null。 */
export async function createNote(directory: string, name: string): Promise<string | null> {
  const store = useAppStore.getState();
  const hasExtension = /\.(md|markdown)$/i.test(name.trim());
  const entryName = hasExtension ? name.trim() : `${name.trim()}.md`;
  try {
    const path = await createMarkdown(directory, entryName);
    await refreshTree();
    await openDocument(path);
    return path;
  } catch (error) {
    store.setStatus(errorText(error));
    return null;
  }
}

/** 在目录下新建文件夹。成功返回路径，失败返回 null。 */
export async function createFolderIn(directory: string, name: string): Promise<string | null> {
  const store = useAppStore.getState();
  try {
    const path = await createFolder(directory, name.trim());
    await refreshTree();
    return path;
  } catch (error) {
    store.setStatus(errorText(error));
    return null;
  }
}

export async function refreshTree(): Promise<void> {
  const store = useAppStore.getState();
  if (!store.workspace) {
    return;
  }
  try {
    const tree = await listTree(store.workspace, showAllFiles());
    store.setTree(tree);
  } catch (error) {
    store.setStatus(errorText(error));
  }
}

export async function chooseWorkspace(): Promise<void> {
  const selected = await open({ directory: true, multiple: false, title: "打开工作区文件夹" });
  if (typeof selected !== "string") {
    return;
  }
  await openWorkspace(selected);
}

export async function openWorkspace(root: string): Promise<void> {
  const store = useAppStore.getState();
  try {
    const tree = await listTree(root, showAllFiles());
    store.setWorkspace(root, tree);
    store.setSidebarView("files");
  } catch (error) {
    store.setStatus(errorText(error));
  }
}

export async function chooseFile(): Promise<void> {
  const selected = await open({
    multiple: false,
    title: "打开 Markdown",
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (typeof selected !== "string") {
    return;
  }
  const { workspace } = useAppStore.getState();
  const insideWorkspace = workspace !== null && selected.toLowerCase().startsWith(workspace.toLowerCase());
  if (!insideWorkspace) {
    await openWorkspace(parentDirectory(selected));
  }
  await openDocument(selected);
}

export async function openDocument(path: string, options: { force?: boolean } = {}): Promise<boolean> {
  const store = useAppStore.getState();
  if (!options.force && path === store.filePath) {
    return true;
  }
  const proceed = await confirmLeave();
  if (!proceed) {
    return false;
  }
  try {
    const markdown = await readText(path);
    setDocumentDirectory(parentDirectory(path));
    loadMarkdown(markdown);
    store.setFilePath(path);
    store.setDirty(false);
    store.setActiveNoteId(null);
    store.setStatus("");
    await loadNotes();
    return true;
  } catch (error) {
    store.setStatus(errorText(error));
    return false;
  }
}

/** 保存当前文档，返回是否成功。 */
export async function saveDocument(): Promise<boolean> {
  const store = useAppStore.getState();
  if (!store.filePath) {
    return false;
  }
  try {
    const markdown = currentMarkdown();
    await writeText(store.filePath, markdown);
    markClean();
    store.setDirty(false);
    store.setStatus("已保存");
    return true;
  } catch (error) {
    store.setStatus(errorText(error));
    return false;
  }
}

/** 导出、配图等读取磁盘文件的操作之前，先保存未保存的修改。 */
export async function ensureSaved(): Promise<boolean> {
  const { dirty } = useAppStore.getState();
  if (!dirty) {
    return true;
  }
  return saveDocument();
}

function pushNotesToEditor(notes: Note[], activeId: string | null): void {
  const editor = getEditor();
  if (!editor) {
    return;
  }
  const transaction = setAnnotationMeta(editor.state, { notes, activeId });
  editor.view.dispatch(transaction);
}

export async function loadNotes(): Promise<void> {
  const store = useAppStore.getState();
  if (!store.filePath) {
    store.setNotes([]);
    pushNotesToEditor([], null);
    return;
  }
  try {
    const result = await docflow<{ notes: Note[] }>(["notes", "list", "--source", store.filePath]);
    store.setNotes(result.notes);
    pushNotesToEditor(result.notes, store.activeNoteId);
  } catch (error) {
    store.setNotes([]);
    pushNotesToEditor([], null);
    store.setStatus(`批注读取失败：${errorText(error)}`);
  }
}

export async function addNote(anchor: NoteAnchor, body: string): Promise<void> {
  const store = useAppStore.getState();
  if (!store.filePath) {
    return;
  }
  const payload = { ...anchor, body };
  const result = await docflow<{ note: Note }>(["notes", "add", "--source", store.filePath], { input: payload });
  const notes = [...useAppStore.getState().notes, result.note];
  store.setNotes(notes);
  store.setActiveNoteId(result.note.id);
  pushNotesToEditor(notes, result.note.id);
}

export async function updateNote(id: string, body: string): Promise<void> {
  const store = useAppStore.getState();
  if (!store.filePath) {
    return;
  }
  await docflow(["notes", "update", "--source", store.filePath, "--id", id], { input: { body } });
  const notes = useAppStore.getState().notes.map((note) => (note.id === id ? { ...note, body } : note));
  store.setNotes(notes);
  pushNotesToEditor(notes, store.activeNoteId);
}

export async function deleteNote(id: string): Promise<void> {
  const store = useAppStore.getState();
  if (!store.filePath) {
    return;
  }
  await docflow(["notes", "delete", "--source", store.filePath, "--id", id]);
  const notes = useAppStore.getState().notes.filter((note) => note.id !== id);
  store.setNotes(notes);
  const activeId = store.activeNoteId === id ? null : store.activeNoteId;
  store.setActiveNoteId(activeId);
  pushNotesToEditor(notes, activeId);
}

export function selectNote(id: string | null): void {
  const store = useAppStore.getState();
  store.setActiveNoteId(id);
  pushNotesToEditor(store.notes, id);
}
