/**
 * 把对话中的 Markdown 渲染为只读 HTML。
 *
 * 复用编辑器的 VMark 管线与 schema，回答里的表格、公式、提示块和正文显示一致；
 * 插入到文档时也走同一管线，不会出现预览与插入结果不符。
 */

import { getSchema } from "@tiptap/core";
import { DOMSerializer, type Schema } from "@tiptap/pm/model";
import katex from "katex";
import { parseMarkdown } from "@vmark/utils/markdownPipeline";
import { createExtensions } from "../../editor/extensions";

let cachedSchema: Schema | null = null;

function schema(): Schema {
  if (!cachedSchema) {
    cachedSchema = getSchema(createExtensions());
  }
  return cachedSchema;
}

/** 渲染失败时退回纯文本，保证回答始终可读。 */
export function renderMarkdown(markdown: string, target: HTMLElement): void {
  target.replaceChildren();
  try {
    const doc = parseMarkdown(schema(), markdown, { preserveBlankLines: false });
    const fragment = DOMSerializer.fromSchema(schema()).serializeFragment(doc.content);
    target.appendChild(fragment);
  } catch {
    const pre = document.createElement("p");
    pre.textContent = markdown;
    target.appendChild(pre);
    return;
  }
  // 行内公式节点在编辑器里由 NodeView 渲染，这里按 content 属性补渲染。
  for (const element of target.querySelectorAll<HTMLElement>("span.dc-math")) {
    const source = element.getAttribute("content") ?? "";
    try {
      katex.render(source, element, { throwOnError: false });
    } catch {
      element.textContent = source;
    }
  }
}
