/**
 * 批注锚定与高亮。
 *
 * 批注保存原文 quote 及其前后各 CONTEXT_LENGTH 个码点的 prefix/suffix，与旧阅读器和
 * Python 端（editor_api.locate_notes）使用同一套锚点。文本块内的行内原子节点（公式、图片、
 * 换行）不计入文本，这与 Pandoc 段落文本的投影一致，改动会使已保存批注无法导出到 Word。
 *
 * 定位规则：原文与前后文都吻合的唯一位置优先；否则全文仅出现一次的原文也可定位；
 * 其余情况标记为待定位，不显示高亮。
 */

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const CONTEXT_LENGTH = 32;

export interface Note {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
}

export interface NoteAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface NoteRange {
  from: number;
  to: number;
}

interface AnnotationState {
  notes: Note[];
  activeId: string | null;
  ranges: Map<string, NoteRange>;
  decorations: DecorationSet;
}

interface AnnotationMeta {
  notes?: Note[];
  activeId?: string | null;
}

export const annotationKey = new PluginKey<AnnotationState>("documentcraftAnnotations");

interface TextblockText {
  text: string;
  /** positions[i] 是 text 第 i 个 UTF-16 单元在文档中的位置。 */
  positions: number[];
  end: number;
}

function textblockText(node: PMNode, start: number): TextblockText {
  let text = "";
  const positions: number[] = [];
  node.forEach((child, offset) => {
    if (!child.isText || !child.text) {
      return;
    }
    const childStart = start + offset;
    for (let index = 0; index < child.text.length; index += 1) {
      positions.push(childStart + index);
    }
    text += child.text;
  });
  return { text, positions, end: start + node.content.size };
}

function collectTextblocks(doc: PMNode): TextblockText[] {
  const blocks: TextblockText[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    const block = textblockText(node, pos + 1);
    if (block.text) {
      blocks.push(block);
    }
    return false;
  });
  return blocks;
}

function lastCodePoints(text: string, count: number): string {
  const points = Array.from(text);
  return points.slice(-count).join("");
}

function firstCodePoints(text: string, count: number): string {
  const points = Array.from(text);
  return points.slice(0, count).join("");
}

function rangeAt(block: TextblockText, offset: number, length: number): NoteRange {
  const from = block.positions[offset];
  const lastIndex = offset + length - 1;
  const to = block.positions[lastIndex] + 1;
  return { from, to };
}

/** 在文档中定位一条批注，无法唯一定位时返回 null。 */
export function locateNote(doc: PMNode, anchor: NoteAnchor, blocks = collectTextblocks(doc)): NoteRange | null {
  if (!anchor.quote) {
    return null;
  }
  const exact: NoteRange[] = [];
  const loose: NoteRange[] = [];
  for (const block of blocks) {
    let offset = block.text.indexOf(anchor.quote);
    while (offset !== -1) {
      const end = offset + anchor.quote.length;
      const range = rangeAt(block, offset, anchor.quote.length);
      loose.push(range);
      const prefixMatches = block.text.slice(0, offset).endsWith(anchor.prefix);
      const suffixMatches = block.text.slice(end).startsWith(anchor.suffix);
      if (prefixMatches && suffixMatches) {
        exact.push(range);
      }
      offset = block.text.indexOf(anchor.quote, offset + 1);
    }
  }
  const candidates = exact.length > 0 ? exact : loose;
  if (candidates.length !== 1) {
    return null;
  }
  return candidates[0];
}

/** 从当前选区生成批注锚点。选区需在同一文本块内且含有文字。 */
export function anchorFromSelection(state: EditorState): NoteAnchor | null {
  const { from, to, $from, $to } = state.selection;
  if (from === to || $from.parent !== $to.parent || !$from.parent.isTextblock) {
    return null;
  }
  const blockStart = $from.start();
  const block = textblockText($from.parent, blockStart);
  const startIndex = block.positions.findIndex((position) => position >= from);
  if (startIndex === -1) {
    return null;
  }
  let endIndex = startIndex;
  while (endIndex < block.positions.length && block.positions[endIndex] < to) {
    endIndex += 1;
  }
  const quote = block.text.slice(startIndex, endIndex);
  if (!quote.trim()) {
    return null;
  }
  const prefix = lastCodePoints(block.text.slice(0, startIndex), CONTEXT_LENGTH);
  const suffix = firstCodePoints(block.text.slice(endIndex), CONTEXT_LENGTH);
  return { quote, prefix, suffix };
}

function buildState(doc: PMNode, notes: Note[], activeId: string | null): AnnotationState {
  const blocks = collectTextblocks(doc);
  const ranges = new Map<string, NoteRange>();
  const decorations: Decoration[] = [];
  for (const note of notes) {
    const range = locateNote(doc, note, blocks);
    if (!range) {
      continue;
    }
    ranges.set(note.id, range);
    const className = note.id === activeId ? "dc-annotation dc-annotation-active" : "dc-annotation";
    decorations.push(Decoration.inline(range.from, range.to, { class: className, "data-note-id": note.id }));
  }
  return { notes, activeId, ranges, decorations: DecorationSet.create(doc, decorations) };
}

/** 供批注面板读取每条批注当前的位置。 */
export function noteRanges(state: EditorState): Map<string, NoteRange> {
  const pluginState = annotationKey.getState(state);
  return pluginState?.ranges ?? new Map();
}

/** 更新插件中的批注列表或当前选中的批注。 */
export function setAnnotationMeta(state: EditorState, meta: AnnotationMeta) {
  const transaction = state.tr.setMeta(annotationKey, meta);
  transaction.setMeta("addToHistory", false);
  return transaction;
}

export const annotationExtension = Extension.create({
  name: "documentcraftAnnotations",
  addProseMirrorPlugins() {
    return [
      new Plugin<AnnotationState>({
        key: annotationKey,
        state: {
          init: (_config, state) => buildState(state.doc, [], null),
          apply: (transaction, previous, _oldState, newState) => {
            const meta = transaction.getMeta(annotationKey) as AnnotationMeta | undefined;
            if (!meta && !transaction.docChanged) {
              return previous;
            }
            const notes = meta?.notes ?? previous.notes;
            const activeId = meta?.activeId !== undefined ? meta.activeId : previous.activeId;
            // 编辑后按原文重新定位，而不是映射旧位置：与导出 Word 时的定位结果保持一致。
            return buildState(newState.doc, notes, activeId);
          },
        },
        props: {
          decorations(state) {
            return annotationKey.getState(state)?.decorations;
          },
        },
      }),
    ];
  },
});
