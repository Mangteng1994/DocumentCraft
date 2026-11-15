/**
 * 文件树右键菜单（DC-064）：复制、剪切、粘贴、删除、复制完整文件地址、属性。
 *
 * 复制和剪切只在应用内记录条目，粘贴时由后端复制或移动，重名自动改名、不覆盖；
 * 在文件上粘贴会粘贴到它所在的文件夹。node 为 null 表示在文件树空白处右键，对象是工作区根目录。
 */

import type { TreeNode } from "../backend";
import { PopupMenu } from "../components/PopupMenu";
import type { MenuEntry } from "../editor/EditorContextMenu";
import { copyEntryToClipboard, copyPathText, deleteEntry, pasteEntry, showProperties } from "../documentActions";
import { parentDirectory } from "../paths";
import { useAppStore } from "../store";

export interface TreeMenuState {
  x: number;
  y: number;
  node: TreeNode | null;
}

interface TreeContextMenuProps {
  menu: TreeMenuState;
  /** 工作区根目录，空白处右键时作为粘贴目标和属性对象。 */
  rootPath: string;
  onClose: () => void;
}

export function TreeContextMenu({ menu, rootPath, onClose }: TreeContextMenuProps) {
  const clipboard = useAppStore((state) => state.fileClipboard);
  const node = menu.node;
  const pastePath = node ? node.path : rootPath;
  const pasteTarget = node && !node.is_dir ? parentDirectory(node.path) : pastePath;
  const subjectPath = node ? node.path : rootPath;

  const entries: MenuEntry[] = [];
  if (node) {
    entries.push({ label: "复制", run: () => copyEntryToClipboard(node.path, "copy") });
    entries.push({ label: "剪切", run: () => copyEntryToClipboard(node.path, "cut") });
  }
  entries.push({ label: "粘贴", disabled: !clipboard, run: () => void pasteEntry(pasteTarget) });
  if (node) {
    entries.push("separator");
    entries.push({ label: "删除", run: () => void deleteEntry(node.path, node.is_dir) });
  }
  entries.push("separator");
  entries.push({ label: "复制完整文件地址", run: () => void copyPathText(subjectPath) });
  entries.push({ label: "属性", run: () => showProperties(subjectPath) });

  return <PopupMenu x={menu.x} y={menu.y} entries={entries} onClose={onClose} />;
}
