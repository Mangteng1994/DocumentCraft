/**
 * 工作区文件树。行样式与交互参照 VMark FileExplorer/FileNode，去掉了右键菜单、
 * 重命名、拖放和文件监听，只保留浏览与打开。
 */

import { memo, useCallback, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from "lucide-react";
import type { TreeNode } from "../backend";
import { chooseWorkspace, openDocument, refreshTree } from "../documentActions";
import { useAppStore } from "../store";
import { iconSize, iconStroke } from "../styles/tokens";

interface RowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}

const TreeRow = memo(function TreeRow({ node, depth, activePath, expanded, onToggle }: RowProps) {
  const isOpen = expanded.has(node.path);
  const isActive = node.path === activePath;
  const indent = { "--dc-tree-depth": depth } as React.CSSProperties;

  const handleActivate = () => {
    if (node.is_dir) {
      onToggle(node.path);
      return;
    }
    void openDocument(node.path);
  };

  return (
    <li role="none">
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={isActive}
        aria-expanded={node.is_dir ? isOpen : undefined}
        className={`dc-tree-row${isActive ? " is-active" : ""}`}
        style={indent}
        title={node.path}
        onClick={handleActivate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleActivate();
          }
        }}
      >
        <span className="dc-tree-chevron">
          {node.is_dir && (isOpen ? <ChevronDown size={iconSize.sm} /> : <ChevronRight size={iconSize.sm} />)}
        </span>
        <span className="dc-tree-icon">
          {node.is_dir ? (
            <Folder size={iconSize.sm} strokeWidth={iconStroke.regular} />
          ) : (
            <FileText size={iconSize.sm} strokeWidth={iconStroke.regular} />
          )}
        </span>
        <span className="dc-tree-name">{node.name}</span>
      </div>
      {node.is_dir && isOpen && node.children.length > 0 && (
        <ul role="group" className="dc-tree-group">
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

export function FileTree() {
  const tree = useAppStore((state) => state.tree);
  const filePath = useAppStore((state) => state.filePath);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const handleToggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  if (!tree) {
    return (
      <div className="dc-sidebar-empty">
        <p>尚未打开工作区。</p>
        <button type="button" className="dc-button" onClick={() => void chooseWorkspace()}>
          <FolderOpen size={iconSize.sm} />
          打开文件夹
        </button>
      </div>
    );
  }

  return (
    <div className="dc-tree">
      <div className="dc-sidebar-header">
        <span className="dc-sidebar-title" title={tree.path}>
          {tree.name}
        </span>
        <button type="button" className="dc-icon-button" aria-label="刷新目录" title="刷新目录" onClick={() => void refreshTree()}>
          <RefreshCw size={iconSize.sm} />
        </button>
      </div>
      {tree.children.length === 0 ? (
        <div className="dc-sidebar-empty">此文件夹中没有 Markdown 文件。</div>
      ) : (
        <ul role="tree" aria-label="工作区文件" className="dc-tree-root">
          {tree.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={0}
              activePath={filePath}
              expanded={expanded}
              onToggle={handleToggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
