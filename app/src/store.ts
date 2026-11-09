/**
 * 应用状态。编辑器实例本身不进 store，见 editor/editorHandle.ts。
 */

import { create } from "zustand";
import type { TreeNode } from "./backend";
import type { Note } from "./editor/annotations";
import type { HeadingItem } from "@vmark/utils/markdownOutline";

export type SidebarView = "files" | "outline";
export type RightPanel = "comments" | "copilot" | null;
export type DialogKind = "export" | "illustrate" | "ai" | null;

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
  dialog: DialogKind;
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
  setDialog: (dialog: DialogKind) => void;
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
  dialog: null,
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
  setDialog: (dialog) => set({ dialog }),
  setApiKey: (apiKey) => set({ apiKey }),
  setStatus: (status) => set({ status }),
}));
