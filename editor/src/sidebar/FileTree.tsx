/**
 * 工作区文件树。行样式与交互参照 VMark FileExplorer/FileNode，去掉了右键菜单、
 * 重命名、拖放和文件监听，保留浏览、打开，以及在选中文件夹下新建 Markdown 和文件夹。
 */

import { memo, useCallback, useState } from "react";
import { ChevronDown, ChevronRight, File, FilePlus, FileText, Folder, FolderOpen, FolderPlus, RefreshCw } from "lucide-react";
import type { TreeNode } from "../backend";
import { chooseWorkspace, createFolderIn, createNote, openDocument, refreshTree } from "../documentActions";
import { relativePath } from "../paths";
import { useAppStore } from "../store";
import { iconSize, iconStroke } from "../styles/tokens";

const MARKDOWN_NAME = /\.(md|markdown)$/i;

type CreateKind = "note" | "folder";

interface RowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  expanded: Set<string>;
  selectedDir: string | null;
  onToggle: (path: string) => void;
  onSelectDir: (path: string) => void;
}

const TreeRow = memo(function TreeRow({ node, depth, activePath, expanded, selectedDir, onToggle, onSelectDir }: RowProps) {
  const isOpen = expanded.has(node.path);
  const isActive = node.path === activePath;
  const isTarget = node.is_dir && node.path === selectedDir;
  // 开启「显示所有文件」后出现的非 Markdown 文件：只显示，不能打开。
  const isOther = !node.is_dir && !MARKDOWN_NAME.test(node.name);
  const indent = { "--dc-tree-depth": depth } as React.CSSProperties;
  const className = ["dc-tree-row", isActive ? "is-active" : "", isTarget ? "is-target" : "", isOther ? "is-other" : ""]
    .filter(Boolean)
    .join(" ");

  const handleActivate = () => {
    if (node.is_dir) {
      onToggle(node.path);
      onSelectDir(node.path);
      return;
    }
    if (isOther) {
      useAppStore.getState().setStatus(`${node.name} 不是 Markdown 文件，不能在编辑器中打开。`);
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
        className={className}
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
          ) : isOther ? (
            <File size={iconSize.sm} strokeWidth={iconStroke.regular} />
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
              selectedDir={selectedDir}
              onToggle={onToggle}
              onSelectDir={onSelectDir}
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
  // 新建条目所在的文件夹：最近点击的文件夹，未点击时为工作区根目录。
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreateKind | null>(null);
  const [draftName, setDraftName] = useState("");

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

  const targetDir = selectedDir ?? tree?.path ?? "";

  const startCreate = (kind: CreateKind) => {
    setCreating(kind);
    setDraftName("");
  };

  const cancelCreate = () => {
    setCreating(null);
    setDraftName("");
  };

  const submitCreate = async () => {
    const name = draftName.trim();
    if (!creating || !name) {
      cancelCreate();
      return;
    }
    const created = creating === "note" ? await createNote(targetDir, name) : await createFolderIn(targetDir, name);
    if (created === null) {
      // 失败原因（如同名文件已存在）显示在状态栏，输入框保留以便修改。
      return;
    }
    // 新文件夹展开并成为新建目标，新笔记所在的文件夹保持展开。
    const expandedPath = creating === "folder" ? created : targetDir;
    setExpanded((previous) => new Set(previous).add(expandedPath));
    if (creating === "folder") {
      setSelectedDir(created);
    }
    cancelCreate();
  };

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

  const createLabel = creating === "note" ? "新建 Markdown" : "新建文件夹";
  const targetLabel = relativePath(tree.path, targetDir) || "工作区根目录";

  return (
    <div className="dc-tree">
      <div className="dc-sidebar-header">
        <span className="dc-sidebar-title" title={tree.path}>
          {tree.name}
        </span>
        <div className="dc-sidebar-actions">
          <button type="button" className="dc-icon-button" aria-label="新建 Markdown" title="新建 Markdown" onClick={() => startCreate("note")}>
            <FilePlus size={iconSize.sm} />
          </button>
          <button type="button" className="dc-icon-button" aria-label="新建文件夹" title="新建文件夹" onClick={() => startCreate("folder")}>
            <FolderPlus size={iconSize.sm} />
          </button>
          <button type="button" className="dc-icon-button" aria-label="刷新目录" title="刷新目录" onClick={() => void refreshTree()}>
            <RefreshCw size={iconSize.sm} />
          </button>
        </div>
      </div>
      {creating && (
        <div className="dc-tree-create">
          <div className="dc-tree-create-hint">
            {createLabel} · {targetLabel}
          </div>
          <input
            autoFocus
            className="dc-input"
            value={draftName}
            placeholder={creating === "note" ? "文件名（可省略 .md）" : "文件夹名称"}
            aria-label={creating === "note" ? "新 Markdown 文件名" : "新文件夹名称"}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => {
              if (!draftName.trim()) {
                cancelCreate();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitCreate();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                cancelCreate();
              }
            }}
          />
        </div>
      )}
      {tree.children.length === 0 ? (
        <div className="dc-sidebar-empty">此文件夹中没有 Markdown 文件，可用上方按钮新建。</div>
      ) : (
        <ul role="tree" aria-label="工作区文件" className="dc-tree-root">
          {tree.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={0}
              activePath={filePath}
              expanded={expanded}
              selectedDir={selectedDir}
              onToggle={handleToggle}
              onSelectDir={setSelectedDir}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
