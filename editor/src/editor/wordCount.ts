/** 当前 Markdown 正文与选区的字数统计，不把格式标记和只读原子节点当作正文。 */
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { useAppStore } from "../store";

// ProseMirror 节点不可变，编辑后可复用未改动子树的统计，避免逐键扫描整篇长文档。
const nodeCounts = new WeakMap<Node, number>();
const WHITESPACE = /\s/u;

/** 按 Unicode 码点计数，空格、制表符与换行不计，标点计入字数。 */
function countCharacters(text: string): number {
  let count = 0;
  for (const character of text) {
    if (!WHITESPACE.test(character)) {
      count += 1;
    }
  }
  return count;
}

/** 汇总文本节点；图片、公式、元数据等没有正文文本子节点的结构不计入。 */
function countNode(node: Node): number {
  const cached = nodeCounts.get(node);
  if (cached !== undefined) {
    return cached;
  }
  let count = 0;
  if (node.isText) {
    count = countCharacters(node.text ?? "");
  } else {
    node.forEach((child) => {
      count += countNode(child);
    });
  }
  nodeCounts.set(node, count);
  return count;
}

/** 同步编辑器当前内容和选区；表格多单元格选区逐段累加，避免计入矩形外的文字。 */
export function syncWordCounts(editor: Editor): void {
  const { doc, selection } = editor.state;
  const total = countNode(doc);
  let selected = 0;
  if (!selection.empty) {
    for (const range of selection.ranges) {
      const text = doc.textBetween(range.$from.pos, range.$to.pos, "", "");
      selected += countCharacters(text);
    }
  }
  useAppStore.getState().setWordCounts(total, selected);
}
