/**
 * 图片路径浮窗（DC-079）。
 *
 * 点击编辑区里的图片时，在图片下方（放不下则在上方）显示它在 Markdown 中的原始路径和解析后的本地位置，
 * 提供复制路径与打开所在文件夹，用法接近思源笔记。浮窗只展示和复制路径，不修改文档。
 * 按 Esc、点击浮窗外、窗口失焦、任一区域滚动、文档内容变化或切换文档时关闭。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { errorText } from "../backend";
import { revealInExplorer } from "../documentActions";
import { useAppStore } from "../store";
import { describeImageSource } from "./assets";

/** 路径过长（例如内嵌的 data URI）时界面只显示开头，复制仍然是完整内容。 */
const DISPLAY_LIMIT = 240;

function shortened(value: string): string {
  return value.length > DISPLAY_LIMIT ? `${value.slice(0, DISPLAY_LIMIT)}…` : value;
}

export function ImagePathPopover() {
  const popover = useAppStore((state) => state.imagePopover);
  const setImagePopover = useAppStore((state) => state.setImagePopover);
  const docVersion = useAppStore((state) => state.docVersion);
  const filePath = useAppStore((state) => state.filePath);
  const container = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const close = useCallback(() => setImagePopover(null), [setImagePopover]);

  // 文档内容变化或切换文档后，图片的位置与路径都可能不再对应，直接关闭。
  useEffect(() => {
    close();
  }, [docVersion, filePath, close]);

  // 默认放在图片下方；下方放不下时翻到图片上方；水平方向限制在窗口内。
  useLayoutEffect(() => {
    const element = container.current;
    if (!popover || !element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(element).marginTop) || 0;
    const fitsBelow = popover.bottom + rect.height + 2 * gap <= window.innerHeight;
    const top = fitsBelow ? popover.bottom : Math.max(popover.top - rect.height - 2 * gap, 0);
    const left = Math.max(Math.min(popover.left, window.innerWidth - rect.width), 0);
    setPosition({ left, top });
  }, [popover]);

  useEffect(() => {
    if (!popover) {
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
    // 滚动事件不冒泡，用捕获阶段才能收到编辑区滚动容器的事件。
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [popover, close]);

  if (!popover) {
    return null;
  }

  const location = describeImageSource(popover.src);
  const copyTarget = location.absolute ?? popover.src;
  const showLocalPath = location.absolute !== null && location.absolute !== popover.src;

  const copyPath = async () => {
    const store = useAppStore.getState();
    try {
      await writeClipboard(copyTarget);
      store.setStatus("已复制图片路径");
    } catch (error) {
      store.setStatus(errorText(error));
    }
    close();
  };

  const openFolder = () => {
    if (location.absolute) {
      void revealInExplorer(location.absolute);
    }
    close();
  };

  return (
    <div
      ref={container}
      className="dc-image-popover"
      role="dialog"
      aria-label="图片路径"
      style={{ left: position.left, top: position.top }}
    >
      <div className="dc-image-popover-field">
        <span className="dc-image-popover-label">Markdown 中的路径</span>
        <code className="dc-image-popover-path">{popover.src ? shortened(popover.src) : "（空）"}</code>
      </div>
      {showLocalPath && (
        <div className="dc-image-popover-field">
          <span className="dc-image-popover-label">本地位置</span>
          <code className="dc-image-popover-path">{shortened(location.absolute ?? "")}</code>
        </div>
      )}
      {popover.missing && <div className="dc-image-popover-note">找不到这张图片，请检查上面的路径。</div>}
      <div className="dc-image-popover-actions">
        <button type="button" className="dc-button" disabled={!popover.src} onClick={() => void copyPath()}>
          复制路径
        </button>
        {location.kind === "local" && location.absolute && (
          <button type="button" className="dc-button" disabled={popover.missing} onClick={openFolder}>
            打开所在文件夹
          </button>
        )}
      </div>
    </div>
  );
}
