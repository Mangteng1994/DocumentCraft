/**
 * 左侧栏：「文件」「大纲」和工作区「搜索」三个视图。
 */

import { FileTree } from "./FileTree";
import { OutlineView } from "./OutlineView";
import { SearchView } from "./SearchView";
import { useAppStore, type SidebarView } from "../store";

const VIEWS: { id: SidebarView; label: string }[] = [
  { id: "files", label: "文件" },
  { id: "outline", label: "大纲" },
  { id: "search", label: "搜索" },
];

export function Sidebar() {
  const view = useAppStore((state) => state.sidebarView);
  const setView = useAppStore((state) => state.setSidebarView);

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
      <div className="dc-sidebar-body">
        {view === "files" && <FileTree />}
        {view === "outline" && <OutlineView />}
        {view === "search" && <SearchView />}
      </div>
    </aside>
  );
}
