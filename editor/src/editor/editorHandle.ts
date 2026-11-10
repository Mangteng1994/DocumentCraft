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
// 载入或保存时的序列化结果。编辑器在载入后可能自行规范文档（如空文件补一个空段落）并触发更新事件，
// 与此基线比较可以避免只是打开文件就被标为「未保存」。
let cleanMarkdown = "";

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
  markClean();
}

/** 把当前内容记为未修改的基线。载入文档和保存成功后调用。 */
export function markClean(): void {
  cleanMarkdown = currentMarkdown();
}

/** 当前内容与基线不同。 */
export function differsFromClean(): boolean {
  return currentMarkdown() !== cleanMarkdown;
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

function markdownContent(markdown: string) {
  const editor = current;
  if (!editor) {
    return null;
  }
  const fragment = parseMarkdown(editor.schema, markdown, PIPELINE_OPTIONS);
  // 只有一段正文时按行内内容插入，替换句中选区时不把原段落拆开。
  const only = fragment.childCount === 1 ? fragment.firstChild : null;
  if (only && only.type.name === "paragraph") {
    return only.content.toJSON() ?? [];
  }
  return fragment.content.toJSON();
}

/** 把 Markdown 片段解析后插入到光标处；有选区时替换选区。 */
export function insertMarkdown(markdown: string): void {
  const editor = current;
  const content = markdownContent(markdown);
  if (!editor || !content) {
    return;
  }
  editor.chain().focus().insertContent(content).run();
}

/** 在指定位置插入 Markdown 片段，不影响该位置前后的文字。 */
export function insertMarkdownAt(position: number, markdown: string): void {
  const editor = current;
  const content = markdownContent(markdown);
  if (!editor || !content) {
    return;
  }
  const target = Math.min(position, editor.state.doc.content.size);
  editor.chain().focus().insertContentAt(target, content).run();
}

/**
 * 用 Markdown 片段替换一段原文。原位置的文字已变化（用户在此期间做过编辑）时不替换，返回 false。
 */
export function replaceRangeWithMarkdown(from: number, to: number, expectedText: string, markdown: string): boolean {
  const editor = current;
  const content = markdownContent(markdown);
  if (!editor || !content) {
    return false;
  }
  const { doc } = editor.state;
  if (to > doc.content.size || doc.textBetween(from, to, "\n\n", " ") !== expectedText) {
    return false;
  }
  editor.chain().focus().insertContentAt({ from, to }, content).run();
  return true;
}
