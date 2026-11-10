/**
 * 左侧栏：「文件」「大纲」两个视图。Ctrl+F 在标签栏下方打开工作区搜索框，有关键词时结果替换目录树。
 */

import { FileTree } from "./FileTree";
import { OutlineView } from "./OutlineView";
import { SearchBar, SearchResults } from "./SearchView";
import { PaneResizer } from "../components/PaneResizer";
import { useAppStore, type SidebarView } from "../store";

const VIEWS: { id: SidebarView; label: string }[] = [
  { id: "files", label: "文件" },
  { id: "outline", label: "大纲" },
];

export function Sidebar() {
  const view = useAppStore((state) => state.sidebarView);
  const setView = useAppStore((state) => state.setSidebarView);
  const searchOpen = useAppStore((state) => state.searchOpen);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const showResults = searchOpen && searchQuery.trim().length > 0;

  return (
    <aside className="dc-sidebar" aria-label="侧栏">
      <div className="dc-tabs" role="tablist">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            className={`dc-tab${view === item.id ? " is-selected" : ""}`}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {searchOpen && <SearchBar />}
      <div className="dc-sidebar-body">
        {showResults && <SearchResults />}
        {!showResults && view === "files" && <FileTree />}
        {!showResults && view === "outline" && <OutlineView />}
      </div>
      <PaneResizer pane="sidebar" />
    </aside>
  );
}
