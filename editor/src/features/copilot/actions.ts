/**
 * Copilot 的入口操作，供快捷键、右键菜单和侧栏共用。
 */

import { currentSelection } from "../../editor/editorCommands";
import { useAppStore } from "../../store";
import { useCopilot } from "./copilotStore";

export function toggleCopilot(): void {
  const store = useAppStore.getState();
  store.setRightPanel(store.rightPanel === "copilot" ? null : "copilot");
}

/** 把编辑器当前选区作为下一条消息的上下文，并打开 Copilot。 */
export function addSelectionToChat(): void {
  const { filePath, setRightPanel } = useAppStore.getState();
  const selection = currentSelection();
  if (!selection || !filePath) {
    return;
  }
  useCopilot.getState().setSelection({ kind: "selection", path: filePath, text: selection.text });
  setRightPanel("copilot");
}

/** 编辑器选区变化时自动作为 Copilot 上下文；选区收起时保留上一次的选区徽标，与 Obsidian Copilot 一致。 */
export function captureEditorSelection(): void {
  const { filePath } = useAppStore.getState();
  const selection = currentSelection();
  if (!selection || !filePath) {
    return;
  }
  useCopilot.getState().setSelection({ kind: "selection", path: filePath, text: selection.text });
}

export function openQuickAsk(): void {
  useAppStore.getState().setOverlay({ kind: "quickAsk" });
}
