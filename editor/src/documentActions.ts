/**
 * 打开工作区、切换文档、保存与批注读写。
 */

import { ask, open } from "@tauri-apps/plugin-dialog";
import { createFolder, createMarkdown, docflow, errorText, listDir, listTree, openPath, readText, writeText } from "./backend";
import { setDocumentDirectory } from "./editor/assets";
import {
  currentMarkdown,
  getEditor,
  loadMarkdown,
  markClean,
  restoreDocument,
  revealOccurrence,
  snapshotDocument,
  type DocumentSnapshot,
} from "./editor/editorHandle";
import { setAnnotationMeta, type Note, type NoteAnchor } from "./editor/annotations";
import { fileName, parentDirectory } from "./paths";
import { MAX_RECENT_WORKSPACES } from "./settings/schema";
import { useSettings } from "./settings/settingsStore";
import { useAppStore } from "./store";

/** 关闭有未保存修改的页签前询问是否保存，返回 false 表示保存失败、操作中止。 */
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

/** 按需加载：读取一个文件夹的子项并合并进目录树。失败时原因显示在状态栏，该文件夹保持未读取。 */
export async function loadFolder(path: string): Promise<void> {
  const store = useAppStore.getState();
  try {
    const node = await listDir(path, showAllFiles());
    store.mergeTreeNode(node);
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

/** 把工作区移到最近列表最前面。 */
function rememberWorkspace(root: string): void {
  const settings = useSettings.getState();
  const previous = settings.settings.history.recentWorkspaces;
  const others = previous.filter((item) => item.toLowerCase() !== root.toLowerCase());
  const recentWorkspaces = [root, ...others].slice(0, MAX_RECENT_WORKSPACES);
  settings.update("history", { recentWorkspaces });
}

/** 从最近列表中移除一个工作区，不影响磁盘上的文件夹。 */
export function forgetWorkspace(root: string): void {
  const settings = useSettings.getState();
  const previous = settings.settings.history.recentWorkspaces;
  const recentWorkspaces = previous.filter((item) => item.toLowerCase() !== root.toLowerCase());
  settings.update("history", { recentWorkspaces });
}

export async function openWorkspace(root: string): Promise<void> {
  const store = useAppStore.getState();
  try {
    const tree = await listTree(root, showAllFiles());
    store.setWorkspace(root, tree);
    store.setSidebarView("files");
    rememberWorkspace(root);
  } catch (error) {
    store.setStatus(errorText(error));
  }
}

/** 用系统默认应用打开非 Markdown 文件。程序和脚本由后端拒绝，原因显示在状态栏。 */
export async function openWithSystem(path: string, name: string): Promise<void> {
  const store = useAppStore.getState();
  try {
    await openPath(path);
    store.setStatus(`已用默认应用打开 ${name}`);
  } catch (error) {
    store.setStatus(errorText(error));
  }
}

/** 打开文档并选中第 occurrence 处（从 0 起）与 query 相同的文字，供搜索结果跳转。 */
export async function openSearchResult(path: string, query: string, occurrence: number): Promise<void> {
  const opened = await openDocument(path);
  if (!opened) {
    return;
  }
  const found = revealOccurrence(query, occurrence);
  if (!found) {
    useAppStore.getState().setStatus("已打开文档，但搜索文字在排版后的正文中找不到（可能位于链接地址或代码标记中）。");
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

/** 各页签的编辑现场，键为文档路径。当前页签的现场在切走时才写入。 */
const snapshots = new Map<string, DocumentSnapshot>();

/** 切走前保存当前页签的编辑现场。 */
function rememberCurrent(): void {
  const { filePath } = useAppStore.getState();
  if (!filePath) {
    return;
  }
  const snapshot = snapshotDocument();
  if (snapshot) {
    snapshots.set(filePath, snapshot);
  }
}

/** 编辑器已显示 path 的内容后，同步当前文档、未保存状态和批注。 */
async function activate(path: string, dirty: boolean): Promise<void> {
  const store = useAppStore.getState();
  store.setFilePath(path);
  store.setDirty(dirty);
  store.setActiveNoteId(null);
  store.setStatus("");
  await loadNotes();
}

/**
 * 打开文档：已在页签中时切换过去，保留其内容、撤销历史和未保存修改；否则读取文件并在当前页签右侧新开页签。
 * force 为真时从磁盘重新读取，丢弃该页签中的修改。
 */
export async function openDocument(path: string, options: { force?: boolean } = {}): Promise<boolean> {
  const store = useAppStore.getState();
  if (!options.force && path === store.filePath) {
    return true;
  }
  const existing = store.tabs.find((tab) => tab.path === path);
  const snapshot = snapshots.get(path);
  if (existing && snapshot && !options.force) {
    rememberCurrent();
    // 图片相对路径在渲染时解析，需先切换基准目录再替换内容。
    setDocumentDirectory(parentDirectory(path));
    restoreDocument(snapshot);
    await activate(path, existing.dirty);
    return true;
  }
  try {
    const markdown = await readText(path);
    rememberCurrent();
    setDocumentDirectory(parentDirectory(path));
    loadMarkdown(markdown);
    snapshots.delete(path);
    if (!existing) {
      store.openTab(path);
    }
    await activate(path, false);
    return true;
  } catch (error) {
    store.setStatus(errorText(error));
    return false;
  }
}

/** 关闭页签。有未保存修改时先切到该页签并询问是否保存。返回 false 表示未关闭。 */
export async function closeTab(path: string): Promise<boolean> {
  const tab = useAppStore.getState().tabs.find((item) => item.path === path);
  if (!tab) {
    return true;
  }
  if (tab.dirty) {
    const shown = await openDocument(path);
    if (!shown) {
      return false;
    }
    const proceed = await confirmLeave();
    if (!proceed) {
      return false;
    }
  }
  const store = useAppStore.getState();
  const index = store.tabs.findIndex((item) => item.path === path);
  const wasActive = store.filePath === path;
  snapshots.delete(path);
  store.removeTab(path);
  if (!wasActive) {
    return true;
  }
  const remaining = useAppStore.getState().tabs;
  const neighbor = remaining[Math.min(index, remaining.length - 1)];
  if (neighbor) {
    // 当前页签已移除，不再保存它的现场；直接显示相邻页签。
    store.setFilePath(null);
    await openDocument(neighbor.path);
    return true;
  }
  loadMarkdown("");
  store.setFilePath(null);
  store.setDirty(false);
  store.setNotes([]);
  store.setHeadings([]);
  return true;
}

/** 按页签顺序切换到相邻页签，step 为 1 时向右、-1 时向左，首尾循环。 */
export async function switchTab(step: number): Promise<void> {
  const { tabs, filePath } = useAppStore.getState();
  if (tabs.length < 2) {
    return;
  }
  const index = tabs.findIndex((tab) => tab.path === filePath);
  const next = tabs[(index + step + tabs.length) % tabs.length];
  await openDocument(next.path);
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
