/**
 * 编辑区右键菜单。
 *
 * 常规编辑（剪切、复制、粘贴、全选）、插入表格、插入图片、表格内的行列操作、添加批注，以及 Copilot 子菜单：
 * Quick Ask、添加选区到对话，和设置了「显示在右键菜单」的命令。菜单项旁显示当前绑定的快捷键。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useSettings } from "../settings/settingsStore";
import type { ActionId } from "../settings/schema";
import { useAppStore } from "../store";
import { iconSize } from "../styles/tokens";
import { useCopilot } from "../features/copilot/copilotStore";
import { chooseAndInsertImage, copyEditorSelection, pasteFromSystemClipboard } from "./imageSupport";
import { addSelectionToChat } from "../features/copilot/actions";
import { anchorFromSelection } from "./annotations";
import { currentSelection, isInTable, runTableAction, type TableAction } from "./editorCommands";
import { getEditor } from "./editorHandle";

export interface MenuItem {
  label: string;
  hotkey?: ActionId;
  disabled?: boolean;
  run?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuItem | "separator";

const TABLE_ITEMS: { label: string; action: TableAction }[] = [
  { label: "在上方插入行", action: "addRowBefore" },
  { label: "在下方插入行", action: "addRowAfter" },
  { label: "在左侧插入列", action: "addColumnBefore" },
  { label: "在右侧插入列", action: "addColumnAfter" },
  { label: "删除行", action: "deleteRow" },
  { label: "删除列", action: "deleteColumn" },
  { label: "删除表格", action: "deleteTable" },
];

export function MenuList({ entries, onDone }: { entries: MenuEntry[]; onDone: () => void }) {
  const hotkeys = useSettings((state) => state.settings.hotkeys);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <ul className="dc-menu" role="menu">
      {entries.map((entry, index) => {
        if (entry === "separator") {
          return <li key={`s${index}`} className="dc-menu-separator" role="separator" />;
        }
        const shortcut = entry.hotkey ? hotkeys[entry.hotkey] : "";
        return (
          <li key={entry.label} className="dc-menu-entry" onMouseEnter={() => setOpenIndex(index)}>
            <button
              type="button"
              role="menuitem"
              className="dc-menu-item"
              disabled={entry.disabled}
              aria-haspopup={entry.submenu ? "menu" : undefined}
              onClick={() => {
                if (entry.submenu) {
                  setOpenIndex(index);
                  return;
                }
                onDone();
                entry.run?.();
              }}
            >
              <span>{entry.label}</span>
              {shortcut && <span className="dc-menu-shortcut">{shortcut}</span>}
              {entry.submenu && <ChevronRight size={iconSize.sm} />}
            </button>
            {entry.submenu && openIndex === index && (
              <div className="dc-submenu">
                <MenuList entries={entry.submenu} onDone={onDone} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function EditorContextMenu() {
  const menu = useAppStore((state) => state.contextMenu);
  const setContextMenu = useAppStore((state) => state.setContextMenu);
  const setOverlay = useAppStore((state) => state.setOverlay);
  const requestComment = useAppStore((state) => state.requestComment);
  const commands = useCopilot((state) => state.commands);
  const container = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const close = () => setContextMenu(null);

  // 菜单超出窗口时向左上方翻转。
  useLayoutEffect(() => {
    if (!menu || !container.current) {
      return;
    }
    const rect = container.current.getBoundingClientRect();
    const left = Math.min(menu.x, window.innerWidth - rect.width);
    const top = Math.min(menu.y, window.innerHeight - rect.height);
    setPosition({ left: Math.max(left, 0), top: Math.max(top, 0) });
  }, [menu]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const handlePointer = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        close();
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  if (!menu) {
    return null;
  }

  const editor = getEditor();
  const hasSelection = !!editor && !editor.state.selection.empty;
  const hasTextSelection = currentSelection() !== null;
  const inTable = isInTable();

  const addComment = () => {
    if (!editor) {
      return;
    }
    const anchor = anchorFromSelection(editor.state);
    if (anchor) {
      requestComment(anchor);
    }
  };

  const commandItems: MenuItem[] = commands
    .filter((command) => command.showInContextMenu)
    .map((command) => ({ label: command.name, run: () => setOverlay({ kind: "quickAsk", commandName: command.name }) }));

  const copilotMenu: MenuEntry[] = [
    { label: "Quick Ask", hotkey: "quickAsk", run: () => setOverlay({ kind: "quickAsk" }) },
    { label: "添加选区到对话", hotkey: "addSelectionToChat", disabled: !hasTextSelection, run: addSelectionToChat },
  ];
  if (commandItems.length > 0) {
    copilotMenu.push("separator", ...commandItems);
  }

  const entries: MenuEntry[] = [
    { label: "剪切", disabled: !hasSelection, run: () => void copyEditorSelection(true) },
    { label: "复制", disabled: !hasSelection, run: () => void copyEditorSelection(false) },
    { label: "粘贴", run: () => void pasteFromSystemClipboard() },
    { label: "全选", run: () => editor?.chain().focus().selectAll().run() },
    "separator",
    { label: "插入表格…", hotkey: "insertTable", run: () => setOverlay({ kind: "insertTable" }) },
    { label: "插入图片…", run: () => void chooseAndInsertImage() },
  ];
  if (inTable) {
    entries.push({ label: "表格", submenu: TABLE_ITEMS.map((item) => ({ label: item.label, run: () => runTableAction(item.action) })) });
  }
  entries.push("separator", { label: "添加批注", disabled: !hasTextSelection, run: addComment }, { label: "Copilot", submenu: copilotMenu });

  return (
    <div
      ref={container}
      className="dc-context-menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuList entries={entries} onDone={close} />
    </div>
  );
}
