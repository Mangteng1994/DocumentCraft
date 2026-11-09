/**
 * 全局快捷键分发。按设置中的绑定在捕获阶段拦截按键，先于 TipTap 自带的快捷键处理。
 * 编辑区操作（标题、正文段落、插入表格）只在焦点位于编辑区时生效，避免在输入框里误改文档。
 */

import { useEffect } from "react";
import { saveDocument } from "../documentActions";
import { setHeading, setParagraph, type HeadingLevel } from "../editor/editorCommands";
import { getEditor } from "../editor/editorHandle";
import { addSelectionToChat, openQuickAsk, toggleCopilot } from "../features/copilot/actions";
import { useAppStore } from "../store";
import { matchAction } from "./hotkeys";
import { ACTIONS, type ActionId } from "./schema";
import { useSettings } from "./settingsStore";

const HEADING_LEVELS: Partial<Record<ActionId, HeadingLevel>> = {
  heading1: 1,
  heading2: 2,
  heading3: 3,
  heading4: 4,
  heading5: 5,
  heading6: 6,
};

function editorHasFocus(target: EventTarget | null): boolean {
  const editor = getEditor();
  if (!editor || !(target instanceof Node)) {
    return false;
  }
  return editor.view.dom.contains(target);
}

function runAction(action: ActionId): void {
  const store = useAppStore.getState();
  const level = HEADING_LEVELS[action];
  if (level) {
    setHeading(level);
    return;
  }
  const handlers: Partial<Record<ActionId, () => void>> = {
    paragraph: setParagraph,
    insertTable: () => store.setOverlay({ kind: "insertTable" }),
    save: () => void saveDocument(),
    openSettings: () => store.openSettings(),
    toggleCopilot,
    quickAsk: openQuickAsk,
    addSelectionToChat,
  };
  handlers[action]?.();
}

export function useHotkeys(): void {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) {
        return;
      }
      // 录制快捷键时不触发任何操作。
      if ((event.target as HTMLElement | null)?.closest?.("[data-hotkey-recorder]")) {
        return;
      }
      const action = matchAction(useSettings.getState().settings.hotkeys, event);
      if (!action) {
        return;
      }
      const scope = ACTIONS.find((item) => item.id === action)?.scope;
      if (scope === "editor" && !editorHasFocus(event.target)) {
        return;
      }
      // 打开设置等浮层时只响应保存，避免在对话框中改动文档。
      const { overlay } = useAppStore.getState();
      if (overlay && action !== "save") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runAction(action);
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, []);
}
