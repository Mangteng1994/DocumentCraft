/**
 * 图片插入与缺失提示。
 *
 * - 粘贴截图等纯图片数据：保存到文档旁的 assets/，以相对路径插入。
 * - 从 Word 或 WPS 粘贴图文：按 HTML 中的位置保留图片，将本地临时文件或内嵌图片保存到 assets/。
 * - 在编辑器文档间复制图文：剪贴板携带相对图片的来源目录，跨目录粘贴时导入目标 assets/。
 * - 右键「插入图片」：当前文档 assets/ 内的图片直接引用，其他本地图片复制到 assets/ 后插入。
 * - 加载失败的图片标记为缺失，显示「找不到图片」和原路径，代替浏览器默认的破图标。
 */

import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { open } from "@tauri-apps/plugin-dialog";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { clipboardReadEditor, clipboardWriteEditor, errorText, importImage, storeImage } from "../backend";
import { fileName, joinPath, parentDirectory } from "../paths";
import { useAppStore } from "../store";
import { absoluteLocalPath, getDocumentDirectory } from "./assets";
import {
  annotateCopiedImages,
  INLINE_IMAGE_DATA,
  normalizeOfficeImages,
  prepareNativeClipboardHtml,
  resolveCopiedImages,
} from "./clipboardHtml";
import { getEditor, insertMarkdown } from "./editorHandle";
import { imageReferencePath, normalizeRenamedImages, registerImageImport } from "./imageReferences";

const IMAGE_NODE_TYPES = new Set(["image", "block_image"]);
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};
const DIALOG_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const richClipboardSlices = new WeakSet<Slice>();

function currentDocument(): string | null {
  return useAppStore.getState().filePath;
}

function setStatus(message: string): void {
  useAppStore.getState().setStatus(message);
}

/** 让快捷键和右键菜单使用相同的富文本剪贴板格式。 */
function serializeEditorSelection(view: EditorView): { html: string; text: string } {
  const { dom, text } = view.serializeForClipboard(view.state.selection.content());
  annotateCopiedImages(dom, getDocumentDirectory());
  return { html: dom.innerHTML, text };
}

function cutSelection(view: EditorView): void {
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
}

function handleCopy(view: EditorView, event: ClipboardEvent): boolean {
  const clipboard = event.clipboardData;
  const cut = event.type === "cut";
  if (!clipboard || view.state.selection.empty || (cut && !view.editable)) {
    return false;
  }
  const { html, text } = serializeEditorSelection(view);
  clipboard.clearData();
  clipboard.setData("text/html", html);
  clipboard.setData("text/plain", text);
  event.preventDefault();
  if (cut) {
    cutSelection(view);
  }
  return true;
}

/** 菜单复制和剪切写入系统富文本剪贴板，剪切只在原选区仍有效时删除。 */
export async function copyEditorSelection(cut: boolean): Promise<void> {
  const view = getEditor()?.view;
  if (!view || view.state.selection.empty || (cut && !view.editable)) {
    return;
  }
  const state = view.state;
  const document = currentDocument();
  try {
    const { html, text } = serializeEditorSelection(view);
    await clipboardWriteEditor(html, text);
    if (cut) {
      if (!sameSelection(view, document, state)) {
        setStatus("已复制，原选区已变化，请重新剪切。");
        return;
      }
      view.focus();
      cutSelection(view);
    }
  } catch (error) {
    setStatus(errorText(error));
  }
}

/**
 * 以 Markdown 图片语法插入相对路径。复用已有图片时原名可能带空格和括号，用尖括号包裹目标路径。
 * 独占一行的图片插入后会处于整块选中状态，紧接着再粘贴就会把它替换掉，因此把光标放进图片后面的段落；
 * 后面紧跟的不是文字段落（如另一张图片）时先补一个空段落，避免光标落到下一张图片上把它选中。
 */
function insertImageReference(relativePath: string, document: string): boolean {
  const editor = getEditor();
  if (!editor || currentDocument() !== document) {
    setStatus("图片已保存，但当前文档已切换，请返回原文档重新插入。");
    return false;
  }
  const absolute = joinPath(parentDirectory(document), relativePath);
  registerImageImport(absolute);
  const reference = imageReferencePath(document, absolute);
  insertMarkdown(`![](<${reference}>)`);
  const { selection, doc, schema } = editor.state;
  if (!(selection instanceof NodeSelection)) {
    return true;
  }
  const transaction = editor.state.tr;
  const nodeAfter = doc.resolve(selection.to).nodeAfter;
  if (!nodeAfter || !nodeAfter.isTextblock) {
    transaction.insert(selection.to, schema.nodes.paragraph.create());
  }
  transaction.setSelection(TextSelection.create(transaction.doc, selection.to + 1));
  editor.view.dispatch(transaction);
  return true;
}

async function insertClipboardImages(files: File[]): Promise<void> {
  const document = currentDocument();
  if (!document) {
    setStatus("请先打开文档再粘贴图片。");
    return;
  }
  for (const file of files) {
    const extension = MIME_EXTENSIONS[file.type];
    if (!extension) {
      setStatus(`不支持的图片格式：${file.type}`);
      continue;
    }
    try {
      const buffer = await file.arrayBuffer();
      const relativePath = await storeImage(document, new Uint8Array(buffer), extension);
      if (insertImageReference(relativePath, document)) {
        setStatus(`图片已保存到 ${relativePath}`);
      }
    } catch (error) {
      setStatus(errorText(error));
    }
  }
}

/** 收集需要保存到 assets/ 的临时图片地址或内嵌图片数据。 */
function importableSources(slice: Slice): string[] {
  const sources = new Set<string>();
  slice.content.descendants((node) => {
    if (!IMAGE_NODE_TYPES.has(node.type.name)) {
      return true;
    }
    const source = String(node.attrs.src ?? "");
    if (absoluteLocalPath(source) || INLINE_IMAGE_DATA.test(source)) {
      sources.add(source);
    }
    return false;
  });
  return [...sources];
}

/** 只更新待插入的片段，已有正文中相同地址的图片保持原样。 */
function replaceFragmentImageSources(fragment: Fragment, references: Map<string, string>): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (IMAGE_NODE_TYPES.has(node.type.name)) {
      const source = references.get(String(node.attrs.src ?? ""));
      if (source) {
        nodes.push(node.type.create({ ...node.attrs, src: source }, node.content, node.marks));
        return;
      }
    }
    nodes.push(node.isLeaf ? node : node.copy(replaceFragmentImageSources(node.content, references)));
  });
  return Fragment.fromArray(nodes);
}

/** 内嵌图片按剪贴板数据保存，本地文件沿用导入与复用规则。 */
async function savePastedSource(document: string, source: string): Promise<string> {
  const data = INLINE_IMAGE_DATA.exec(source);
  if (data) {
    const extension = MIME_EXTENSIONS[data[1].toLowerCase()];
    if (!extension) {
      throw new Error(`不支持的图片格式：${data[1]}`);
    }
    const decoded = atob(source.slice(data[0].length));
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return storeImage(document, bytes, extension);
  }
  const absolute = absoluteLocalPath(source);
  if (!absolute) {
    throw new Error("剪贴板中的图片没有本地地址。");
  }
  return importImage(document, absolute);
}

/** 图片导入完毕后一次性插入图文，让图片路径与正文一起撤销。 */
async function pasteWithImportedImages(
  view: EditorView,
  document: string,
  slice: Slice,
  sources: string[],
): Promise<void> {
  const state = view.state;
  const references = new Map<string, string>();
  let failed = 0;
  for (const source of sources) {
    try {
      const relativePath = await savePastedSource(document, source);
      const savedPath = joinPath(parentDirectory(document), relativePath);
      registerImageImport(savedPath);
      references.set(source, imageReferencePath(document, savedPath));
    } catch {
      failed += 1;
    }
    if (!sameSelection(view, document, state)) {
      setStatus("导入图片时粘贴位置已变化，请重新粘贴。");
      return;
    }
  }
  const content = replaceFragmentImageSources(slice.content, references);
  insertPastedSlice(view, new Slice(content, slice.openStart, slice.openEnd));
  if (failed > 0) {
    setStatus(`已导入 ${references.size} 张图片，${failed} 张导入失败，保留原地址。`);
    return;
  }
  setStatus(`已导入 ${references.size} 张图片到 assets/`);
}

function hasUsableImage(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (IMAGE_NODE_TYPES.has(node.type.name)) {
      const source = String(node.attrs.src ?? "");
      if (source && !/^(cid|webkit-fake-url):/i.test(source)) {
        found = true;
      }
    }
    return !found;
  });
  return found;
}

function sameSelection(view: EditorView, document: string | null, state: EditorView["state"]): boolean {
  return getEditor()?.view === view && view.editable && currentDocument() === document
    && view.state.doc === state.doc && view.state.selection.eq(state.selection);
}

function insertPastedSlice(view: EditorView, slice: Slice): void {
  const transaction = view.state.tr.replaceSelection(slice).scrollIntoView();
  view.dispatch(transaction.setMeta("paste", true).setMeta("uiEvent", "paste"));
}

/** WebView 的富文本有时缺少图片，用同一份系统剪贴板里的 Office 图片标记补回。 */
async function recoverNativeImages(view: EditorView, slice: Slice, browserText: string): Promise<void> {
  const state = view.state;
  const document = currentDocument();
  let nativeHtml = "";
  try {
    const clipboard = await clipboardReadEditor(false);
    // 读取等候期间如果剪贴板已变化，继续使用粘贴事件自带的正文。
    if (clipboard.text.replace(/\r\n?/g, "\n") === browserText.replace(/\r\n?/g, "\n")) {
      const prepared = prepareNativeClipboardHtml(clipboard.html);
      if (prepared.hasImportableImages) {
        nativeHtml = prepared.html;
      }
    }
  } catch {
    // 原生读取失败时保持浏览器已经解析出的内容。
  }
  if (!sameSelection(view, document, state)) {
    if (getEditor()?.view === view && currentDocument() === document) {
      setStatus("读取图文时编辑位置已变化，请重新粘贴。");
    }
    return;
  }
  if (nativeHtml && view.pasteHTML(nativeHtml)) {
    return;
  }
  if (slice.size > 0) {
    insertPastedSlice(view, slice);
  }
}

function handlePaste(view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
  const data = event.clipboardData;
  const html = data?.getData("text/html") ?? "";
  const imageFiles = data ? [...data.files].filter((file) => file.type.startsWith("image/")) : [];
  // 只有图片数据（截图、从看图软件复制）时自行保存；带 HTML 的内容交给默认粘贴，保留文字。
  if (imageFiles.length > 0 && !html.trim()) {
    event.preventDefault();
    void insertClipboardImages(imageFiles);
    return true;
  }
  const sources = importableSources(slice);
  const document = currentDocument();
  if (document && sources.length > 0) {
    void pasteWithImportedImages(view, document, slice, sources);
    return true;
  }
  const browserText = data?.getData("text/plain") ?? "";
  if (event.isTrusted && html && browserText && richClipboardSlices.has(slice) && !hasUsableImage(slice)) {
    void recoverNativeImages(view, slice, browserText);
    return true;
  }
  return false;
}

/** 右键粘贴读取系统 HTML 与图片，纯文本继续按 Markdown 解析。 */
export async function pasteFromSystemClipboard(): Promise<void> {
  const view = getEditor()?.view;
  if (!view?.editable) {
    return;
  }
  const state = view.state;
  const document = currentDocument();
  try {
    const clipboard = await clipboardReadEditor(true);
    let text = clipboard.text;
    if (!clipboard.html && !clipboard.image && !text) {
      text = await readClipboardText();
    }
    if (!sameSelection(view, document, state)) {
      return;
    }
    view.focus();
    if (clipboard.html && !state.selection.$from.parent.type.spec.code) {
      const prepared = prepareNativeClipboardHtml(clipboard.html);
      if (prepared.html.trim() && view.pasteHTML(prepared.html)) {
        return;
      }
    }
    if (clipboard.image) {
      const bytes = new Uint8Array(clipboard.image.bytes);
      const file = new File([bytes], "clipboard", { type: clipboard.image.mime });
      await insertClipboardImages([file]);
      return;
    }
    if (text) {
      insertMarkdown(text);
    }
  } catch (error) {
    setStatus(errorText(error));
  }
}

/** 加载失败的图片标记为缺失，alt 显示文件名，悬停显示原地址。 */
function markImage(event: Event): void {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  const original = image.dataset.src ?? image.getAttribute("src") ?? "";
  if (event.type === "error") {
    image.classList.add("is-missing");
    image.alt = `找不到图片：${fileName(original.replaceAll("/", "\\")) || original}`;
    image.title = original;
    return;
  }
  image.classList.remove("is-missing");
}

const imageSupportKey = new PluginKey("documentcraftImageSupport");

export const imageSupportExtension = Extension.create({
  name: "documentcraftImageSupport",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: imageSupportKey,
        props: {
          handleDOMEvents: { copy: handleCopy, cut: handleCopy },
          transformPastedHTML(html) {
            const normalized = normalizeOfficeImages(html);
            return resolveCopiedImages(normalized, getDocumentDirectory());
          },
          transformPasted(slice, _view, plain) {
            if (!plain) {
              richClipboardSlices.add(slice);
            }
            return slice;
          },
          handlePaste,
        },
        appendTransaction(transactions, _previous, state) {
          if (!transactions.some(isHistoryTransaction)) {
            return null;
          }
          const directory = getDocumentDirectory();
          if (!directory) {
            return null;
          }
          return normalizeRenamedImages(state, `${directory}\\_document.md`);
        },
        view(view) {
          // load、error 不冒泡，需要在捕获阶段监听。
          view.dom.addEventListener("error", markImage, true);
          view.dom.addEventListener("load", markImage, true);
          return {
            destroy() {
              view.dom.removeEventListener("error", markImage, true);
              view.dom.removeEventListener("load", markImage, true);
            },
          };
        },
      }),
    ];
  },
});

/** 右键「插入图片」：选择本地图片，复用或导入 assets/ 后插入到光标处。 */
export async function chooseAndInsertImage(): Promise<void> {
  const document = currentDocument();
  if (!document) {
    setStatus("请先打开文档再插入图片。");
    return;
  }
  const selected = await open({
    multiple: false,
    title: "插入图片",
    filters: [{ name: "图片", extensions: DIALOG_EXTENSIONS }],
  });
  if (typeof selected !== "string") {
    return;
  }
  try {
    const relativePath = await importImage(document, selected);
    if (insertImageReference(relativePath, document)) {
      setStatus(`已插入图片：${relativePath}`);
    }
  } catch (error) {
    setStatus(errorText(error));
  }
}
