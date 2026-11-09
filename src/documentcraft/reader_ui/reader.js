"use strict";

/*
 * DocumentCraft Markdown 阅读批注前端。
 *
 * documentcraft.reader 通过 PyWebView Bridge 读写审阅数据。
 *
 * spikes/verify_reader_annotations.py 依赖以下 DOM 约定，修改时需同步核对：
 *   - #document 内只放 Python 渲染的正文，验收按 #document p 计数段落；
 *   - #quote 的文本必须等于选中原文，装饰只能用样式或属性；
 *   - #notes 内每条已定位批注的第一个按钮负责定位，待定位批注须含「待重新定位」字样；
 *   - #status 文本以结果开头（如「已导出」），语气用 data-tone 表达；
 *   - 高亮名称固定为 reader-notes 与 reader-active。
 */

const view = document.querySelector("#document");
const paneMessage = document.querySelector("#pane-message");
const pathLabel = document.querySelector("#path");
const form = document.querySelector("#form");
const draft = document.querySelector("#body");
const quote = document.querySelector("#quote");
const save = document.querySelector("#save");
const reload = document.querySelector("#reload");
const shareButton = document.querySelector("#share");
const exportButton = document.querySelector("#export");
const skipExport = document.querySelector("#skip-export");
const includeNotes = document.querySelector("#include-notes");
const statusLine = document.querySelector("#status");
const list = document.querySelector("#notes");
const countLabel = document.querySelector("#count");
const notesSummary = document.querySelector("#notes-summary");
const notesEmpty = document.querySelector("#notes-empty");
const appBar = document.querySelector(".app-bar");
const readingPane = document.querySelector("#reading-pane");
const outlinePanel = document.querySelector("#outline-panel");
const outlineList = document.querySelector("#outline");
const outlineCount = document.querySelector("#outline-count");
const outlineEmpty = document.querySelector("#outline-empty");
const sidebarTabs = Array.from(document.querySelectorAll('.tabs [role="tab"]'));
const workspaceFiles = document.querySelector("#workspace-files");
const workspaceName = document.querySelector("#workspace-name");
const fileTree = document.querySelector("#file-tree");
const filesEmpty = document.querySelector("#files-empty");
const fileFilter = document.querySelector("#file-filter");
const openFile = document.querySelector("#open-file");
const openFolder = document.querySelector("#open-folder");
const aiForm = document.querySelector("#ai-form");
const aiQuestion = document.querySelector("#ai-question");
const aiSearch = document.querySelector("#ai-search");
const aiSend = document.querySelector("#ai-send");
const aiStatus = document.querySelector("#ai-status");
const aiSources = document.querySelector("#ai-sources");
const aiResult = document.querySelector("#ai-result");
const aiAnswer = document.querySelector("#ai-answer");
const aiCitations = document.querySelector("#ai-citations");

// 可批注的块与 Python 端 paragraph 索引对应，改动会破坏已保存锚点的 block 序号。
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6";
// 前后文按 Unicode 码点截取，与已保存批注的 prefix/suffix 长度保持一致。
const CONTEXT_LENGTH = 32;
const EMPTY_QUOTE = "还没有选中文字";
const CROSS_BLOCK_WARNING = "请选择同一段内的文字。";
const HIGHLIGHT_NOTES = "reader-notes";
const HIGHLIGHT_ACTIVE = "reader-active";
const STACK_BREAKPOINT_TOKEN = "--breakpoint-stack";
const OUTLINE_BREAKPOINT_TOKEN = "--breakpoint-outline";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

/** 当前载入的文档版本：{ path, revision, html, notes }。 */
let state;
/** 当前版本中可批注的块元素，顺序即锚点 block 序号。 */
let blocks = [];
/** 待保存的选区锚点。 */
let selection;
/** 正在等待 Python Bridge 时为 true，期间禁止重复操作。 */
let busy = false;
/** 每条批注的渲染结果：{ note, target, range, exportable, item }。 */
let entries = [];
/** 正文目录：{ heading, level, title, link }，顺序与正文一致。 */
let outline = [];
/** 阅读位置所在的目录项。 */
let activeOutline;
/** 已排队的目录同步帧，0 表示没有排队。 */
let outlineFrame = 0;
let searchSnapshot;
const expandedFolders = new Map();

/* ===== 通用工具 ===== */

/**
 * 读取 :root 上的设计令牌值。
 * @param {string} name 令牌名称，含 -- 前缀。
 * @returns {string}
 */
function readToken(name) {
  const rootStyle = getComputedStyle(document.documentElement);
  const value = rootStyle.getPropertyValue(name);
  return value.trim();
}

/**
 * 根据令牌断点切换 html[data-layout]，CSS 媒体查询无法直接引用自定义属性。
 */
function watchLayout() {
  const stackBreakpoint = readToken(STACK_BREAKPOINT_TOKEN);
  const outlineBreakpoint = readToken(OUTLINE_BREAKPOINT_TOKEN);
  const stackQuery = window.matchMedia(`(max-width: ${stackBreakpoint})`);
  const outlineQuery = window.matchMedia(`(max-width: ${outlineBreakpoint})`);
  const apply = () => {
    let layout = "wide";
    if (stackQuery.matches) {
      layout = "stacked";
    } else if (outlineQuery.matches) {
      layout = "split";
    }
    document.documentElement.dataset.layout = layout;
    scheduleOutlineSync();
  };
  apply();
  stackQuery.addEventListener("change", apply);
  outlineQuery.addEventListener("change", apply);
}

/**
 * 当前是否为整页滚动的堆叠布局。
 * @returns {boolean}
 */
function isStacked() {
  return document.documentElement.dataset.layout === "stacked";
}

/**
 * 按用户的减少动效偏好选择滚动方式。
 * @returns {ScrollBehavior}
 */
function scrollBehavior() {
  const reduced = window.matchMedia(REDUCED_MOTION_QUERY).matches;
  return reduced ? "auto" : "smooth";
}

/**
 * 在状态栏显示一条消息。消息正文不加前缀，验收脚本按开头文字判断结果。
 * @param {string} message 消息文本，空串表示清除。
 * @param {"info"|"success"|"warning"|"error"} tone 语气。
 */
function setStatus(message, tone = "info") {
  statusLine.textContent = message;
  statusLine.dataset.tone = tone;
}

/**
 * 从 pywebview 回传的异常中取出可读信息。
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * 按忙碌状态、载入状态和选区同步所有控件的可用性。
 */
function syncControls() {
  const loaded = Boolean(state?.path);
  reload.disabled = busy;
  exportButton.disabled = busy || !loaded;
  shareButton.disabled = busy || !loaded;
  skipExport.disabled = busy;
  includeNotes.disabled = busy || !loaded;
  save.disabled = busy || !selection;
  openFile.disabled = busy || !state;
  openFolder.disabled = busy || !state;
  fileFilter.disabled = busy || !state;
  fileTree.inert = busy;
  document.body.setAttribute("aria-busy", String(busy));
  syncAssistant();
}

/* ===== 选区与锚点 ===== */

/**
 * 找到节点所在的可批注块。
 * @param {Node} node
 * @returns {Element | null | undefined}
 */
function parentBlock(node) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return element?.closest?.(BLOCK_SELECTOR);
}

/**
 * 更新待保存的选区，并刷新引用预览。
 * @param {object | undefined} anchor 选区锚点，undefined 表示清除。
 */
function setSelection(anchor) {
  selection = anchor;
  const hasAnchor = anchor !== undefined;
  quote.textContent = hasAnchor ? anchor.quote : EMPTY_QUOTE;
  quote.dataset.state = hasAnchor ? "selected" : "empty";
  syncControls();
}

/**
 * 把当前 DOM 选区转换为批注锚点：块序号、UTF-16 偏移、原文和前后文。
 * 只接受同一块内的选区，跨块选区无法稳定映射到 Markdown 段落。
 */
function readSelection() {
  if (busy || !state) {
    return;
  }
  const current = window.getSelection();
  if (!current.rangeCount || current.isCollapsed) {
    return;
  }
  const range = current.getRangeAt(0);
  const startsInView = view.contains(range.startContainer);
  const endsInView = view.contains(range.endContainer);
  if (!startsInView && !endsInView) {
    // 焦点移到批注输入框等区域时保留原选区。
    return;
  }
  const block = parentBlock(range.startContainer);
  const endBlock = parentBlock(range.endContainer);
  if (!blocks.includes(block) || block !== endBlock) {
    setSelection(undefined);
    setStatus(CROSS_BLOCK_WARNING, "warning");
    return;
  }

  const selected = range.toString();
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length;
  const text = block.textContent;
  const end = offset + selected.length;
  if (!selected.trim() || text.slice(offset, end) !== selected) {
    setSelection(undefined);
    return;
  }

  // 只清除选区提示，保留导出结果等其他消息。
  if (statusLine.textContent === CROSS_BLOCK_WARNING) {
    setStatus("");
  }
  const prefixPoints = Array.from(text.slice(0, offset));
  const suffixPoints = Array.from(text.slice(end));
  const prefix = prefixPoints.slice(-CONTEXT_LENGTH).join("");
  const suffix = suffixPoints.slice(0, CONTEXT_LENGTH).join("");
  setSelection({
    revision: state.revision,
    path: state.path,
    block: blocks.indexOf(block),
    offset,
    quote: selected,
    prefix,
    suffix,
  });
}

/**
 * 在当前版本中定位一条批注。
 * 版本一致时直接按块序号和偏移核对；否则按原文加前后文全文搜索，
 * 仅在唯一匹配时返回结果，多处匹配视为待重新定位，避免批注挂错位置。
 * @param {object} note 已保存的批注。
 * @returns {{ block: Element, offset: number } | undefined}
 */
function resolve(note) {
  if (note.revision === state.revision) {
    const block = blocks[note.block];
    const end = note.offset + note.quote.length;
    if (block?.textContent.slice(note.offset, end) === note.quote) {
      return { block, offset: note.offset };
    }
  }
  const matches = [];
  for (const block of blocks) {
    const text = block.textContent;
    let offset = text.indexOf(note.quote);
    while (offset !== -1) {
      const end = offset + note.quote.length;
      const prefixMatches = text.slice(0, offset).endsWith(note.prefix);
      const suffixMatches = text.slice(end).startsWith(note.suffix);
      if (prefixMatches && suffixMatches) {
        matches.push({ block, offset });
      }
      offset = text.indexOf(note.quote, offset + 1);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 把块内的字符偏移转换为跨文本节点的 DOM Range。
 * @param {Element} block
 * @param {number} offset 起点，UTF-16 偏移。
 * @param {number} length 长度，UTF-16 单位。
 * @returns {Range}
 */
function highlightRange(block, offset, length) {
  const range = document.createRange();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const limit = offset + length;
  let start = 0;
  let node = walker.nextNode();
  while (node) {
    const end = start + node.length;
    if (start <= offset && offset < end) {
      range.setStart(node, offset - start);
    }
    if (start < limit && limit <= end) {
      range.setEnd(node, limit - start);
      return range;
    }
    start = end;
    node = walker.nextNode();
  }
  throw new Error("选区超出段落。");
}

/**
 * 计算一条批注在当前版本中的位置与高亮范围。
 * 导出只支持带 data-review-block 的顶层段落，其余块可阅读高亮但导出时跳过。
 * @param {object} note
 */
function locateNote(note) {
  const target = resolve(note);
  if (!target) {
    return { note, target: undefined, range: undefined, exportable: false };
  }
  const range = highlightRange(target.block, target.offset, note.quote.length);
  const exportable = target.block.dataset.reviewBlock !== undefined;
  return { note, target, range, exportable };
}

/* ===== 批注列表 ===== */

/**
 * 生成一条批注卡片。已定位批注以引用按钮开头，验收脚本点击 #notes 的第一个按钮定位。
 * @param {object} entry locateNote 的结果。
 * @returns {HTMLLIElement}
 */
function renderNoteItem(entry) {
  const item = document.createElement("li");
  item.className = "note";

  if (entry.range) {
    item.dataset.state = "resolved";
    const link = document.createElement("button");
    link.type = "button";
    link.className = "note__quote";
    link.title = "在正文中定位";
    link.textContent = entry.note.quote;
    link.addEventListener("click", () => activateEntry(entry, "document"));
    item.append(link);
    if (!entry.exportable) {
      const badge = document.createElement("small");
      badge.className = "note__badge";
      badge.dataset.tone = "info";
      badge.textContent = "该位置暂不支持导出";
      item.append(badge);
    }
  } else {
    item.dataset.state = "pending";
    const badge = document.createElement("small");
    badge.className = "note__badge";
    badge.textContent = "待重新定位";
    const missing = document.createElement("p");
    missing.className = "note__quote-text";
    missing.textContent = entry.note.quote;
    item.append(badge, missing);
  }

  const body = document.createElement("p");
  body.className = "note__body";
  body.textContent = entry.note.body;
  item.append(body);
  return item;
}

/**
 * 更新批注计数和待定位摘要。
 */
function renderSummary() {
  const total = entries.length;
  const pending = entries.filter((entry) => !entry.range).length;
  countLabel.textContent = String(total);
  notesEmpty.hidden = total > 0;
  notesSummary.textContent = pending ? `${pending} 条待重新定位` : "";
}

/**
 * 按当前版本重绘批注列表和正文高亮。
 */
function renderNotes() {
  CSS.highlights.delete(HIGHLIGHT_ACTIVE);
  entries = state.notes.map(locateNote);
  const highlights = new Highlight();
  const items = [];
  for (const entry of entries) {
    entry.item = renderNoteItem(entry);
    items.push(entry.item);
    if (entry.range) {
      highlights.add(entry.range);
    }
  }
  list.replaceChildren(...items);
  CSS.highlights.set(HIGHLIGHT_NOTES, highlights);
  renderSummary();
}

/**
 * 激活一条批注：加深正文高亮、标记卡片，并滚动到对应位置。
 * @param {object} entry
 * @param {"document"|"list"} reveal 需要滚动显示的一侧。
 */
function activateEntry(entry, reveal) {
  const activeHighlight = new Highlight(entry.range);
  CSS.highlights.set(HIGHLIGHT_ACTIVE, activeHighlight);
  for (const other of entries) {
    if (other === entry) {
      other.item.setAttribute("aria-current", "true");
    } else {
      other.item.removeAttribute("aria-current");
    }
  }
  const behavior = scrollBehavior();
  if (reveal === "document") {
    entry.target.block.scrollIntoView({ block: "center", behavior });
  } else {
    // 卡片可能在隐藏的批注分区里，先切回批注再滚动。
    showPanel("notes");
    entry.item.scrollIntoView({ block: "nearest", behavior });
  }
}

/**
 * 取消当前激活的批注。
 */
function clearActive() {
  CSS.highlights.delete(HIGHLIGHT_ACTIVE);
  for (const entry of entries) {
    entry.item.removeAttribute("aria-current");
  }
}

/**
 * 返回视口坐标处的文本插入点。
 * @param {number} x
 * @param {number} y
 * @returns {{ node: Node, offset: number } | undefined}
 */
function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) {
      return undefined;
    }
    return { node: position.offsetNode, offset: position.offset };
  }
  const range = document.caretRangeFromPoint?.(x, y);
  if (!range) {
    return undefined;
  }
  return { node: range.startContainer, offset: range.startOffset };
}

/**
 * 点击正文中的高亮时激活对应批注卡片；拖选文字时不处理。
 * @param {MouseEvent} event
 */
function activateAtPoint(event) {
  const current = window.getSelection();
  if (current.rangeCount && !current.isCollapsed) {
    return;
  }
  const caret = caretAt(event.clientX, event.clientY);
  if (!caret || !view.contains(caret.node)) {
    return;
  }
  const hit = entries.find((entry) => entry.range?.isPointInRange(caret.node, caret.offset));
  if (hit) {
    activateEntry(hit, "list");
  } else {
    clearActive();
  }
}

/* ===== 文档目录 ===== */

/**
 * 读取标题级别，h1 为 1。
 * @param {Element} heading
 * @returns {number}
 */
function headingLevel(heading) {
  const digit = heading.tagName.slice(1);
  return Number(digit);
}

/**
 * 生成一个目录项，点击后跳到对应标题。
 * @param {object} entry 目录项数据，生成的按钮写回 entry.link。
 * @param {number} depth 相对最高级标题的层级，0 为顶层。
 * @returns {HTMLLIElement}
 */
function renderOutlineItem(entry, depth) {
  const item = document.createElement("li");
  const link = document.createElement("button");
  link.type = "button";
  link.className = "outline__link";
  link.title = entry.title;
  link.textContent = entry.title;
  link.dataset.depth = String(depth);
  // 只传层级数，缩进距离由 --size-outline-indent 令牌计算。
  link.style.setProperty("--outline-depth", String(depth));
  link.addEventListener("click", () => revealHeading(entry));
  item.append(link);
  entry.link = link;
  return item;
}

/**
 * 按正文标题重建目录。
 * 标题同时是可批注块，这里只读取不写入属性，避免影响批注锚点与验收计数。
 */
function renderOutline() {
  const headings = Array.from(view.querySelectorAll(HEADING_SELECTOR));
  const levels = headings.map(headingLevel);
  const topLevel = Math.min(...levels);
  const items = [];
  outline = [];
  for (const heading of headings) {
    const level = headingLevel(heading);
    const text = heading.textContent.trim();
    const title = text || "（无标题文字）";
    const entry = { heading, level, title, link: undefined };
    const depth = level - topLevel;
    items.push(renderOutlineItem(entry, depth));
    outline.push(entry);
  }
  outlineList.replaceChildren(...items);
  outlineCount.textContent = headings.length ? String(headings.length) : "";
  outlineEmpty.hidden = headings.length > 0;
  activeOutline = undefined;
  syncOutline();
}

/**
 * 阅读区可视顶边的视口坐标，标题越过此线即视为进入该章节。
 * @returns {number}
 */
function readingTop() {
  let edge = readingPane.getBoundingClientRect().top;
  if (isStacked()) {
    // 堆叠布局整页滚动，sticky 顶栏下沿才是可见顶边。
    edge = appBar.getBoundingClientRect().bottom;
  }
  const paneStyle = getComputedStyle(readingPane);
  const padding = parseFloat(paneStyle.paddingTop);
  return edge + padding;
}

/**
 * 阅读区是否已滚到底。末尾章节较短时标题到不了顶边，滚到底时直接视为最后一章。
 * @returns {boolean}
 */
function paneAtBottom() {
  if (isStacked() || readingPane.scrollTop === 0) {
    return false;
  }
  const remaining = readingPane.scrollHeight - readingPane.scrollTop - readingPane.clientHeight;
  // 容差 1px，抵消缩放下的小数像素。
  return remaining < 1;
}

/**
 * 找到阅读位置所在的目录项。
 * @returns {object | undefined}
 */
function currentOutlineEntry() {
  if (outline.length === 0) {
    return undefined;
  }
  if (paneAtBottom()) {
    return outline[outline.length - 1];
  }
  const top = readingTop();
  let current = outline[0];
  for (const entry of outline) {
    const headingTop = entry.heading.getBoundingClientRect().top;
    if (headingTop > top) {
      break;
    }
    current = entry;
  }
  return current;
}

/**
 * 只滚动目录自身让当前项可见；scrollIntoView 在堆叠布局下会带动整页。
 * @param {HTMLElement} link
 */
function revealOutlineLink(link) {
  const panelBox = outlinePanel.getBoundingClientRect();
  const linkBox = link.getBoundingClientRect();
  if (linkBox.top < panelBox.top) {
    outlinePanel.scrollTop -= panelBox.top - linkBox.top;
  } else if (linkBox.bottom > panelBox.bottom) {
    outlinePanel.scrollTop += linkBox.bottom - panelBox.bottom;
  }
}

/**
 * 标记当前目录项，并刷新 AI 的「当前章节」范围。
 * @param {object | undefined} entry
 */
function setActiveOutline(entry) {
  if (entry === activeOutline) {
    return;
  }
  activeOutline = entry;
  for (const other of outline) {
    if (other === entry) {
      other.link.setAttribute("aria-current", "location");
    } else {
      other.link.removeAttribute("aria-current");
    }
  }
  if (entry) {
    revealOutlineLink(entry.link);
  }
  syncAssistant();
}

/**
 * 按阅读位置同步目录高亮。
 */
function syncOutline() {
  const entry = currentOutlineEntry();
  setActiveOutline(entry);
}

/**
 * 每帧最多同步一次目录，滚动事件频率远高于需要。
 */
function scheduleOutlineSync() {
  if (outlineFrame) {
    return;
  }
  outlineFrame = requestAnimationFrame(() => {
    outlineFrame = 0;
    syncOutline();
  });
}

/**
 * 滚动正文到目录项对应的标题。
 * @param {object} entry
 */
function revealHeading(entry) {
  const behavior = scrollBehavior();
  setActiveOutline(entry);
  if (!isStacked()) {
    entry.heading.scrollIntoView({ block: "start", behavior });
    return;
  }
  // 堆叠布局下 sticky 顶栏会遮住标题，按顶栏下沿换算整页滚动距离。
  const headingStyle = getComputedStyle(entry.heading);
  const margin = parseFloat(headingStyle.scrollMarginTop);
  const headingTop = entry.heading.getBoundingClientRect().top;
  const barBottom = appBar.getBoundingClientRect().bottom;
  const distance = headingTop - barBottom - margin;
  window.scrollBy({ top: distance, behavior });
}

/* ===== 侧栏分区 ===== */

/**
 * 切换侧栏分区。
 * @param {"notes"|"ai"} name
 */
function showPanel(name) {
  for (const tab of sidebarTabs) {
    const selected = tab.dataset.panel === name;
    const panelId = tab.getAttribute("aria-controls");
    const panel = document.getElementById(panelId);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
}

/**
 * 左右方向键在分区标签间移动，符合 WAI-ARIA tablist 约定。
 * @param {KeyboardEvent} event
 */
function moveTabFocus(event) {
  const steps = { ArrowRight: 1, ArrowLeft: -1 };
  const step = steps[event.key];
  if (step === undefined) {
    return;
  }
  event.preventDefault();
  const count = sidebarTabs.length;
  const index = sidebarTabs.indexOf(event.currentTarget);
  const nextIndex = (index + step + count) % count;
  const next = sidebarTabs[nextIndex];
  showPanel(next.dataset.panel);
  next.focus();
}

/* ===== 工作区 ===== */

function renderWorkspace() {
  const query = fileFilter.value.trim().toLowerCase();
  const readable = new Set(state.files ?? []);
  const root = { folders: new Map(), files: [] };
  const folderAt = (parts) => {
    let folder = root;
    for (const part of parts) {
      if (!folder.folders.has(part)) {
        folder.folders.set(part, { folders: new Map(), files: [] });
      }
      folder = folder.folders.get(part);
    }
    return folder;
  };
  for (const path of state.directories ?? []) {
    if (path.toLowerCase().includes(query)) {
      folderAt(path.split("/"));
    }
  }
  for (const path of state.entries ?? state.files ?? []) {
    if (path.toLowerCase().includes(query)) {
      folderAt(path.split("/").slice(0, -1)).files.push(path);
    }
  }
  const append = (list, folder, parent) => {
    for (const [name, child] of folder.folders) {
      const item = document.createElement("li");
      const details = document.createElement("details");
      const label = document.createElement("summary");
      const children = document.createElement("ul");
      const full = parent ? parent + "/" + name : name;
      details.open = Boolean(query) || (expandedFolders.get(full) ?? state.path.startsWith(full + "/"));
      details.addEventListener("toggle", () => {
        if (!query && details.isConnected) expandedFolders.set(full, details.open);
      });
      label.textContent = name;
      children.className = "file-tree";
      append(children, child, full);
      details.append(label, children);
      item.append(details);
      list.append(item);
    }
    for (const path of folder.files) {
      const item = document.createElement("li");
      const supported = readable.has(path);
      const label = document.createElement(supported ? "button" : "span");
      label.className = supported ? "outline__link file-link" : "file-attachment";
      label.textContent = path.split("/").at(-1);
      label.title = path;
      if (supported) {
        label.type = "button";
        label.style.setProperty("--outline-depth", "0");
        if (path === state.path) label.setAttribute("aria-current", "page");
        label.addEventListener("click", () => switchDocument(() => window.pywebview.api.open_document(path)));
      }
      item.append(label);
      list.append(item);
    }
  };
  fileTree.replaceChildren();
  append(fileTree, root, "");
  filesEmpty.hidden = fileTree.childElementCount !== 0;
}

function focusSource(source) {
  const excerpt = source.excerpt.split("\n").find((line) => line.trim() && !line.startsWith("#")) ?? "";
  const probe = excerpt.replace(/[*_\x60]/g, "").trim().slice(0, 48);
  const matches = probe ? blocks.filter((block) => block.textContent.includes(probe)) : [];
  if (matches.length === 1) {
    matches[0].scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }
  setStatus("来源 · " + source.path + " · 第 " + source.line + " 行");
}

function switchDocument(open, source) {
  if (busy) return;
  if (source && source.path === state?.path) {
    focusSource(source);
    return;
  }
  if (draft.value.trim() && !window.confirm("切换文件会清除当前未保存的批注草稿，继续吗？")) return;
  run(async () => {
    const loaded = await open();
    if (!loaded) return;
    draft.value = "";
    applyState(loaded);
    readingPane.scrollTop = 0;
    if (document.documentElement.dataset.layout !== "wide") workspaceFiles.open = false;
    if (source) focusSource(source);
  });
}

/* ===== 工作区 AI ===== */

function syncAssistant() {
  const query = aiQuestion.value.trim();
  aiQuestion.disabled = busy;
  aiSearch.disabled = busy || !state || !query;
  aiSend.disabled = busy || !searchSnapshot?.sources.length || searchSnapshot.question !== query;
}

function resetAssistant() {
  searchSnapshot = undefined;
  aiQuestion.value = "";
  aiStatus.textContent = "";
  aiSources.replaceChildren();
  aiCitations.replaceChildren();
  aiAnswer.replaceChildren();
  aiResult.hidden = true;
}

function sourceButton(source, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "citation-link";
  button.textContent = text ?? ("[" + source.id + "] " + source.path + " · 第 " + source.line + " 行");
  button.addEventListener("click", () => switchDocument(() => window.pywebview.api.open_document(source.path), source));
  return button;
}

async function localSearch() {
  const question = aiQuestion.value.trim();
  searchSnapshot = undefined;
  aiSources.replaceChildren();
  aiResult.hidden = true;
  aiStatus.textContent = "正在本地检索…";
  const sources = await window.pywebview.api.search_workspace(question);
  searchSnapshot = { question, sources };
  for (const source of sources) {
    const item = document.createElement("li");
    const detail = document.createElement("details");
    const label = document.createElement("summary");
    const body = document.createElement("p");
    detail.className = "message";
    label.className = "message__meta";
    label.textContent = "[" + source.id + "] " + source.path + " · 第 " + source.line + " 行";
    body.className = "message__body";
    body.textContent = source.excerpt;
    detail.append(label, body, sourceButton(source, "查看原文"));
    item.append(detail);
    aiSources.append(item);
  }
  aiStatus.textContent = sources.length ? "找到 " + sources.length + " 条摘录，展开可核对。" : "没有找到相关摘录。";
}

async function organize() {
  aiResult.hidden = true;
  aiStatus.textContent = "正在整理已确认的摘录…";
  const result = await window.pywebview.api.organize_workspace(searchSnapshot.question);
  const lookup = new Map(result.sources.map((source) => [String(source.id), source]));
  aiAnswer.replaceChildren();
  for (const part of result.answer.split(/(\[\d+\])/)) {
    const citation = /^\[(\d+)\]$/.exec(part);
    const source = citation && lookup.get(citation[1]);
    aiAnswer.append(source ? sourceButton(source, part) : document.createTextNode(part));
  }
  aiCitations.replaceChildren();
  for (const source of result.sources) {
    const item = document.createElement("li");
    item.append(sourceButton(source));
    aiCitations.append(item);
  }
  aiResult.hidden = false;
  aiStatus.textContent = "整理完成。";
}

/* ===== Python Bridge 操作 ===== */

/**
 * 从 Python 端载入当前版本的正文与批注。
 */
async function load() {
  applyState(await window.pywebview.api.load());
}

function applyState(loaded) {
  if (state && state.workspace_path !== loaded.workspace_path) {
    resetAssistant();
    expandedFolders.clear();
    fileFilter.value = "";
  }
  state = loaded;
  // Python 端已按白名单过滤标签并清空属性，这里直接写入。
  view.innerHTML = loaded.html;
  blocks = Array.from(view.querySelectorAll(BLOCK_SELECTOR));
  renderOutline();
  workspaceName.textContent = loaded.workspace || "工作区";
  renderWorkspace();
  pathLabel.textContent = loaded.path || "请选择 Markdown";
  pathLabel.title = loaded.path;
  const isEmpty = !view.textContent.trim() && !view.querySelector("img, hr");
  paneMessage.textContent = loaded.path ? "文档没有可显示的正文。" : "从左侧打开 Markdown 文件。";
  paneMessage.hidden = !isEmpty;
  setSelection(undefined);
  renderNotes();
}

/**
 * 串行执行一次 Bridge 操作：期间锁定控件，失败时在状态栏显示原因。
 * @param {() => Promise<void>} action
 */
async function run(action) {
  if (busy) {
    return;
  }
  busy = true;
  skipExport.hidden = true;
  setStatus("");
  syncControls();
  try {
    await action();
  } catch (error) {
    const message = errorMessage(error);
    setStatus(message, "error");
    if (!state) {
      paneMessage.textContent = "无法载入文档。";
      paneMessage.hidden = false;
    }
  } finally {
    busy = false;
    syncControls();
  }
}

/**
 * 构造导出计划：可导出批注的 Markdown 段落序号与码点偏移，以及全部批注 ID。
 * Python 端用 note_ids 核对批注是否在阅读后被修改，未出现在 targets 中的批注计为待定位。
 * @returns {{ targets: object[], note_ids: number[] }}
 */
function buildExportPlan() {
  const targets = [];
  for (const entry of entries) {
    if (!entry.exportable) {
      continue;
    }
    const block = entry.target.block;
    const leadingText = block.textContent.slice(0, entry.target.offset);
    // DOM 偏移按 UTF-16 计算，DOCX 端按 Unicode 码点计算。
    const offset = Array.from(leadingText).length;
    const reviewBlock = Number(block.dataset.reviewBlock);
    targets.push({ id: entry.note.id, block: reviewBlock, offset });
  }
  const noteIds = state.notes.map((note) => note.id);
  return { targets, note_ids: noteIds };
}

/**
 * 导出 DOCX。存在待定位批注时先提示，由用户决定是否跳过。
 * @param {boolean} skip 是否跳过无法导出的批注。
 */
async function exportDocx(skip) {
  if (!state) {
    return;
  }
  const plan = includeNotes.checked ? buildExportPlan() : null;
  const result = await window.pywebview.api.export_docx(state.revision, plan, skip);
  if (result.status === "unresolved") {
    setStatus(`${result.count} 条批注待重新定位或选区暂不支持导出。`, "warning");
    skipExport.hidden = false;
  } else if (result.status === "converted") {
    setStatus("已导出：" + result.output, "success");
  } else if (result.status === "cancelled") {
    setStatus("已取消导出。");
  }
}

/**
 * 把当前 Markdown 与本篇批注打包为 ZIP。
 */
async function exportShare() {
  const result = await window.pywebview.api.export_share(state.revision);
  if (result.status === "shared") {
    setStatus("已打包：" + result.output, "success");
  } else if (result.status === "cancelled") {
    setStatus("已取消打包。");
  }
}

/**
 * 保存当前选区的批注并重新载入。
 */
async function saveNote() {
  await window.pywebview.api.save_note(selection, draft.value);
  draft.value = "";
  await load();
  setStatus("批注已保存。", "success");
}

/* ===== 事件绑定 ===== */

reload.addEventListener("click", () => run(load));
exportButton.addEventListener("click", () => run(() => exportDocx(false)));
skipExport.addEventListener("click", () => run(() => exportDocx(true)));
shareButton.addEventListener("click", () => run(exportShare));
includeNotes.addEventListener("change", () => {
  skipExport.hidden = true;
});

view.addEventListener("pointerdown", () => setSelection(undefined));
view.addEventListener("click", activateAtPoint);
document.addEventListener("selectionchange", readSelection);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearActive();
  }
});

draft.addEventListener("keydown", (event) => {
  const submitShortcut = event.key === "Enter" && (event.ctrlKey || event.metaKey);
  if (!submitShortcut) {
    return;
  }
  event.preventDefault();
  if (!save.disabled) {
    save.click();
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!selection) {
    return;
  }
  run(saveNote);
});

// 两个滚动源都要监听：分栏布局滚动阅读区，堆叠布局滚动整页。
readingPane.addEventListener("scroll", scheduleOutlineSync, { passive: true });
window.addEventListener("scroll", scheduleOutlineSync, { passive: true });
window.addEventListener("resize", scheduleOutlineSync);

for (const tab of sidebarTabs) {
  tab.addEventListener("click", () => showPanel(tab.dataset.panel));
  tab.addEventListener("keydown", moveTabFocus);
}

openFile.addEventListener("click", () => switchDocument(() => window.pywebview.api.choose_file()));
openFolder.addEventListener("click", () => switchDocument(() => window.pywebview.api.choose_folder()));
fileFilter.addEventListener("input", renderWorkspace);
aiQuestion.addEventListener("input", syncAssistant);
aiForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!aiSearch.disabled) runAssistant(localSearch);
});
aiSend.addEventListener("click", () => {
  if (!aiSend.disabled) runAssistant(organize);
});

function runAssistant(action) {
  run(async () => {
    try {
      await action();
    } catch (error) {
      aiStatus.textContent = errorMessage(error);
    }
  });
}

watchLayout();
window.addEventListener("pywebviewready", () => run(load));
