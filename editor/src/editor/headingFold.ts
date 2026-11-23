/**
 * 正文标题收拢（DC-078）。
 *
 * 每个顶层标题末尾有一个收拢按钮：点击后，该标题下直到下一个同级或更高级标题之前的块全部隐藏，
 * 标题自身与其编号变为浅灰；再点一次展开。
 *
 * 收拢只是视图状态：状态保存在插件里（被收拢标题的位置），用 ProseMirror 装饰隐藏内容，
 * 不修改文档、不写入 Markdown，也不进入撤销栈。标签页切换时随各自的 EditorState 一起保存和恢复。
 * 只处理文档顶层的标题；引用块、列表里的标题不提供收拢。
 */

import { Extension } from "@tiptap/core";
import { AllSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

interface FoldState {
  /** 已收拢的标题节点起始位置，按文档顺序。 */
  folded: number[];
  decorations: DecorationSet;
}

type FoldMeta = { toggle: number } | { expand: number[] };

const foldKey = new PluginKey<FoldState>("documentcraftHeadingFold");

/** 一个顶层标题收拢时隐藏的范围：from 为标题节点末尾，to 为下一个同级或更高级标题的起点。 */
export interface FoldRange {
  heading: number;
  from: number;
  to: number;
}

/** 按文档顺序列出所有顶层标题及其收拢范围；标题后没有内容时 from 等于 to。 */
export function computeFoldRanges(doc: PMNode): FoldRange[] {
  const headings: { pos: number; end: number; level: number }[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name === "heading") {
      headings.push({ pos: offset, end: offset + node.nodeSize, level: Number(node.attrs.level) || 1 });
    }
  });
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    return { heading: heading.pos, from: heading.end, to: next ? next.pos : doc.content.size };
  });
}

/** 把旧位置映射到新文档；对应的标题被删除或不再是顶层标题时返回 null。 */
function mapFoldedPosition(position: number, transaction: Transaction): number | null {
  const result = transaction.mapping.mapResult(position, 1);
  if (result.deletedAfter) {
    return null;
  }
  const node = transaction.doc.resolve(result.pos).nodeAfter;
  if (!node || node.type.name !== "heading") {
    return null;
  }
  return result.pos;
}

/**
 * 创建收拢按钮。按钮位于标题文字末尾，点击时用 ProseMirror 给出的按钮当前位置反推标题起点，
 * 因此文档编辑导致位置变化后不会操作到旧标题。
 */
function createToggle(folded: boolean): (view: EditorView, getPosition: () => number | undefined) => HTMLElement {
  return (view, getPosition) => {
    const button = document.createElement("span");
    button.className = `dc-fold-toggle${folded ? " is-folded" : ""}`;
    button.contentEditable = "false";
    button.setAttribute("role", "button");
    const label = folded ? "展开该标题下的内容" : "收拢该标题下的内容";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = folded ? "▸" : "▾";
    // 按下时不让编辑器失去焦点或移动光标。
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const widgetPosition = getPosition();
      if (widgetPosition === undefined) {
        return;
      }
      const resolved = view.state.doc.resolve(widgetPosition);
      if (resolved.depth >= 1) {
        toggleHeadingFold(view, resolved.before(1));
      }
    });
    return button;
  };
}

function buildDecorations(doc: PMNode, folded: readonly number[]): DecorationSet {
  const decorations: Decoration[] = [];
  const foldedSet = new Set(folded);
  const topLevel: { pos: number; size: number }[] = [];
  doc.forEach((node, offset) => topLevel.push({ pos: offset, size: node.nodeSize }));
  for (const range of computeFoldRanges(doc)) {
    const isFolded = foldedSet.has(range.heading);
    const hasContent = range.to > range.from;
    if (!hasContent && !isFolded) {
      continue;
    }
    const headingNode = doc.nodeAt(range.heading);
    if (!headingNode) {
      continue;
    }
    // 按钮放在标题文字末尾（标题节点结束标记之前）。
    const widgetPosition = range.heading + headingNode.nodeSize - 1;
    decorations.push(
      Decoration.widget(widgetPosition, createToggle(isFolded), {
        side: 1,
        ignoreSelection: true,
        stopEvent: () => true,
        key: `fold-${range.heading}-${isFolded ? "folded" : "open"}`,
      }),
    );
    if (!isFolded) {
      continue;
    }
    decorations.push(Decoration.node(range.heading, range.heading + headingNode.nodeSize, { class: "dc-heading-folded" }));
    for (const block of topLevel) {
      if (block.pos >= range.from && block.pos < range.to) {
        decorations.push(Decoration.node(block.pos, block.pos + block.size, { class: "dc-fold-hidden" }));
      }
    }
  }
  return DecorationSet.create(doc, decorations);
}

/** 选区端点落在某个已收拢范围内时返回该标题位置；全选不算。 */
function foldedHeadingsContainingSelection(state: EditorState, folded: readonly number[]): number[] {
  if (folded.length === 0 || state.selection instanceof AllSelection) {
    return [];
  }
  const { from, to } = state.selection;
  const foldedSet = new Set(folded);
  return computeFoldRanges(state.doc)
    .filter((range) => foldedSet.has(range.heading) && range.to > range.from)
    .filter((range) => (from >= range.from && from < range.to) || (to > range.from && to <= range.to))
    .map((range) => range.heading);
}

/**
 * 收拢或展开一个标题。收拢时如果光标在将被隐藏的范围内，先把光标移到标题末尾，
 * 否则光标会留在看不见的内容里。
 */
export function toggleHeadingFold(view: EditorView, headingPosition: number): void {
  const state = foldKey.getState(view.state);
  if (!state) {
    return;
  }
  let transaction = view.state.tr.setMeta(foldKey, { toggle: headingPosition } satisfies FoldMeta).setMeta("addToHistory", false);
  const willFold = !state.folded.includes(headingPosition);
  const headingNode = view.state.doc.nodeAt(headingPosition);
  if (willFold && headingNode) {
    const range = computeFoldRanges(view.state.doc).find((candidate) => candidate.heading === headingPosition);
    const { from, to } = view.state.selection;
    const inside = range && ((from >= range.from && from < range.to) || (to > range.from && to <= range.to));
    if (inside) {
      const headingEnd = headingPosition + headingNode.nodeSize - 1;
      transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(headingEnd), -1));
    }
  }
  view.dispatch(transaction);
}

export const headingFoldExtension = Extension.create({
  name: "documentcraftHeadingFold",
  addProseMirrorPlugins() {
    return [
      new Plugin<FoldState>({
        key: foldKey,
        state: {
          init: (_config, state) => ({ folded: [], decorations: buildDecorations(state.doc, []) }),
          apply: (transaction, previous, _oldState, newState) => {
            const meta = transaction.getMeta(foldKey) as FoldMeta | undefined;
            let folded = previous.folded;
            let changed = false;
            if (transaction.docChanged && folded.length > 0) {
              const mapped = folded
                .map((position) => mapFoldedPosition(position, transaction))
                .filter((position): position is number => position !== null);
              folded = mapped;
              changed = true;
            }
            if (meta && "toggle" in meta) {
              folded = folded.includes(meta.toggle) ? folded.filter((position) => position !== meta.toggle) : [...folded, meta.toggle];
              changed = true;
            }
            if (meta && "expand" in meta) {
              folded = folded.filter((position) => !meta.expand.includes(position));
              changed = true;
            }
            // 光标、大纲跳转、搜索定位或批注定位把选区带进被隐藏的内容时，自动展开对应标题，避免定位到看不见的位置。
            if (folded.length > 0 && (transaction.selectionSet || transaction.docChanged) && !(meta && "toggle" in meta)) {
              const reveal = foldedHeadingsContainingSelection(newState, folded);
              if (reveal.length > 0) {
                folded = folded.filter((position) => !reveal.includes(position));
                changed = true;
              }
            }
            if (!changed && !transaction.docChanged) {
              return previous;
            }
            return { folded, decorations: buildDecorations(newState.doc, folded) };
          },
        },
        props: {
          decorations: (state) => foldKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});
