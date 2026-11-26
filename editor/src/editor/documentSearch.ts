/** 当前 Markdown 的正文搜索：结果、装饰和选区定位均不修改文档内容。 */
import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { create } from "zustand";
import { useAppStore } from "../store";
import { getEditor } from "./editorHandle";
import { stopRestoringDocumentViewport } from "./documentViewport";

// 所有命中都可定位；同时创建的装饰有窗口上限，避免短关键词使长文档产生过多 DOM。
const MAX_HIGHLIGHTS = 2000;
const MAX_SELECTION_QUERY = 2000;

interface SearchUI {
  open: boolean;
  query: string;
  focusRequest: number;
  total: number;
  index: number;
  setQuery: (query: string) => void;
  setResult: (total: number, index: number) => void;
}

export const useDocumentSearch = create<SearchUI>((set) => ({
  open: false,
  query: "",
  focusRequest: 0,
  total: 0,
  index: -1,
  setQuery: (query) => set({ query }),
  setResult: (total, index) => set((previous) => {
    if (previous.total === total && previous.index === index) {
      return previous;
    }
    return { total, index };
  }),
}));

interface Match {
  from: number;
  to: number;
}

interface SearchState {
  query: string;
  matches: Match[];
  index: number;
  decorations: DecorationSet;
}

interface SearchMeta {
  query?: string;
  matches?: Match[];
  index?: number;
}

const searchKey = new PluginKey<SearchState>("documentcraftDocumentSearch");

/** 合并同一文本块的相邻文本节点，按 ProseMirror 位置映射结果，图片、公式和硬换行分隔搜索范围。 */
function collectMatches(doc: PMNode, query: string): Match[] {
  if (!query) {
    return [];
  }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 使用正则的字面量匹配保留原始 UTF-16 偏移，避免大小写转换改变字符串长度。
  const expression = new RegExp(escaped, "giu");
  const matches: Match[] = [];
  doc.descendants((block, position) => {
    if (!block.isTextblock) {
      return true;
    }
    let chunks: string[] = [];
    let positions: number[] = [];
    const flush = () => {
      const text = chunks.join("");
      expression.lastIndex = 0;
      let match = expression.exec(text);
      while (match) {
        const end = match.index + match[0].length - 1;
        matches.push({ from: positions[match.index], to: positions[end] + 1 });
        match = expression.exec(text);
      }
      chunks = [];
      positions = [];
    };
    block.descendants((node, offset) => {
      if (node.isText && node.text) {
        chunks.push(node.text);
        for (let index = 0; index < node.text.length; index += 1) {
          positions.push(position + 1 + offset + index);
        }
      } else if (node.isLeaf) {
        flush();
      }
    });
    flush();
    return false;
  });
  return matches;
}

/** 取光标处或其后的命中；到末尾后从第一处继续。 */
function indexNear(matches: Match[], position: number): number {
  if (matches.length === 0) {
    return -1;
  }
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (matches[middle].from < position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low > 0 && matches[low - 1].to > position) {
    return low - 1;
  }
  return low < matches.length ? low : 0;
}

function highlightMatches(doc: PMNode, matches: Match[], index: number): DecorationSet {
  const start = Math.max(0, Math.min(index - Math.floor(MAX_HIGHLIGHTS / 2), matches.length - MAX_HIGHLIGHTS));
  const decorations = matches.slice(start, start + MAX_HIGHLIGHTS).map((match, offset) => {
    const active = start + offset === index;
    const attributes: Record<string, string> = {
      class: active ? "dc-document-search-match is-current" : "dc-document-search-match",
    };
    if (active) {
      attributes["data-document-search-current"] = "true";
    }
    return Decoration.inline(match.from, match.to, attributes);
  });
  return DecorationSet.create(doc, decorations);
}

function publishResult(view: EditorView): void {
  const result = searchKey.getState(view.state);
  useDocumentSearch.getState().setResult(result?.matches.length ?? 0, result?.index ?? -1);
}

export const documentSearchExtension = Extension.create({
  name: "documentcraftDocumentSearch",
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: searchKey,
      state: {
        init: () => ({ query: "", matches: [], index: -1, decorations: DecorationSet.empty }),
        apply(transaction, previous, _oldState, state) {
          const meta = transaction.getMeta(searchKey) as SearchMeta | undefined;
          if (!meta && !transaction.docChanged && !transaction.selectionSet) {
            return previous;
          }
          const query = meta?.query ?? previous.query;
          const matches = transaction.docChanged || query !== previous.query
            ? meta?.matches ?? collectMatches(state.doc, query)
            : meta?.matches ?? previous.matches;
          const requested = meta?.index ?? indexNear(matches, state.selection.from);
          const index = matches.length === 0 ? -1 : Math.max(0, Math.min(requested, matches.length - 1));
          if (query === previous.query && matches === previous.matches && index === previous.index) {
            return previous;
          }
          return { query, matches, index, decorations: highlightMatches(state.doc, matches, index) };
        },
      },
      props: {
        decorations: (state) => useDocumentSearch.getState().open
          ? searchKey.getState(state)?.decorations
          : DecorationSet.empty,
      },
      view(view) {
        publishResult(view);
        return { update: publishResult };
      },
    })];
  },
});

function revealCurrent(editor: Editor): void {
  stopRestoringDocumentViewport();
  const element = editor.view.dom.querySelector<HTMLElement>("[data-document-search-current]");
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) {
      parent.open = true;
    }
  }
  element?.scrollIntoView({ block: "center", inline: "nearest" });
}

/** 更新关键词并选中当前光标附近的命中，保持搜索输入框焦点。 */
export function updateDocumentSearch(editor: Editor, query: string, select = true): void {
  if (editor.isDestroyed) {
    return;
  }
  const matches = collectMatches(editor.state.doc, query);
  const index = indexNear(matches, editor.state.selection.from);
  const transaction = editor.state.tr.setMeta(searchKey, { query, matches, index }).setMeta("addToHistory", false);
  if (select && index >= 0) {
    const match = matches[index];
    transaction.setSelection(TextSelection.create(editor.state.doc, match.from, match.to));
  }
  editor.view.dispatch(transaction);
  if (select && index >= 0) {
    revealCurrent(editor);
  }
}

/** 在全部命中中循环定位上一处或下一处，包括未创建高亮装饰的远处结果。 */
export function moveDocumentSearch(editor: Editor, direction: 1 | -1): void {
  const query = useDocumentSearch.getState().query;
  const result = searchKey.getState(editor.state);
  if (!result || result.query !== query) {
    updateDocumentSearch(editor, query);
    return;
  }
  if (result.matches.length === 0) {
    return;
  }
  const index = (result.index + direction + result.matches.length) % result.matches.length;
  const match = result.matches[index];
  const transaction = editor.state.tr.setMeta(searchKey, { index }).setMeta("addToHistory", false);
  transaction.setSelection(TextSelection.create(editor.state.doc, match.from, match.to));
  editor.view.dispatch(transaction);
  revealCurrent(editor);
}

/** 打开当前文档搜索，存在短的单行选区时将它作为初始关键词。 */
export function openDocumentSearch(): void {
  const editor = getEditor();
  if (!editor || !useAppStore.getState().filePath) {
    return;
  }
  const { from, to } = editor.state.selection;
  const selected = to - from <= MAX_SELECTION_QUERY ? editor.state.doc.textBetween(from, to, "\n", " ") : "";
  const initial = selected && !/[\r\n]/.test(selected) ? selected : undefined;
  useAppStore.getState().setImagePopover(null);
  useAppStore.getState().setContextMenu(null);
  useDocumentSearch.setState((previous) => ({ open: true, query: initial ?? previous.query, focusRequest: previous.focusRequest + 1 }));
}

/** 收起搜索并清除装饰，保留当前定位选区，返回编辑区继续编辑。 */
export function closeDocumentSearch(editor: Editor | null): void {
  useDocumentSearch.setState({ open: false, total: 0, index: -1 });
  if (editor && !editor.isDestroyed) {
    updateDocumentSearch(editor, "", false);
    if (useAppStore.getState().filePath) {
      editor.view.focus();
    }
  }
}
