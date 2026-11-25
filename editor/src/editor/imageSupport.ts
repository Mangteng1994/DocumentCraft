/**
 * 图片插入与缺失提示。
 *
 * - 粘贴截图等纯图片数据：保存到文档旁的 assets/，以相对路径插入。
 * - 粘贴带图片的内容（如从 WPS 复制）：剪贴板 HTML 中的图片指向本地临时文件（`file:///…/Temp/ksohtml…`），
 *   这些文件随后会被清理。粘贴后立即把它们复制到 assets/ 并改写为相对路径，否则文档里的图片之后会全部失效。
 * - 右键「插入图片」：当前文档 assets/ 内的图片直接引用，其他本地图片复制到 assets/ 后插入。
 * - 加载失败的图片标记为缺失，显示「找不到图片」和原路径，代替浏览器默认的破图标。
 */

import { Extension } from "@tiptap/core";
import type { Node as PMNode, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";
import { open } from "@tauri-apps/plugin-dialog";
import { errorText, importImage, storeImage } from "../backend";
import { fileName, joinPath, parentDirectory } from "../paths";
import { useAppStore } from "../store";
import { absoluteLocalPath, getDocumentDirectory } from "./assets";
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

function currentDocument(): string | null {
  return useAppStore.getState().filePath;
}

function setStatus(message: string): void {
  useAppStore.getState().setStatus(message);
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

/** 粘贴内容中引用本地绝对路径的图片地址。 */
function localSources(slice: Slice): string[] {
  const sources = new Set<string>();
  slice.content.descendants((node: PMNode) => {
    if (!IMAGE_NODE_TYPES.has(node.type.name)) {
      return true;
    }
    const source = String(node.attrs.src ?? "");
    if (absoluteLocalPath(source)) {
      sources.add(source);
    }
    return false;
  });
  return [...sources];
}

/** 把文档中 src 等于 from 的图片节点改为 to。 */
function replaceImageSource(from: string, to: string): void {
  const editor = getEditor();
  if (!editor) {
    return;
  }
  const transaction = editor.state.tr;
  editor.state.doc.descendants((node, position) => {
    if (IMAGE_NODE_TYPES.has(node.type.name) && node.attrs.src === from) {
      transaction.setNodeMarkup(position, undefined, { ...node.attrs, src: to });
    }
    return true;
  });
  if (transaction.docChanged) {
    editor.view.dispatch(transaction);
  }
}

/** 将粘贴的本地图片整理为 assets/ 相对引用，目录内已有图片直接复用；失败时保留原地址并提示。 */
async function localizePastedImages(sources: string[]): Promise<void> {
  const document = currentDocument();
  if (!document || sources.length === 0) {
    return;
  }
  let localized = 0;
  let failed = 0;
  for (const source of sources) {
    const absolute = absoluteLocalPath(source);
    if (!absolute) {
      continue;
    }
    try {
      const relativePath = await importImage(document, absolute);
      if (currentDocument() !== document) {
        setStatus("图片已保存，但当前文档已切换，请返回原文档重新插入。");
        return;
      }
      const savedPath = joinPath(parentDirectory(document), relativePath);
      registerImageImport(savedPath);
      replaceImageSource(source, imageReferencePath(document, savedPath));
      localized += 1;
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) {
    setStatus(`已整理 ${localized} 张图片的 assets/ 引用，${failed} 张处理失败，保留原地址。`);
    return;
  }
  setStatus(`已整理 ${localized} 张图片的 assets/ 引用`);
}

function handlePaste(_view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
  const data = event.clipboardData;
  if (!data) {
    return false;
  }
  const imageFiles = [...data.files].filter((file) => file.type.startsWith("image/"));
  const html = data.getData("text/html");
  // 只有图片数据（截图、从看图软件复制）时自行保存；带 HTML 的内容交给默认粘贴，保留文字。
  if (imageFiles.length > 0 && !html.trim()) {
    event.preventDefault();
    void insertClipboardImages(imageFiles);
    return true;
  }
  const sources = localSources(slice);
  if (sources.length > 0) {
    // 等默认粘贴写入文档后再改写地址。
    window.setTimeout(() => void localizePastedImages(sources), 0);
  }
  return false;
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
        props: { handlePaste },
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
