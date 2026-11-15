/**
 * 工作区文件树。行样式与交互参照 VMark FileExplorer/FileNode，去掉了重命名、拖放和文件监听，
 * 保留浏览、打开、全部折叠与全部展开，以及在选中文件夹下新建 Markdown 和文件夹；
 * 右键菜单提供复制、剪切、粘贴、删除、复制完整文件地址和属性（DC-064）。
 * 工作区很大（网络共享、数万文件）时目录树按需加载：打开时只读顶层，展开哪个文件夹才读取哪个。
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, File, FilePlus, FileText, Folder, FolderOpen, FolderPlus, RefreshCw } from "lucide-react";
import type { TreeNode } from "../backend";
import { chooseWorkspace, createFolderIn, createNote, loadFolder, openDocument, openWithSystem, refreshTree } from "../documentActions";
import { relativePath } from "../paths";
import { useAppStore } from "../store";
import { iconSize, iconStroke } from "../styles/tokens";
import { TreeContextMenu, type TreeMenuState } from "./TreeContextMenu";

const MARKDOWN_NAME = /\.(md|markdown)$/i;

type CreateKind = "note" | "folder";

/** 收集树中已读取的文件夹的路径（不含根目录本身），供「全部展开」使用。按需加载时不会因此去读取未读取的文件夹。 */
function collectLoadedDirectories(node: TreeNode, result: Set<string>): Set<string> {
  for (const child of node.children) {
    if (child.is_dir && child.loaded) {
      result.add(child.path);
      collectLoadedDirectories(child, result);
    }
  }
  return result;
}

/** 已展开但还没读取子项的文件夹路径，需要按需读取。 */
function collectUnloadedExpanded(node: TreeNode, expanded: Set<string>, result: string[]): string[] {
  for (const child of node.children) {
    if (!child.is_dir || !expanded.has(child.path)) {
      continue;
    }
    if (child.loaded) {
      collectUnloadedExpanded(child, expanded, result);
    } else {
      result.push(child.path);
    }
  }
  return result;
}

interface RowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  expanded: Set<string>;
  selectedDir: string | null;
  onToggle: (path: string) => void;
  onSelectDir: (path: string) => void;
  onContextMenu: (x: number, y: number, node: TreeNode) => void;
}

const TreeRow = memo(function TreeRow({ node, depth, activePath, expanded, selectedDir, onToggle, onSelectDir, onContextMenu }: RowProps) {
  // 剪切的条目置灰，提示它粘贴后会被移走。
  const isCut = useAppStore((state) => state.fileClipboard?.mode === "cut" && state.fileClipboard.path === node.path);
  const isOpen = expanded.has(node.path);
  const isActive = node.path === activePath;
  const isTarget = node.is_dir && node.path === selectedDir;
  // 开启「显示所有文件」后出现的非 Markdown 文件：置灰，点击用系统默认应用打开。
  const isOther = !node.is_dir && !MARKDOWN_NAME.test(node.name);
  const indent = { "--dc-tree-depth": depth } as React.CSSProperties;
  const className = ["dc-tree-row", isActive ? "is-active" : "", isTarget ? "is-target" : "", isOther ? "is-other" : "", isCut ? "is-cut" : ""]
    .filter(Boolean)
    .join(" ");

  const handleActivate = () => {
    if (node.is_dir) {
      onToggle(node.path);
      onSelectDir(node.path);
      return;
    }
    if (isOther) {
      void openWithSystem(node.path, node.name);
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
        onContextMenu={(event) => {
          // 阻止冒泡：空白处的右键菜单由外层容器处理，行上的菜单以该行为对象。
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(event.clientX, event.clientY, node);
        }}
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
      {node.is_dir && isOpen && !node.loaded && (
        <div className="dc-tree-hint" style={{ "--dc-tree-depth": depth + 1 } as React.CSSProperties}>
          正在读取…
        </div>
      )}
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
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      )}
      {node.is_dir && isOpen && node.loaded && node.truncated && (
        <div className="dc-tree-hint" style={{ "--dc-tree-depth": depth + 1 } as React.CSSProperties}>
          条目太多，只显示了前一部分。
        </div>
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
  // 右键菜单：位置和右键的条目，空白处右键时 node 为 null。
  const [menu, setMenu] = useState<TreeMenuState | null>(null);
  // 正在读取的文件夹，避免同一个文件夹被重复请求。
  const loading = useRef<Set<string>>(new Set());

  // 按需加载：展开了还没读取子项的文件夹时去读取；刷新目录树后展开的文件夹也会重新读取。
  useEffect(() => {
    if (!tree) {
      return;
    }
    for (const path of collectUnloadedExpanded(tree, expanded, [])) {
      if (loading.current.has(path)) {
        continue;
      }
      loading.current.add(path);
      void loadFolder(path).finally(() => loading.current.delete(path));
    }
  }, [tree, expanded]);

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

  const openMenu = useCallback((x: number, y: number, node: TreeNode | null) => {
    setMenu({ x, y, node });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const targetDir = selectedDir ?? tree?.path ?? "";

  const collapseAll = () => setExpanded(new Set());

  const expandAll = () => {
    if (tree) {
      setExpanded(collectLoadedDirectories(tree, new Set()));
    }
  };

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
    <div
      className="dc-tree"
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, null);
      }}
    >
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
          <button type="button" className="dc-icon-button" aria-label="全部折叠" title="全部折叠" onClick={collapseAll}>
            <ChevronsDownUp size={iconSize.sm} />
          </button>
          <button type="button" className="dc-icon-button" aria-label="全部展开" title="全部展开" onClick={expandAll}>
            <ChevronsUpDown size={iconSize.sm} />
          </button>
          <button type="button" className="dc-icon-button" aria-label="刷新目录" title="刷新目录" onClick={() => void refreshTree()}>
            <RefreshCw size={iconSize.sm} />
          </button>
        </div>
      </div>
      {tree.lazy && (
        <div className="dc-tree-note" role="note">
          这个文件夹很大，已改为按需加载：展开哪个文件夹才读取哪个，不含 Markdown 的文件夹也会显示。
        </div>
      )}
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
              onContextMenu={openMenu}
            />
          ))}
        </ul>
      )}
      {menu && <TreeContextMenu menu={menu} rootPath={tree.path} onClose={closeMenu} />}
    </div>
  );
}
