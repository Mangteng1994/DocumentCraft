/**
 * 文件树右键菜单（DC-064、DC-069）：复制、剪切、粘贴、重命名、删除、复制完整文件地址、打开本地目录、属性。
 *
 * 复制和剪切写入系统剪贴板，所以能粘贴到资源管理器等其他程序；资源管理器里复制的文件也能粘贴进来。
 * 粘贴时由后端复制或移动，重名自动改名、不覆盖；在文件上粘贴会粘贴到它所在的文件夹。
 * node 为 null 表示在文件树空白处右键，对象是工作区根目录。
 */

import { useEffect, useState } from "react";
import type { TreeNode } from "../backend";
import { PopupMenu } from "../components/PopupMenu";
import type { MenuEntry } from "../editor/EditorContextMenu";
import {
  copyEntryToClipboard,
  copyPathText,
  deleteEntry,
  pasteEntry,
  readPasteSource,
  revealInExplorer,
  showProperties,
} from "../documentActions";
import { parentDirectory } from "../paths";

export interface TreeMenuState {
  x: number;
  y: number;
  node: TreeNode | null;
}

interface TreeContextMenuProps {
  menu: TreeMenuState;
  /** 工作区根目录，空白处右键时作为粘贴目标和属性对象。 */
  rootPath: string;
  /** 开始重命名：由文件树把该行切换成输入框。 */
  onRename: (node: TreeNode) => void;
  /** 粘贴完成后的回调，文件树据此展开目标文件夹。 */
  onPasted: (targetDir: string) => void;
  onClose: () => void;
}

export function TreeContextMenu({ menu, rootPath, onRename, onPasted, onClose }: TreeContextMenuProps) {
  // 剪贴板里有没有文件要异步读取系统剪贴板，读到之前「粘贴」保持置灰。
  const [canPaste, setCanPaste] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void readPasteSource().then((source) => {
      if (!cancelled) {
        setCanPaste(source !== null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const node = menu.node;
  const pastePath = node ? node.path : rootPath;
  const pasteTarget = node && !node.is_dir ? parentDirectory(node.path) : pastePath;
  const subjectPath = node ? node.path : rootPath;

  const paste = async () => {
    const result = await pasteEntry(pasteTarget);
    if (result && result.done.length > 0) {
      onPasted(pasteTarget);
    }
  };

  const entries: MenuEntry[] = [];
  if (node) {
    entries.push({ label: "复制", run: () => void copyEntryToClipboard(node.path, "copy") });
    entries.push({ label: "剪切", run: () => void copyEntryToClipboard(node.path, "cut") });
  }
  entries.push({ label: "粘贴", disabled: !canPaste, run: () => void paste() });
  if (node) {
    entries.push("separator");
    entries.push({ label: "重命名", run: () => onRename(node) });
    entries.push({ label: "删除", run: () => void deleteEntry(node.path, node.is_dir) });
  }
  entries.push("separator");
  entries.push({ label: "复制完整文件地址", run: () => void copyPathText(subjectPath) });
  entries.push({ label: "打开本地目录", run: () => void revealInExplorer(subjectPath) });
  entries.push({ label: "属性", run: () => showProperties(subjectPath) });

  return <PopupMenu x={menu.x} y={menu.y} entries={entries} onClose={onClose} />;
}
