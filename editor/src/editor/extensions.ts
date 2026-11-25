/**
 * 编辑器 schema。
 *
 * 节点和 mark 的名称、属性与 VMark Markdown 管线（vendor/vmark/utils/markdownPipeline）
 * 生成和读取的一致，改名会导致对应 Markdown 结构在往返时丢失。VMark 的源码预览、弹出编辑器、
 * 媒体播放器等交互不移植：数学、脚注、HTML、前置元数据等结构只做只读展示并原样保存。
 */

import { Extension, Mark, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import katex from "katex";
import { resolveImageSource } from "./assets";
import { annotationExtension } from "./annotations";
import { imageSupportExtension } from "./imageSupport";
import { headingNumbersExtension } from "./headingNumbers";
import { headingFoldExtension } from "./headingFold";
import { documentSearchExtension } from "./documentSearch";

/** 管线为块节点记录的空行数和源码行号，参与原文空行的保留。 */
const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "bulletList",
  "orderedList",
  "horizontalRule",
  "table",
  "block_image",
  "footnote_definition",
  "alertBlock",
  "detailsBlock",
  "frontmatter",
  "link_definition",
  "html_block",
];

const PipelineAttributes = Extension.create({
  name: "pipelineAttributes",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          blankLinesBefore: { default: null, rendered: false },
          sourceLine: { default: null, rendered: false },
        },
      },
    ];
  },
});

/** 列表项的任务勾选状态，null 表示普通列表项。 */
const TaskListItemAttributes = Extension.create({
  name: "taskListItemAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["listItem"],
        attributes: {
          checked: {
            default: null,
            renderHTML: (attributes) => {
              if (attributes.checked === null || attributes.checked === undefined) {
                return {};
              }
              return { "data-checked": String(attributes.checked) };
            },
          },
        },
      },
    ];
  },
});

/** 引用式链接需要保留 referenceId/referenceType 才能原样写回。 */
const LinkReferenceAttributes = Extension.create({
  name: "linkReferenceAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["link"],
        attributes: {
          referenceId: { default: null, rendered: false },
          referenceType: { default: null, rendered: false },
        },
      },
    ];
  },
});

function simpleMark(name: string, tag: string) {
  return Mark.create({
    name,
    parseHTML() {
      return [{ tag }];
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, HTMLAttributes, 0];
    },
  });
}

/**
 * 图片 src 属性：显示时转成 WebView 可加载的地址，原始路径另存于 data-src。
 * 粘贴时按 data-src 读取图片引用，避免把 WebView 加载地址写进 Markdown。
 */
const imageSourceAttribute = {
  default: "",
  parseHTML: (element: HTMLElement) => element.getAttribute("data-src") ?? element.getAttribute("src"),
  renderHTML: (attributes: Record<string, unknown>) => ({
    src: resolveImageSource(attributes.src),
    "data-src": attributes.src,
  }),
};

const InlineImage = Image.extend({
  inline: true,
  group: "inline",
  addAttributes() {
    return {
      src: imageSourceAttribute,
      alt: { default: null },
      title: { default: null },
    };
  },
});

const BlockImage = Node.create({
  name: "block_image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: imageSourceAttribute,
      alt: { default: "" },
      title: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "figure.dc-block-image",
        getAttrs(element) {
          const image = element.querySelector("img");
          if (!image) {
            return false;
          }
          return {
            src: imageSourceAttribute.parseHTML(image),
            alt: image.getAttribute("alt") ?? "",
            title: image.getAttribute("title") ?? "",
          };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", { class: "dc-block-image" }, ["img", HTMLAttributes]];
  },
});

const MathInline = Node.create({
  name: "math_inline",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return { content: { default: "" } };
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "dc-math" })];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "dc-math";
      const source = String(node.attrs.content ?? "");
      try {
        katex.render(source, dom, { throwOnError: false });
      } catch {
        dom.textContent = source;
      }
      return { dom };
    };
  },
});

function atomBlock(name: string, className: string, attrs: Record<string, { default: unknown }>, label: (attrs: Record<string, unknown>) => string) {
  return Node.create({
    name,
    group: "block",
    atom: true,
    addAttributes() {
      return attrs;
    },
    renderHTML({ node }) {
      return ["pre", { class: className, contenteditable: "false" }, label(node.attrs)];
    },
  });
}

const Frontmatter = atomBlock("frontmatter", "dc-raw-block dc-frontmatter", { value: { default: "" } }, (attrs) => `---\n${attrs.value ?? ""}\n---`);
const HtmlBlock = atomBlock("html_block", "dc-raw-block", { value: { default: "" } }, (attrs) => String(attrs.value ?? ""));
const LinkDefinition = atomBlock(
  "link_definition",
  "dc-raw-block",
  {
    identifier: { default: "" },
    label: { default: null },
    url: { default: "" },
    title: { default: null },
  },
  (attrs) => `[${attrs.label ?? attrs.identifier}]: ${attrs.url}`,
);

const HtmlInline = Node.create({
  name: "html_inline",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return { value: { default: "" } };
  },
  renderHTML({ node }) {
    return ["code", { class: "dc-raw-inline" }, String(node.attrs.value ?? "")];
  },
});

const FootnoteReference = Node.create({
  name: "footnote_reference",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return { label: { default: "1" } };
  },
  renderHTML({ node }) {
    return ["sup", { class: "dc-footnote-ref" }, `[${node.attrs.label}]`];
  },
});

const FootnoteDefinition = Node.create({
  name: "footnote_definition",
  group: "block",
  content: "paragraph",
  addAttributes() {
    return { label: { default: "1" } };
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "dc-footnote", "data-label": node.attrs.label }), 0];
  },
});

const AlertBlock = Node.create({
  name: "alertBlock",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return { alertType: { default: "NOTE" } };
  },
  renderHTML({ node }) {
    const type = String(node.attrs.alertType ?? "NOTE").toLowerCase();
    return ["div", { class: `dc-alert dc-alert-${type}`, "data-alert": node.attrs.alertType }, 0];
  },
});

const DetailsBlock = Node.create({
  name: "detailsBlock",
  group: "block",
  content: "detailsSummary block+",
  defining: true,
  addAttributes() {
    return { open: { default: false } };
  },
  renderHTML() {
    return ["details", { class: "dc-details", open: "open" }, 0];
  },
});

const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "inline*",
  renderHTML() {
    return ["summary", {}, 0];
  },
});

const WikiLink = Node.create({
  name: "wikiLink",
  inline: true,
  group: "inline",
  content: "text*",
  addAttributes() {
    return { value: { default: "" } };
  },
  renderHTML() {
    return ["span", { class: "dc-wiki-link" }, 0];
  },
});

/** 创建编辑器扩展列表。 */
export function createExtensions() {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: false },
    }),
    PipelineAttributes,
    TaskListItemAttributes,
    LinkReferenceAttributes,
    simpleMark("subscript", "sub"),
    simpleMark("superscript", "sup"),
    simpleMark("highlight", "mark"),
    InlineImage.configure({ allowBase64: true }),
    BlockImage,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader.extend({
      addAttributes() {
        return { ...this.parent?.(), alignment: { default: null } };
      },
    }),
    TableCell.extend({
      addAttributes() {
        return { ...this.parent?.(), alignment: { default: null } };
      },
    }),
    MathInline,
    FootnoteReference,
    FootnoteDefinition,
    AlertBlock,
    DetailsBlock,
    DetailsSummary,
    WikiLink,
    LinkDefinition,
    Frontmatter,
    HtmlInline,
    HtmlBlock,
    annotationExtension,
    imageSupportExtension,
    headingNumbersExtension,
    headingFoldExtension,
    documentSearchExtension,
  ];
}
