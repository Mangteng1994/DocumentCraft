import { absoluteLocalPath, describeImageSource } from "./assets";

// Word 可把 VML 图片和普通 img 备选放在不同的条件注释中。
const OFFICE_IMAGE_CONDITION = /<!--\s*\[if[^\]]*\bvml\b[^\]]*\]>(?:<!-->)?|(?:<!--\s*)?<!\[endif\]\s*-->/gi;
const OFFICE_IMAGE_MARKUP = /<v:imagedata\b|\[if[^\]]*\bvml\b/i;
export const INLINE_IMAGE_DATA = /^data:(image\/[a-z0-9.+-]+);base64,/i;
const IMAGE_DIRECTORY = "data-dc-image-directory";

/** 相对图片路径随选区携带来源目录，原文和渲染 DOM 保持原样。 */
export function annotateCopiedImages(content: HTMLElement, directory: string): void {
  if (!directory) {
    return;
  }
  for (const image of content.querySelectorAll("img[data-src]")) {
    const source = image.getAttribute("data-src") ?? "";
    if (source && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(source)) {
      image.setAttribute(IMAGE_DIRECTORY, directory);
    }
  }
}

function directoryKey(directory: string): string {
  return directory.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

/** 跨目录粘贴时先恢复图片在源文档中的实际地址，供粘贴流程导入。 */
export function resolveCopiedImages(html: string, targetDirectory: string): string {
  if (!targetDirectory || !html.includes(IMAGE_DIRECTORY)) {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const target = directoryKey(targetDirectory);
  for (const image of template.content.querySelectorAll(`img[${IMAGE_DIRECTORY}][data-src]`)) {
    const directory = image.getAttribute(IMAGE_DIRECTORY) ?? "";
    const source = image.getAttribute("data-src") ?? "";
    if (!source || !/^(?:[a-z]:(?:[\\/]|$)|[\\/]{2})/i.test(directory) || directoryKey(directory) === target) {
      continue;
    }
    const { absolute } = describeImageSource(source, directory);
    if (!absolute) {
      continue;
    }
    const path = absolute.replaceAll("\\", "/");
    const encoded = path.split("/").map(encodeURIComponent).join("/").replace(/^([a-z])%3A\//i, "$1:/");
    const address = path.startsWith("//") ? `file:${encoded}` : `file:///${encoded}`;
    image.setAttribute("data-src", address);
  }
  return template.innerHTML;
}

/** 将 Office 剪贴板里的 VML 图片转换为编辑器可识别的 img，保留在原段落中的位置。 */
export function normalizeOfficeImages(html: string): string {
  if (!OFFICE_IMAGE_MARKUP.test(html)) {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html.replace(OFFICE_IMAGE_CONDITION, "");
  const fallbackShapes = new Set<string>();
  for (const image of template.content.querySelectorAll("img[src]")) {
    if (image.getAttribute("src")?.trim()) {
      const shapes = image.getAttribute("v:shapes") ?? "";
      for (const id of shapes.split(/\s+/)) {
        fallbackShapes.add(id);
      }
    }
  }

  for (const imageData of template.content.querySelectorAll("v\\:imagedata[src]")) {
    const source = imageData.getAttribute("src")?.trim();
    const shape = imageData.closest("v\\:shape");
    if (shape?.id && fallbackShapes.has(shape.id)) {
      shape.remove();
      continue;
    }
    if (source && absoluteLocalPath(source)) {
      const image = template.ownerDocument.createElement("img");
      image.setAttribute("src", source);
      image.setAttribute("alt", shape?.getAttribute("alt") ?? imageData.getAttribute("o:title") ?? "");
      (shape ?? imageData).replaceWith(image);
    }
  }
  return template.innerHTML;
}

/** 原生剪贴板 HTML 先在不可执行的模板中清理，再交给 ProseMirror 的文档 schema 解析。 */
export function prepareNativeClipboardHtml(html: string): { html: string; hasImportableImages: boolean } {
  const template = document.createElement("template");
  template.innerHTML = normalizeOfficeImages(html);
  const blocked = "script, style, link, base, meta, iframe, object, embed, template, svg, audio, video, source";
  for (const element of template.content.querySelectorAll(blocked)) {
    element.remove();
  }
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith("on") || /^(srcset|srcdoc|background)$/.test(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const hasImportableImages = [...template.content.querySelectorAll("img[src]")].some((image) => {
    const source = image.getAttribute("data-src") ?? image.getAttribute("src") ?? "";
    return absoluteLocalPath(source) !== null || INLINE_IMAGE_DATA.test(source);
  });
  return { html: template.innerHTML, hasImportableImages };
}
