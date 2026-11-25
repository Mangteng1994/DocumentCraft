/**
 * 图片路径浮窗（DC-079）。
 *
 * 点击编辑区里的图片时，在图片下方（放不下则在上方）显示它在 Markdown 中的原始路径和解析后的本地位置，
 * 提供复制路径、打开所在文件夹和重命名；重命名会同步整个工作区的 Markdown 引用。
 * 按 Esc、点击浮窗外、窗口失焦、任一区域滚动、文档内容变化或切换文档时关闭。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { errorText } from "../backend";
import { renameDocumentImage, revealInExplorer } from "../documentActions";
import { fileName } from "../paths";
import { useAppStore } from "../store";
import { describeImageSource } from "./assets";
import { isManagedImage } from "./imageReferences";

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
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);

  const close = useCallback(() => {
    if (!busyRef.current) {
      setImagePopover(null);
    }
  }, [setImagePopover]);

  useEffect(() => {
    if (!busyRef.current) {
      setEditing(false);
      setError("");
    }
  }, [popover]);

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
  }, [popover, editing, error, busy]);

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
    const handleScroll = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) {
        close();
      }
    };
    // 滚动事件不冒泡，用捕获阶段才能收到编辑区滚动容器的事件。
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [popover, close]);

  if (!popover) {
    return null;
  }

  const location = describeImageSource(popover.src);
  const copyTarget = location.absolute ?? popover.src;
  const showLocalPath = location.absolute !== null && location.absolute !== popover.src;
  const localName = fileName(location.absolute ?? "");
  const dot = localName.lastIndexOf(".");
  const extension = dot >= 0 ? localName.slice(dot) : "";
  const canRename = Boolean(filePath && location.absolute && !popover.missing && isManagedImage(filePath, location.absolute));

  const startRename = () => {
    setDraftName(dot >= 0 ? localName.slice(0, dot) : localName);
    setError("");
    setEditing(true);
  };

  const commitRename = async () => {
    if (!location.absolute || !canRename || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await renameDocumentImage(location.absolute, draftName);
      setImagePopover(null);
    } catch (failure) {
      const message = errorText(failure);
      if (useAppStore.getState().imagePopover !== popover) {
        useAppStore.getState().setStatus(message);
        setImagePopover(null);
      } else {
        setError(message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

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
      {editing && (
        <form
          className="dc-image-popover-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void commitRename();
          }}
        >
          <label className="dc-image-popover-field">
            <span className="dc-image-popover-label">图片名称（保留 {extension} 扩展名）</span>
            <input
              autoFocus
              className="dc-input"
              aria-label="图片名称（不含扩展名）"
              value={draftName}
              disabled={busy}
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraftName(event.target.value)}
            />
          </label>
          <div className="dc-image-popover-note">同步更新整个工作区 Markdown 中的引用，保留其他未保存的正文修改。</div>
          {error && <div className="dc-image-popover-error" role="alert">{error}</div>}
          <div className="dc-image-popover-actions">
            <button type="submit" className="dc-button is-primary" disabled={busy || !draftName.trim()}>
              {busy ? "正在检查引用并改名…" : "保存名称"}
            </button>
            <button type="button" className="dc-button" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      )}
      {!editing && <div className="dc-image-popover-actions">
        <button type="button" className="dc-button" disabled={!popover.src || busy} onClick={() => void copyPath()}>
          复制路径
        </button>
        {location.kind === "local" && location.absolute && (
          <button type="button" className="dc-button" disabled={popover.missing || busy} onClick={openFolder}>
            打开所在文件夹
          </button>
        )}
        {location.kind === "local" && (
          <button
            type="button"
            className="dc-button"
            disabled={!canRename || busy}
            title={canRename ? "重命名图片文件并同步工作区引用" : "仅支持 assets 内存在的本地图片"}
            onClick={startRename}
          >
            重命名
          </button>
        )}
      </div>}
    </div>
  );
}
