/** 图片改名的路径匹配、Markdown 局部改写，以及撤销/重做后旧引用的自动纠正。 */
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Definition, Image, Link, Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import { visit } from "unist-util-visit";
import { parentDirectory } from "../paths";
import { describeImageSource } from "./assets";

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter, ["yaml", "toml"]);
const markdownWriter = unified().use(remarkStringify).use(remarkGfm).use(remarkMath);
const renamedImages = new Map<string, string>();

/** 按路径组件规范化 Windows 盘符、UNC 与 .、..，不对文件名执行大小写改写。 */
function pathParts(path: string): { root: string; parts: string[] } {
  const slashes = path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replaceAll("\\", "/");
  const pieces = slashes.split("/").filter(Boolean);
  const rootLength = slashes.startsWith("//") ? 2 : 1;
  const root = pieces.slice(0, rootLength).join("/");
  const parts: string[] = [];
  for (const piece of pieces.slice(rootLength)) {
    if (piece === ".") {
      continue;
    }
    if (piece === "..") {
      parts.pop();
    } else {
      parts.push(piece);
    }
  }
  return { root, parts };
}

function absoluteKey(path: string): string {
  const { root, parts } = pathParts(path);
  return [root, ...parts].join("/").toLowerCase();
}

/** 按每篇 Markdown 自己的目录解析图片路径，兼容绝对路径、file URL、.. 和大小写。 */
export function imageSourceKey(document: string, source: string): string | null {
  const location = describeImageSource(source, parentDirectory(document));
  return location.absolute ? absoluteKey(location.absolute) : null;
}

/** 判断本地图片的绝对路径是否属于当前文档的 assets 及子目录。 */
export function isManagedImage(document: string, source: string): boolean {
  const key = absoluteKey(source);
  const assets = absoluteKey(`${parentDirectory(document)}\\assets`);
  return key.startsWith(`${assets}/`);
}

function escapeReferencePart(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("#", "%23").replaceAll("?", "%3F").replaceAll(" ", "%20");
}

/** 生成相对于具体文档的 URL，转义影响地址解析的字符，保留中文文件名的可读性。 */
export function imageReferencePath(document: string, target: string): string {
  const directory = pathParts(parentDirectory(document));
  const image = pathParts(target);
  if (directory.root.toLowerCase() !== image.root.toLowerCase()) {
    const slashes = target.replaceAll("\\", "/");
    const url = slashes.startsWith("//") ? `file:${slashes}` : `file:///${slashes}`;
    return escapeReferencePart(url);
  }
  let common = 0;
  while (common < directory.parts.length && common < image.parts.length) {
    if (directory.parts[common].toLowerCase() !== image.parts[common].toLowerCase()) {
      break;
    }
    common += 1;
  }
  const up = Array<string>(directory.parts.length - common).fill("..");
  return [...up, ...image.parts.slice(common)].map(escapeReferencePart).join("/");
}

type ReferenceNode = Image | Link | Definition;

/** 只替换实际的图片/链接/引用定义语法节点，跳过代码、元数据和普通文字，保留其余原文及换行。 */
export function rewriteImageMarkdown(content: string, document: string, source: string, target: string): string {
  const originalKey = absoluteKey(source);
  const reference = imageReferencePath(document, target);
  // 使用原始文本的解析位置；编辑器管线的预处理会改变字符位置，不适合局部替换。
  const root = markdownParser.parse(content) as Root;
  const matches: ReferenceNode[] = [];
  const tableCells: { start: number; end: number }[] = [];
  visit(root, (node) => {
    if (node.type === "tableCell" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      tableCells.push({ start: node.position.start.offset, end: node.position.end.offset });
    }
    if (node.type !== "image" && node.type !== "link" && node.type !== "definition") {
      return;
    }
    if (imageSourceKey(document, node.url) === originalKey) {
      node.url = reference;
      matches.push(node);
    }
  });
  const edits: { start: number; end: number; text: string }[] = [];
  const ending = content.includes("\r\n") ? "\r\n" : "\n";
  matches.sort((left, right) => (left.position?.start.offset ?? 0) - (right.position?.start.offset ?? 0));
  for (const node of matches) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      throw new Error(`无法定位 ${document} 中的图片引用，未改名。`);
    }
    // 外层链接与其图片都需要更新时，一次序列化已改写的外层节点，避免重叠替换。
    if (edits.some((edit) => edit.start <= start && edit.end >= end)) {
      continue;
    }
    const fragment: Root = {
      type: "root",
      children: node.type === "definition" ? [node] : [{ type: "paragraph", children: [node] }],
    };
    let text = markdownWriter.stringify(fragment).trimEnd().replace(/\r?\n/g, ending);
    if (tableCells.some((cell) => cell.start <= start && cell.end >= end)) {
      // 片段单独序列化时没有表格上下文，保留单元格内竖线的转义。
      text = text.replace(/(\\*)\|/g, (match: string, escapes: string) => escapes.length % 2 === 0 ? `\\${match}` : match);
    }
    edits.push({ start, end, text });
  }
  let result = content;
  for (const edit of edits.reverse()) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/** 构建图片与引用定义、链接 mark 的改写事务，图片文件改名不进入正文撤销栈。 */
function referenceTransaction(state: EditorState, document: string, replacements: Map<string, string>): Transaction | null {
  if (replacements.size === 0) {
    return null;
  }
  const transaction = state.tr.setMeta("addToHistory", false);
  state.doc.descendants((node, position) => {
    const attribute = node.type.name === "link_definition" ? "url" : "src";
    const isImage = node.type.name === "image" || node.type.name === "block_image";
    if (isImage || attribute === "url") {
      const key = imageSourceKey(document, String(node.attrs[attribute] ?? ""));
      const target = key ? replacements.get(key) : undefined;
      if (target) {
        const reference = imageReferencePath(document, target);
        if (node.attrs[attribute] !== reference) {
          transaction.setNodeMarkup(position, undefined, { ...node.attrs, [attribute]: reference });
        }
      }
    }
    for (const mark of node.marks) {
      if (mark.type.name !== "link") {
        continue;
      }
      const key = imageSourceKey(document, String(mark.attrs.href ?? ""));
      const target = key ? replacements.get(key) : undefined;
      if (target) {
        const reference = imageReferencePath(document, target);
        if (mark.attrs.href !== reference) {
          transaction.removeMark(position, position + node.nodeSize, mark);
          transaction.addMark(position, position + node.nodeSize, mark.type.create({ ...mark.attrs, href: reference }));
        }
      }
    }
  });
  return transaction.docChanged ? transaction : null;
}

/** 仅改写节点属性和链接 mark，图片物理改名不进入正文撤销栈。 */
export function imageReferenceTransaction(state: EditorState, document: string, source: string, target: string): Transaction | null {
  return referenceTransaction(state, document, new Map([[absoluteKey(source), target]]));
}

/** 记录物理改名；撤销/重做恢复旧图片节点时仍指向已改名的文件，连续改名合并为最新路径。 */
export function registerImageRename(source: string, target: string): void {
  const key = absoluteKey(source);
  const targetKey = absoluteKey(target);
  renamedImages.delete(targetKey);
  for (const [previous, next] of renamedImages) {
    if (absoluteKey(next) === key) {
      renamedImages.set(previous, target);
    }
  }
  if (key !== targetKey) {
    renamedImages.set(key, target);
  }
}

/** 用户重新导入了某个真实存在的文件名时，它代表当前文件，不能沿用旧的改名映射。 */
export function registerImageImport(source: string): void {
  renamedImages.delete(absoluteKey(source));
}

/** 对当前编辑状态应用本次会话内已发生的图片改名。 */
export function normalizeRenamedImages(state: EditorState, document: string): Transaction | null {
  return referenceTransaction(state, document, renamedImages);
}
