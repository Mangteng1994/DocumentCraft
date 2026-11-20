/**
 * 工作区文件树。行样式与交互参照 VMark FileExplorer/FileNode，去掉了文件监听，
 * 保留浏览、打开、全部折叠与全部展开，以及在选中文件夹下新建 Markdown 和文件夹。
 *
 * 文件操作（DC-064、DC-069）：
 * - 右键菜单：复制、剪切、粘贴、重命名、删除、复制完整文件地址、打开本地目录、属性；快捷键 Ctrl+C/X/V、F2、Delete；
 * - 复制和剪切写入系统剪贴板，所以资源管理器里复制的文件也能粘贴进来；
 * - 左键按住文件或文件夹拖动，放到目标文件夹上即移动，按住 Ctrl 放下则复制；
 * - 从资源管理器等外部把文件拖进来，放到哪个文件夹上就复制到哪个文件夹，放在空白处则复制到工作区根目录。
 * 树内拖动用指针事件自己实现：Tauri 在 Windows 上为接收外部文件会接管整个窗口的拖放，网页自带的 HTML5 拖放不会触发。
 * 工作区很大（网络共享、数万文件）时目录树按需加载：打开时只读顶层，展开哪个文件夹才读取哪个。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUpDown, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, File, FilePlus, FileText, Folder, FolderOpen, FolderPlus, RefreshCw } from "lucide-react";
import type { TreeNode } from "../backend";
import {
  chooseWorkspace,
  copyEntryToClipboard,
  createFolderIn,
  createNote,
  deleteEntry,
  isInside,
  loadFolder,
  openDocument,
  openWithSystem,
  pasteEntry,
  refreshTree,
  remapPath,
  renamePath,
  transferAndReport,
} from "../documentActions";
import { fileName, parentDirectory, relativePath } from "../paths";
import { PopupMenu } from "../components/PopupMenu";
import type { MenuEntry } from "../editor/EditorContextMenu";
import { SORT_KEYS, type FileColorRule, type SortKey } from "../settings/schema";
import { useSettings } from "../settings/settingsStore";
import { useAppStore } from "../store";
import { iconSize, iconStroke } from "../styles/tokens";
import { sortNodes } from "./sortTree";
import { TreeContextMenu, type TreeMenuState } from "./TreeContextMenu";

const MARKDOWN_NAME = /\.(md|markdown)$/i;

/** 按下后移动超过这个距离（像素）才算开始拖动，避免点击时手抖被当成拖动。 */
const DRAG_THRESHOLD = 5;

type CreateKind = "note" | "folder";

/**
 * 五彩文档大纲（DC-068）：按文件名结尾匹配规则，返回颜色；没有命中返回 null。
 *
 * 多条规则都命中时取扩展名最长的一条，例如 ".tar.gz" 优先于 ".gz"。
 */
function fileColorFor(name: string, rules: FileColorRule[]): string | null {
  const lowerName = name.toLowerCase();
  let bestColor: string | null = null;
  let bestLength = 0;
  for (const rule of rules) {
    for (const extension of rule.extensions) {
      if (extension.length > bestLength && lowerName.endsWith(extension)) {
        bestColor = rule.color;
        bestLength = extension.length;
      }
    }
  }
  return bestColor;
}

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

function samePath(left: string, right: string): boolean {
  return isInside(left, right) && isInside(right, left);
}

/**
 * 屏幕坐标（CSS 像素）下的放置目标文件夹：落在文件夹行上是该文件夹，落在文件行上是它所在的文件夹，
 * 落在文件树的其他位置（空白、标题栏）是工作区根目录，不在文件树内返回 null。
 */
function dropTargetAt(x: number, y: number, rootPath: string): string | null {
  const element = document.elementFromPoint(x, y);
  if (!element) {
    return null;
  }
  const row = element.closest<HTMLElement>("[data-tree-path]");
  if (row) {
    const path = row.dataset.treePath ?? "";
    return row.dataset.treeDir === "1" ? path : parentDirectory(path);
  }
  return element.closest(".dc-tree") ? rootPath : null;
}

/** 树内拖动能不能放到 targetDir：不能放进自己或自己的子文件夹；移动时放回原文件夹没有意义。复制不受后一条限制。 */
function canDropInto(source: TreeNode, targetDir: string, copy: boolean): boolean {
  if (isInside(targetDir, source.path)) {
    return false;
  }
  if (!copy && samePath(parentDirectory(source.path), targetDir)) {
    return false;
  }
  return true;
}

/** 正在进行的树内拖动：被拖的条目、指针位置、有效的放置目标（无效为 null）和是否复制。 */
interface DragState {
  node: TreeNode;
  x: number;
  y: number;
  target: string | null;
  copy: boolean;
}

interface RenameInputProps {
  initialName: string;
  isDir: boolean;
  /** 提交新名称；返回 true 表示已完成（成功或名称没变），false 表示失败、保持编辑。 */
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}

/** 行内重命名输入框：默认选中不含扩展名的部分；Enter 提交，Esc 取消，点到别处视为提交（失败则放弃编辑）。 */
function RenameInput({ initialName, isDir, onCommit, onCancel }: RenameInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  const busy = useRef(false);
  // 提交成功或取消之后，输入框随后触发的失焦不能再提交一次。
  const finished = useRef(false);

  useEffect(() => {
    const element = input.current;
    if (!element) {
      return;
    }
    element.focus();
    const dot = isDir ? -1 : initialName.lastIndexOf(".");
    element.setSelectionRange(0, dot > 0 ? dot : initialName.length);
  }, [initialName, isDir]);

  const commit = async (viaBlur: boolean) => {
    if (busy.current || finished.current) {
      return;
    }
    busy.current = true;
    const done = await onCommit(value);
    busy.current = false;
    if (done) {
      finished.current = true;
    } else if (viaBlur) {
      finished.current = true;
      onCancel();
    }
  };

  return (
    <input
      ref={input}
      className="dc-tree-rename"
      value={value}
      aria-label="新名称"
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      // 输入框里的点击和按键不能冒泡到行上，否则会触发打开、拖动和行快捷键。
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onBlur={() => void commit(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          void commit(false);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finished.current = true;
          onCancel();
        }
      }}
    />
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  expanded: Set<string>;
  selectedDir: string | null;
  /** 正在重命名的条目路径。 */
  renaming: string | null;
  /** 拖动或外部拖入时高亮的放置目标文件夹。 */
  dropDir: string | null;
  /** 右键菜单当前指向的条目路径，菜单打开期间保持选中效果。 */
  menuPath: string | null;
  onToggle: (path: string) => void;
  onSelectDir: (path: string) => void;
  onContextMenu: (x: number, y: number, node: TreeNode) => void;
  onPointerDown: (event: React.PointerEvent, node: TreeNode) => void;
  onStartRename: (node: TreeNode) => void;
  onFinishRename: (node: TreeNode, name: string) => Promise<boolean>;
  onCancelRename: () => void;
  onPasteInto: (node: TreeNode) => void;
}

/** 排序菜单中各依据的显示名。 */
const SORT_LABELS: Record<SortKey, string> = { name: "名称", modified: "修改时间", type: "文件类型" };

const TreeRow = memo(function TreeRow(props: RowProps) {
  const { node, depth, activePath, expanded, selectedDir, renaming, dropDir, menuPath } = props;
  const { onToggle, onSelectDir, onContextMenu, onPointerDown, onStartRename, onFinishRename, onCancelRename, onPasteInto } = props;
  // 剪切的条目置灰，提示它粘贴后会被移走。
  const isCut = useAppStore((state) => state.fileClipboard?.mode === "cut" && state.fileClipboard.path === node.path);
  const sortKey = useSettings((state) => state.settings.files.sortKey);
  const sortDescending = useSettings((state) => state.settings.files.sortDescending);
  const sortedChildren = useMemo(() => sortNodes(node.children, sortKey, sortDescending), [node.children, sortKey, sortDescending]);
  const isOpen = expanded.has(node.path);
  const isActive = node.path === activePath;
  const isTarget = node.is_dir && node.path === selectedDir;
  const isDrop = node.is_dir && dropDir !== null && samePath(node.path, dropDir);
  const isMenuTarget = menuPath !== null && node.path === menuPath;
  const isRenaming = renaming === node.path;
  // 开启「显示所有文件」后出现的非 Markdown 文件：置灰，点击用系统默认应用打开。
  const isOther = !node.is_dir && !MARKDOWN_NAME.test(node.name);
  // 选择器只返回颜色字符串，规则变化时只有颜色变了的行重新渲染。
  const fileColor = useSettings((state) => {
    const colorful = state.settings.colorfulOutline;
    if (node.is_dir || !colorful.enabled) {
      return null;
    }
    return fileColorFor(node.name, colorful.rules);
  });
  const rowStyle: Record<string, string | number> = { "--dc-tree-depth": depth };
  if (fileColor) {
    rowStyle["--dc-tree-file-color"] = fileColor;
  }
  const indent = rowStyle as React.CSSProperties;
  const className = [
    "dc-tree-row",
    isActive ? "is-active" : "",
    isTarget ? "is-target" : "",
    isOther ? "is-other" : "",
    fileColor ? "has-file-color" : "",
    isCut ? "is-cut" : "",
    isDrop ? "is-drop" : "",
    isMenuTarget ? "is-menu-target" : "",
  ]
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

  /** 单击：文件夹展开收起、Markdown 打开；其他文件交给双击，避免单击误调起外部程序。 */
  const handleClick = () => {
    if (isOther) {
      return;
    }
    handleActivate();
  };

  /** 双击：非 Markdown 文件用系统默认程序打开（DC-070）。 */
  const handleDoubleClick = () => {
    if (isOther) {
      handleActivate();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // 只处理行自己获得焦点时的按键；输入框里的按键由输入框处理。
    if (event.target !== event.currentTarget) {
      return;
    }
    const withCommand = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleActivate();
    } else if (event.key === "F2") {
      event.preventDefault();
      onStartRename(node);
    } else if (event.key === "Delete") {
      event.preventDefault();
      void deleteEntry(node.path, node.is_dir);
    } else if (withCommand && key === "c") {
      event.preventDefault();
      void copyEntryToClipboard(node.path, "copy");
    } else if (withCommand && key === "x") {
      event.preventDefault();
      void copyEntryToClipboard(node.path, "cut");
    } else if (withCommand && key === "v") {
      event.preventDefault();
      onPasteInto(node);
    }
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
        data-tree-path={node.path}
        data-tree-dir={node.is_dir ? "1" : "0"}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onPointerDown={(event) => onPointerDown(event, node)}
        onContextMenu={(event) => {
          // 阻止冒泡：空白处的右键菜单由外层容器处理，行上的菜单以该行为对象。
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(event.clientX, event.clientY, node);
        }}
        onKeyDown={handleKeyDown}
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
        {isRenaming ? (
          <RenameInput
            initialName={node.name}
            isDir={node.is_dir}
            onCommit={(name) => onFinishRename(node, name)}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="dc-tree-name">{node.name}</span>
        )}
      </div>
      {node.is_dir && isOpen && !node.loaded && (
        <div className="dc-tree-hint" style={{ "--dc-tree-depth": depth + 1 } as React.CSSProperties}>
          正在读取…
        </div>
      )}
      {node.is_dir && isOpen && node.children.length > 0 && (
        <ul role="group" className="dc-tree-group">
          {sortedChildren.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              expanded={expanded}
              selectedDir={selectedDir}
              renaming={renaming}
              dropDir={dropDir}
              menuPath={menuPath}
              onToggle={onToggle}
              onSelectDir={onSelectDir}
              onContextMenu={onContextMenu}
              onPointerDown={onPointerDown}
              onStartRename={onStartRename}
              onFinishRename={onFinishRename}
              onCancelRename={onCancelRename}
              onPasteInto={onPasteInto}
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
  const [renaming, setRenaming] = useState<string | null>(null);
  // 排序菜单（DC-071）：依据与方向保存在设置中，排序只在渲染时进行。
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);
  const sortKey = useSettings((state) => state.settings.files.sortKey);
  const sortDescending = useSettings((state) => state.settings.files.sortDescending);
  const updateSettings = useSettings((state) => state.update);
  const sortedTreeChildren = useMemo(() => (tree ? sortNodes(tree.children, sortKey, sortDescending) : []), [tree, sortKey, sortDescending]);
  // 树内拖动的状态，以及从外部拖入文件时指针下的目标文件夹。
  const [drag, setDrag] = useState<DragState | null>(null);
  const [externalTarget, setExternalTarget] = useState<string | null>(null);
  // 正在读取的文件夹，避免同一个文件夹被重复请求。
  const loading = useRef<Set<string>>(new Set());
  // 拖动和外部拖入的监听函数是长期存在的，用 ref 读到最新的目录树。
  const treeRef = useRef(tree);
  treeRef.current = tree;

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

  /** 展开文件夹，让粘贴、拖入的结果马上可见。根目录始终可见，不需要展开。 */
  const revealFolder = useCallback((path: string) => {
    if (treeRef.current && samePath(path, treeRef.current.path)) {
      return;
    }
    setExpanded((previous) => new Set(previous).add(path));
  }, []);

  /** 文件夹改名或移动后，里面已展开的文件夹和选中的目标文件夹也要跟着换成新路径。 */
  const remapFolderState = useCallback((from: string, to: string) => {
    setExpanded((previous) => {
      const next = new Set<string>();
      for (const path of previous) {
        next.add(remapPath(path, from, to));
      }
      return next;
    });
    setSelectedDir((previous) => (previous ? remapPath(previous, from, to) : previous));
  }, []);

  const startRename = useCallback((node: TreeNode) => {
    setMenu(null);
    setRenaming(node.path);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const finishRename = useCallback(
    async (node: TreeNode, name: string): Promise<boolean> => {
      const target = await renamePath(node.path, name);
      if (target === null) {
        return false;
      }
      setRenaming(null);
      if (target !== node.path) {
        remapFolderState(node.path, target);
      }
      return true;
    },
    [remapFolderState],
  );

  const pasteInto = useCallback(
    async (node: TreeNode) => {
      const targetDir = node.is_dir ? node.path : parentDirectory(node.path);
      const result = await pasteEntry(targetDir);
      if (result && result.done.length > 0) {
        revealFolder(targetDir);
      }
    },
    [revealFolder],
  );

  /** 把条目放到 targetDir：copy 为 true 是复制，否则是移动。成功后展开目标文件夹，移动文件夹时同步展开状态。 */
  const dropEntries = useCallback(
    async (paths: string[], targetDir: string, copy: boolean) => {
      const verb = copy ? "已复制" : "已移动";
      const result = await transferAndReport(paths, targetDir, copy ? "copy" : "move", verb);
      if (result.done.length === 0) {
        return;
      }
      revealFolder(targetDir);
      if (!copy) {
        for (const item of result.done) {
          remapFolderState(item.from, item.to);
        }
      }
    },
    [remapFolderState, revealFolder],
  );

  // 外部拖入：Tauri 把拖入的文件路径通过窗口事件传来，位置是物理像素，换算成 CSS 像素后找出指针下的文件夹。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "leave") {
            setExternalTarget(null);
            return;
          }
          const root = treeRef.current?.path;
          if (!root) {
            return;
          }
          const ratio = window.devicePixelRatio || 1;
          const target = dropTargetAt(payload.position.x / ratio, payload.position.y / ratio, root);
          if (payload.type === "drop") {
            setExternalTarget(null);
            if (target && payload.paths.length > 0) {
              void dropEntries(payload.paths, target, true);
            }
            return;
          }
          setExternalTarget(target);
        })
        .then((dispose) => {
          if (disposed) {
            dispose();
          } else {
            unlisten = dispose;
          }
        })
        .catch(() => undefined);
    } catch {
      // 不在 Tauri 窗口里（浏览器预览）时没有拖放事件。
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dropEntries]);

  // 树内拖动：按下后移动超过阈值才开始；松开时放在有效的目标文件夹上，按 Esc 或指针被中断则取消。
  const handlePointerDown = useCallback(
    (event: React.PointerEvent, node: TreeNode) => {
      if (event.button !== 0) {
        return;
      }
      const track = { startX: event.clientX, startY: event.clientY, active: false };

      const targetFor = (moveEvent: PointerEvent) => {
        const root = treeRef.current?.path ?? "";
        const target = dropTargetAt(moveEvent.clientX, moveEvent.clientY, root);
        const copy = moveEvent.ctrlKey;
        const valid = target !== null && canDropInto(node, target, copy);
        return { target: valid ? target : null, copy };
      };

      const stop = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        window.removeEventListener("keydown", handleKey);
      };

      const handleMove = (moveEvent: PointerEvent) => {
        if (!track.active) {
          const distance = Math.hypot(moveEvent.clientX - track.startX, moveEvent.clientY - track.startY);
          if (distance < DRAG_THRESHOLD) {
            return;
          }
          track.active = true;
        }
        const { target, copy } = targetFor(moveEvent);
        setDrag({ node, x: moveEvent.clientX, y: moveEvent.clientY, target, copy });
      };

      const finish = (upEvent: PointerEvent | null) => {
        stop();
        if (!track.active) {
          return;
        }
        setDrag(null);
        // 拖动结束时浏览器还会补发一次 click，吞掉它，否则松手的位置会被当成点击而打开文件或展开文件夹。
        const swallow = (clickEvent: MouseEvent) => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallow, true), 200);
        if (!upEvent) {
          return;
        }
        const { target, copy } = targetFor(upEvent);
        if (target) {
          void dropEntries([node.path], target, copy);
        }
      };

      const handleUp = (upEvent: PointerEvent) => finish(upEvent);
      const handleCancel = () => finish(null);
      const handleKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape") {
          finish(null);
        }
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleCancel);
      window.addEventListener("keydown", handleKey);
    },
    [dropEntries],
  );

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

  const sortEntries: MenuEntry[] = [
    ...SORT_KEYS.map((key) => ({
      label: `${key === sortKey ? "✓ " : "　"}${SORT_LABELS[key]}`,
      run: () => updateSettings("files", { sortKey: key }),
    })),
    "separator",
    { label: `${sortDescending ? "　" : "✓ "}${sortKey === "modified" ? "最早在前" : "升序"}`, run: () => updateSettings("files", { sortDescending: false }) },
    { label: `${sortDescending ? "✓ " : "　"}${sortKey === "modified" ? "最近在前" : "降序"}`, run: () => updateSettings("files", { sortDescending: true }) },
  ];

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
  // 高亮的放置目标：树内拖动的有效目标优先，否则是外部拖入时指针下的文件夹。
  const dropDir = drag ? drag.target : externalTarget;
  const dropOnRoot = dropDir !== null && samePath(dropDir, tree.path);
  const containerClass = ["dc-tree", drag ? "is-dragging" : "", dropOnRoot ? "is-drop-root" : ""].filter(Boolean).join(" ");
  const ghostStyle = drag ? ({ "--dc-drag-x": drag.x, "--dc-drag-y": drag.y } as React.CSSProperties) : undefined;
  const ghostHint = drag
    ? drag.target
      ? `${drag.copy ? "复制" : "移动"}到「${samePath(drag.target, tree.path) ? tree.name : fileName(drag.target)}」`
      : "不能放在这里"
    : "";

  return (
    <div
      className={containerClass}
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
          <button
            type="button"
            className="dc-icon-button"
            aria-label="排序方式"
            title="排序方式"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setSortMenu({ x: rect.left, y: rect.bottom });
            }}
          >
            <ArrowUpDown size={iconSize.sm} />
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
        <div className="dc-sidebar-empty">此文件夹中没有 Markdown 文件，可用上方按钮新建，或把文件拖到这里。</div>
      ) : (
        <ul role="tree" aria-label="工作区文件" className="dc-tree-root">
          {sortedTreeChildren.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={0}
              activePath={filePath}
              expanded={expanded}
              selectedDir={selectedDir}
              renaming={renaming}
              dropDir={dropDir}
              menuPath={menu?.node?.path ?? null}
              onToggle={handleToggle}
              onSelectDir={setSelectedDir}
              onContextMenu={openMenu}
              onPointerDown={handlePointerDown}
              onStartRename={startRename}
              onFinishRename={finishRename}
              onCancelRename={cancelRename}
              onPasteInto={(node) => void pasteInto(node)}
            />
          ))}
        </ul>
      )}
      {sortMenu && <PopupMenu x={sortMenu.x} y={sortMenu.y} entries={sortEntries} onClose={() => setSortMenu(null)} />}
      {menu && <TreeContextMenu menu={menu} rootPath={tree.path} onRename={startRename} onPasted={revealFolder} onClose={closeMenu} />}
      {drag && (
        <div className={`dc-tree-ghost${drag.target ? "" : " is-invalid"}`} style={ghostStyle}>
          <span className="dc-tree-ghost-name">
            {drag.node.is_dir ? <Folder size={iconSize.sm} strokeWidth={iconStroke.regular} /> : <FileText size={iconSize.sm} strokeWidth={iconStroke.regular} />}
            {drag.node.name}
          </span>
          <span className="dc-tree-ghost-hint">{ghostHint}</span>
        </div>
      )}
    </div>
  );
}
