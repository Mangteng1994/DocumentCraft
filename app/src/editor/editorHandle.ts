/**
 * 当前编辑器实例与 Markdown 读写。
 *
 * Markdown ⇄ ProseMirror 转换使用 VMark 管线。未修改的文档不会写回；保存时整篇按 VMark 的规范
 * 写法输出（如表格列宽对齐、提示块标记后的空引用行），换行符与硬换行写法沿用原文。
 */

import type { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { parseMarkdown, serializeMarkdown } from "@vmark/utils/markdownPipeline";
import type { HeadingItem } from "@vmark/utils/markdownOutline";
import { detectLinebreaks, type LineEnding } from "@vmark/utils/linebreakDetection";
import type { MarkdownPipelineOptions } from "@vmark/utils/markdownPipeline/types";

// 保留原文中的连续空行，避免仅打开再保存就产生大面积差异。
const PIPELINE_OPTIONS = { preserveBlankLines: true };

let current: Editor | null = null;
// 与 VMark 相同：管线只处理 LF 文本，保存时还原原文的换行符与硬换行写法。
let documentLineEnding: LineEnding = "unknown";
let documentOptions: MarkdownPipelineOptions = PIPELINE_OPTIONS;

export function setEditor(editor: Editor | null): void {
  current = editor;
}

export function getEditor(): Editor | null {
  return current;
}

/** 载入 Markdown 并重置撤销历史。 */
export function loadMarkdown(markdown: string): void {
  const editor = current;
  if (!editor) {
    return;
  }
  const detected = detectLinebreaks(markdown);
  documentLineEnding = detected.lineEnding;
  documentOptions = { ...PIPELINE_OPTIONS };
  if (detected.hardBreakStyle === "backslash" || detected.hardBreakStyle === "twoSpaces") {
    documentOptions.hardBreakStyle = detected.hardBreakStyle;
  }
  const text = markdown.replace(/\r\n?/g, "\n");
  const doc = parseMarkdown(editor.schema, text, documentOptions);
  const state = EditorState.create({
    schema: editor.schema,
    doc,
    plugins: editor.state.plugins,
  });
  editor.view.updateState(state);
}

export function currentMarkdown(): string {
  const editor = current;
  if (!editor) {
    return "";
  }
  const markdown = serializeMarkdown(editor.schema, editor.state.doc, documentOptions);
  if (documentLineEnding === "crlf") {
    return markdown.replace(/\n/g, "\r\n");
  }
  return markdown;
}

/**
 * 从文档提取大纲。line 字段存放标题节点在文档中的位置，供大纲跳转使用，
 * 与 VMark 大纲树（buildHeadingTree）的数据结构保持一致。
 */
export function extractDocumentHeadings(editor: Editor): HeadingItem[] {
  const headings: HeadingItem[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") {
      return true;
    }
    const text = node.textContent.trim();
    if (text) {
      headings.push({ level: Number(node.attrs.level) || 1, text, line: pos });
    }
    return false;
  });
  return headings;
}

/** 把光标移到指定位置并滚动到视口中部。 */
export function revealPosition(position: number, end?: number): void {
  const editor = current;
  if (!editor) {
    return;
  }
  const { doc } = editor.state;
  const anchor = Math.min(Math.max(position, 0), doc.content.size);
  const head = end === undefined ? anchor : Math.min(end, doc.content.size);
  const selection = TextSelection.create(doc, anchor, head);
  const transaction = editor.state.tr.setSelection(selection);
  editor.view.dispatch(transaction);
  const target = editor.view.domAtPos(anchor);
  const element = target.node instanceof HTMLElement ? target.node : target.node.parentElement;
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
  editor.view.focus();
}

/** 定位到第一个包含指定文字的文本块，用于从 Copilot 来源跳回原文。 */
export function revealText(probe: string): boolean {
  const editor = current;
  const needle = probe.trim();
  if (!editor || !needle) {
    return false;
  }
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) {
      return false;
    }
    if (!node.isTextblock) {
      return true;
    }
    if (node.textContent.includes(needle)) {
      found = pos + 1;
    }
    return false;
  });
  if (found === null) {
    return false;
  }
  revealPosition(found);
  return true;
}

/** 把 Markdown 片段解析后插入到光标处。 */
export function insertMarkdown(markdown: string): void {
  const editor = current;
  if (!editor) {
    return;
  }
  const fragment = parseMarkdown(editor.schema, markdown, PIPELINE_OPTIONS);
  editor.chain().focus().insertContent(fragment.content.toJSON()).run();
}
