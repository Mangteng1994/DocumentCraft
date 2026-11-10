/**
 * 应用状态。编辑器实例本身不进 store，见 editor/editorHandle.ts；设置见 settings/settingsStore.ts；
 * Copilot 对话见 features/copilot/copilotStore.ts。
 */

import { create } from "zustand";
import type { IndexProgress, TreeNode } from "./backend";
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

/** 编辑区顶部的一个页签。内容和撤销历史保存在 documentActions 的页签现场中。 */
export interface DocumentTab {
  path: string;
  dirty: boolean;
}

export interface AppState {
  workspace: string | null;
  tree: TreeNode | null;
  filePath: string | null;
  dirty: boolean;
  /** 打开的页签，顺序即显示顺序；filePath 为当前页签。 */
  tabs: DocumentTab[];
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
  /** 侧栏顶部的搜索框是否打开（Ctrl+F）。 */
  searchOpen: boolean;
  /** 搜索关键词，搜索框关闭时清空。 */
  searchQuery: string;
  /** 按快捷键打开搜索时递增，搜索框据此获得焦点。 */
  searchFocusRequest: number;
  /** 当前工作区的文档索引进度；未开始建立时为 null。 */
  indexProgress: IndexProgress | null;
  /** 索引进度变化时按节流递增，搜索结果据此刷新。 */
  indexVersion: number;
  /** 兼容 API 的 Key 只保存在本次会话内存中。 */
  apiKey: string;
  status: string;

  setWorkspace: (workspace: string | null, tree: TreeNode | null) => void;
  setTree: (tree: TreeNode | null) => void;
  setFilePath: (path: string | null) => void;
  setDirty: (dirty: boolean) => void;
  /** 在当前页签右侧加入页签；已存在时不变。 */
  openTab: (path: string) => void;
  removeTab: (path: string) => void;
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
  setSearchQuery: (query: string) => void;
  openSearch: () => void;
  closeSearch: () => void;
  setIndexProgress: (progress: IndexProgress | null, refresh: boolean) => void;
  setApiKey: (key: string) => void;
  setStatus: (status: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  workspace: null,
  tree: null,
  filePath: null,
  dirty: false,
  tabs: [],
  headings: [],
  docVersion: 0,
  notes: [],
  activeNoteId: null,
  sidebarView: "files",
  rightPanel: null,
  overlay: null,
  contextMenu: null,
  commentRequest: 0,
  searchOpen: false,
  searchQuery: "",
  searchFocusRequest: 0,
  indexProgress: null,
  indexVersion: 0,
  apiKey: "",
  status: "",

  // 换工作区后旧的索引进度不再适用。
  setWorkspace: (workspace, tree) => set((state) => ({ workspace, tree, indexProgress: workspace === state.workspace ? state.indexProgress : null })),
  setTree: (tree) => set({ tree }),
  setFilePath: (filePath) => set({ filePath }),
  // 未保存状态同时记在当前页签上，切换页签后据此恢复。
  setDirty: (dirty) =>
    set((state) => ({
      dirty,
      tabs: state.tabs.map((tab) => (tab.path === state.filePath ? { ...tab, dirty } : tab)),
    })),
  openTab: (path) =>
    set((state) => {
      if (state.tabs.some((tab) => tab.path === path)) {
        return {};
      }
      const index = state.tabs.findIndex((tab) => tab.path === state.filePath);
      const tabs = [...state.tabs];
      tabs.splice(index + 1, 0, { path, dirty: false });
      return { tabs };
    }),
  removeTab: (path) => set((state) => ({ tabs: state.tabs.filter((tab) => tab.path !== path) })),
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
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  // 搜索的是整个工作区，结果替换目录树，所以打开搜索时切到「文件」视图。
  openSearch: () => set((state) => ({ searchOpen: true, sidebarView: "files", searchFocusRequest: state.searchFocusRequest + 1 })),
  closeSearch: () => set({ searchOpen: false, searchQuery: "" }),
  setIndexProgress: (indexProgress, refresh) =>
    set((state) => ({ indexProgress, indexVersion: refresh ? state.indexVersion + 1 : state.indexVersion })),
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
