/**
 * 状态栏左侧的工作区切换：只显示当前工作区文件夹名，悬停显示完整路径；
 * 点击向上弹出最近打开的工作区，选择后切换，也可打开其他文件夹。
 */

import { useEffect, useRef, useState } from "react";
import { Check, Folder, FolderOpen } from "lucide-react";
import { chooseWorkspace, openWorkspace } from "../documentActions";
import { fileName, parentDirectory } from "../paths";
import { useSettings } from "../settings/settingsStore";
import { useAppStore } from "../store";
import { iconSize, iconStroke } from "../styles/tokens";

function samePath(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

export function WorkspaceSwitcher() {
  const workspace = useAppStore((state) => state.workspace);
  const recent = useSettings((state) => state.settings.history.recentWorkspaces);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击菜单外部或按 Esc 关闭。
  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const choose = (root: string) => {
    setOpen(false);
    if (!samePath(workspace, root)) {
      void openWorkspace(root);
    }
  };

  const chooseOther = () => {
    setOpen(false);
    void chooseWorkspace();
  };

  const label = workspace ? fileName(workspace) || workspace : "未打开文件夹";

  return (
    <div className="dc-workspace-switcher" ref={rootRef}>
      <button
        type="button"
        className="dc-workspace-button"
        title={workspace ?? "点击打开文件夹"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Folder size={iconSize.sm} strokeWidth={iconStroke.regular} />
        <span className="dc-workspace-name">{label}</span>
      </button>
      {open && (
        <div className="dc-workspace-menu" role="menu" aria-label="切换工作区">
          {recent.length > 0 && <div className="dc-workspace-menu-title">最近打开</div>}
          {recent.map((root) => {
            const current = samePath(workspace, root);
            return (
              <button
                key={root}
                type="button"
                role="menuitem"
                className={`dc-workspace-item${current ? " is-current" : ""}`}
                title={root}
                onClick={() => choose(root)}
              >
                <span className="dc-workspace-check">{current && <Check size={iconSize.sm} />}</span>
                <span className="dc-workspace-item-name">{fileName(root) || root}</span>
                <span className="dc-workspace-item-path">{parentDirectory(root)}</span>
              </button>
            );
          })}
          <button type="button" role="menuitem" className="dc-workspace-item is-action" onClick={chooseOther}>
            <span className="dc-workspace-check">
              <FolderOpen size={iconSize.sm} strokeWidth={iconStroke.regular} />
            </span>
            <span className="dc-workspace-item-name">打开其他文件夹…</span>
          </button>
        </div>
      )}
    </div>
  );
}
