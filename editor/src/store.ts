/**
 * 应用状态。编辑器实例本身不进 store，见 editor/editorHandle.ts；设置见 settings/settingsStore.ts；
 * Copilot 对话见 features/copilot/copilotStore.ts。
 */

import { create } from "zustand";
import type { TreeNode } from "./backend";
import type { Note } from "./editor/annotations";
import type { HeadingItem } from "@vmark/utils/markdownOutline";

export type SidebarView = "files" | "outline";
export type RightPanel = "comments" | "copilot" | null;
export type SettingsTab = "appearance" | "files" | "hotkeys" | "copilot" | "ai" | "word" | "figure";

/** 浮层：设置、插入表格、Quick Ask。同一时刻只显示一个。 */
export type Overlay =
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "insertTable" }
  | { kind: "quickAsk"; commandName?: string }
  | null;

export interface ContextMenuState {
  x: number;
  y: number;
}

export interface AppState {
  workspace: string | null;
  tree: TreeNode | null;
  filePath: string | null;
  dirty: boolean;
  headings: HeadingItem[];
  /** 文档内容每次变化后递增，供批注面板刷新定位状态。 */
  docVersion: number;
  notes: Note[];
  activeNoteId: string | null;
  sidebarView: SidebarView;
  rightPanel: RightPanel;
  overlay: Overlay;
  contextMenu: ContextMenuState | null;
  /** 右键「添加批注」时递增，批注面板据此为当前选区开始新建批注。 */
  commentRequest: number;
  /** 兼容 API 的 Key 只保存在本次会话内存中。 */
  apiKey: string;
  status: string;

  setWorkspace: (workspace: string | null, tree: TreeNode | null) => void;
  setTree: (tree: TreeNode | null) => void;
  setFilePath: (path: string | null) => void;
  setDirty: (dirty: boolean) => void;
  setHeadings: (headings: HeadingItem[]) => void;
  bumpDocVersion: () => void;
  setNotes: (notes: Note[]) => void;
  setActiveNoteId: (id: string | null) => void;
  setSidebarView: (view: SidebarView) => void;
  setRightPanel: (panel: RightPanel) => void;
  setOverlay: (overlay: Overlay) => void;
  openSettings: (tab?: SettingsTab) => void;
  setContextMenu: (menu: ContextMenuState | null) => void;
  requestComment: () => void;
  setApiKey: (key: string) => void;
  setStatus: (status: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  workspace: null,
  tree: null,
  filePath: null,
  dirty: false,
  headings: [],
  docVersion: 0,
  notes: [],
  activeNoteId: null,
  sidebarView: "files",
  rightPanel: null,
  overlay: null,
  contextMenu: null,
  commentRequest: 0,
  apiKey: "",
  status: "",

  setWorkspace: (workspace, tree) => set({ workspace, tree }),
  setTree: (tree) => set({ tree }),
  setFilePath: (filePath) => set({ filePath }),
  setDirty: (dirty) => set({ dirty }),
  setHeadings: (headings) => set({ headings }),
  bumpDocVersion: () => set((state) => ({ docVersion: state.docVersion + 1 })),
  setNotes: (notes) => set({ notes }),
  setActiveNoteId: (activeNoteId) => set({ activeNoteId }),
  setSidebarView: (sidebarView) => set({ sidebarView }),
  setRightPanel: (rightPanel) => set({ rightPanel }),
  setOverlay: (overlay) => set({ overlay, contextMenu: null }),
  openSettings: (tab = "appearance") => set({ overlay: { kind: "settings", tab }, contextMenu: null }),
  setContextMenu: (contextMenu) => set({ contextMenu }),
  requestComment: () => set((state) => ({ commentRequest: state.commentRequest + 1 })),
  setApiKey: (apiKey) => set({ apiKey }),
  setStatus: (status) => set({ status }),
}));

/** 工作区内全部 Markdown 文件的绝对路径，供 [[ 提及与命令模板解析笔记。 */
export function workspaceFiles(tree: TreeNode | null): string[] {
  if (!tree) {
    return [];
  }
  const files: string[] = [];
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      if (child.is_dir) {
        walk(child);
      } else if (/\.(md|markdown)$/i.test(child.name)) {
        files.push(child.path);
      }
    }
  };
  walk(tree);
  return files;
}
