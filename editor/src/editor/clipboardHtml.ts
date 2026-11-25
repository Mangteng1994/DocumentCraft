import { absoluteLocalPath } from "./assets";

// Word 可把 VML 图片和普通 img 备选放在不同的条件注释中。
const OFFICE_IMAGE_CONDITION = /<!--\s*\[if[^\]]*\bvml\b[^\]]*\]>(?:<!-->)?|(?:<!--\s*)?<!\[endif\]\s*-->/gi;
const OFFICE_IMAGE_MARKUP = /<v:imagedata\b|\[if[^\]]*\bvml\b/i;
export const INLINE_IMAGE_DATA = /^data:(image\/[a-z0-9.+-]+);base64,/i;

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
