/**
 * 快捷键与右键菜单调用的编辑命令。
 */

import { getEditor } from "./editorHandle";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** 把当前段落设为指定级别的标题；已是同级标题时保持不变（与 Typora 一致，用正文段落命令取消）。 */
export function setHeading(level: HeadingLevel): void {
  const editor = getEditor();
  if (!editor) {
    return;
  }
  editor.chain().focus().setHeading({ level }).run();
}

export function setParagraph(): void {
  const editor = getEditor();
  if (!editor) {
    return;
  }
  editor.chain().focus().setParagraph().run();
}

/** 插入带表头行的表格。Markdown 表格必须有表头，所以首行固定为表头。 */
export function insertTable(rows: number, cols: number): void {
  const editor = getEditor();
  if (!editor) {
    return;
  }
  editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
}

export function isInTable(): boolean {
  const editor = getEditor();
  if (!editor) {
    return false;
  }
  return editor.isActive("table");
}

export type TableAction =
  | "addRowBefore"
  | "addRowAfter"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteRow"
  | "deleteColumn"
  | "deleteTable";

export function runTableAction(action: TableAction): void {
  const editor = getEditor();
  if (!editor) {
    return;
  }
  const chain = editor.chain().focus();
  const commands = {
    addRowBefore: () => chain.addRowBefore(),
    addRowAfter: () => chain.addRowAfter(),
    addColumnBefore: () => chain.addColumnBefore(),
    addColumnAfter: () => chain.addColumnAfter(),
    deleteRow: () => chain.deleteRow(),
    deleteColumn: () => chain.deleteColumn(),
    deleteTable: () => chain.deleteTable(),
  };
  commands[action]().run();
}

/** 当前选区的文字与位置，供 Copilot 附带选区、Quick Ask 替换选区使用。 */
export interface EditorSelection {
  from: number;
  to: number;
  text: string;
}

export function currentSelection(): EditorSelection | null {
  const editor = getEditor();
  if (!editor) {
    return null;
  }
  const { from, to } = editor.state.selection;
  if (from === to) {
    return null;
  }
  const text = editor.state.doc.textBetween(from, to, "\n\n", " ");
  if (!text.trim()) {
    return null;
  }
  return { from, to, text };
}
