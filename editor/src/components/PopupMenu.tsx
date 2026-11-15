/**
 * 通用弹出菜单：在指定坐标显示一组菜单项，超出窗口时向内翻转，点击菜单外部、按 Esc 或窗口失焦时关闭。
 * 菜单项的外观与编辑区右键菜单共用 MenuList，文件树右键菜单（DC-064）使用它。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MenuList, type MenuEntry } from "../editor/EditorContextMenu";

interface PopupMenuProps {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

export function PopupMenu({ x, y, entries, onClose }: PopupMenuProps) {
  const container = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // 菜单超出窗口右侧或底部时向内移动，保证完整可见。
  useLayoutEffect(() => {
    if (!container.current) {
      return;
    }
    const rect = container.current.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width);
    const top = Math.min(y, window.innerHeight - rect.height);
    setPosition({ left: Math.max(left, 0), top: Math.max(top, 0) });
  }, [x, y]);

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={container}
      className="dc-context-menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuList entries={entries} onDone={onClose} />
    </div>
  );
}
