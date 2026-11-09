const view = document.querySelector("#document");
const form = document.querySelector("#form");
const draft = document.querySelector("#body");
const quote = document.querySelector("#quote");
const save = document.querySelector("#save");
const reload = document.querySelector("#reload");
const shareButton = document.querySelector("#share");
const exportButton = document.querySelector("#export");
const skipExport = document.querySelector("#skip-export");
const includeNotes = document.querySelector("#include-notes");
const status = document.querySelector("#status");
const list = document.querySelector("#notes");
const selector = "p,h1,h2,h3,h4,h5,h6";
const contextLength = 32;

let state;
let blocks = [];
let selection;
let busy = false;

function parentBlock(node) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return element?.closest?.(selector);
}

function setSelection(anchor) {
  selection = anchor;
  quote.textContent = anchor?.quote ?? "还没有选中文字";
  save.disabled = busy || !anchor;
}

function readSelection() {
  if (busy || !state) return;
  const current = window.getSelection();
  if (!current.rangeCount || current.isCollapsed) return;
  const range = current.getRangeAt(0);
  if (!view.contains(range.startContainer) && !view.contains(range.endContainer)) return;
  const block = parentBlock(range.startContainer);
  if (!blocks.includes(block) || block !== parentBlock(range.endContainer)) {
    setSelection(undefined);
    status.textContent = "请选择同一段内的文字。";
    return;
  }
  const selected = range.toString();
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length;
  const text = block.textContent;
  if (!selected.trim() || text.slice(offset, offset + selected.length) !== selected) {
    setSelection(undefined);
    return;
  }
  status.textContent = "";
  setSelection({
    revision: state.revision,
    block: blocks.indexOf(block),
    offset,
    quote: selected,
    prefix: Array.from(text.slice(0, offset)).slice(-contextLength).join(""),
    suffix: Array.from(text.slice(offset + selected.length)).slice(0, contextLength).join(""),
  });
}

function resolve(note) {
  if (note.revision === state.revision) {
    const block = blocks[note.block];
    if (block?.textContent.slice(note.offset, note.offset + note.quote.length) === note.quote) {
      return { block, offset: note.offset };
    }
  }
  const matches = [];
  for (const block of blocks) {
    const text = block.textContent;
    let offset = text.indexOf(note.quote);
    while (offset !== -1) {
      const end = offset + note.quote.length;
      if (text.slice(0, offset).endsWith(note.prefix) && text.slice(end).startsWith(note.suffix)) {
        matches.push({ block, offset });
      }
      offset = text.indexOf(note.quote, offset + 1);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function highlightRange(block, offset, length) {
  const range = document.createRange();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const limit = offset + length;
  let start = 0;
  let node = walker.nextNode();
  while (node) {
    const end = start + node.length;
    if (start <= offset && offset < end) range.setStart(node, offset - start);
    if (start < limit && limit <= end) {
      range.setEnd(node, limit - start);
      return range;
    }
    start = end;
    node = walker.nextNode();
  }
  throw new Error("选区超出段落。");
}

function renderNotes() {
  list.replaceChildren();
  document.querySelector("#count").textContent = String(state.notes.length);
  CSS.highlights.delete("reader-active");
  const highlights = new Highlight();
  for (const note of state.notes) {
    const item = document.createElement("li");
    const target = resolve(note);
    const body = document.createElement("p");
    body.textContent = note.body;
    if (target) {
      const range = highlightRange(target.block, target.offset, note.quote.length);
      highlights.add(range);
      const link = document.createElement("button");
      link.textContent = note.quote;
      link.type = "button";
      link.addEventListener("click", () => {
        CSS.highlights.set("reader-active", new Highlight(range));
        target.block.scrollIntoView({ block: "center" });
      });
      item.append(link);
    } else {
      const missing = document.createElement("small");
      missing.textContent = "待重新定位 · " + note.quote;
      item.append(missing);
    }
    item.append(body);
    list.append(item);
  }
  CSS.highlights.set("reader-notes", highlights);
}

async function load() {
  state = await window.pywebview.api.load();
  view.innerHTML = state.html;
  blocks = Array.from(view.querySelectorAll(selector));
  document.querySelector("#path").textContent = state.path;
  setSelection(undefined);
  renderNotes();
}

async function run(action) {
  if (busy) return;
  busy = true;
  reload.disabled = true;
  exportButton.disabled = true;
  shareButton.disabled = true;
  skipExport.disabled = true;
  skipExport.hidden = true;
  save.disabled = true;
  status.textContent = "";
  try {
    await action();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    busy = false;
    reload.disabled = false;
    exportButton.disabled = false;
    shareButton.disabled = !state;
    skipExport.disabled = false;
    save.disabled = !selection;
  }
}

async function exportDocx(skip) {
  if (!state) return;
  let plan = null;
  if (includeNotes.checked) {
    const targets = [];
    for (const note of state.notes) {
      const target = resolve(note);
      if (target?.block.dataset.reviewBlock !== undefined) {
        const offset = Array.from(target.block.textContent.slice(0, target.offset)).length;
        targets.push({ id: note.id, block: Number(target.block.dataset.reviewBlock), offset });
      }
    }
    plan = { targets, note_ids: state.notes.map(note => note.id) };
  }
  const result = await window.pywebview.api.export_docx(state.revision, plan, skip);
  if (result.status === "unresolved") {
    status.textContent = result.count + " 条批注待重新定位或选区暂不支持导出。";
    skipExport.hidden = false;
  } else if (result.status === "converted") {
    status.textContent = "已导出：" + result.output;
  }
}

shareButton.addEventListener("click", () => run(async () => {
  const result = await window.pywebview.api.export_share(state.revision);
  if (result.status === "shared") {
    status.textContent = "已打包：" + result.output;
  }
}));
exportButton.addEventListener("click", () => run(() => exportDocx(false)));
skipExport.addEventListener("click", () => run(() => exportDocx(true)));
includeNotes.addEventListener("change", () => { skipExport.hidden = true; });
view.addEventListener("pointerdown", () => setSelection(undefined));
document.addEventListener("selectionchange", readSelection);
reload.addEventListener("click", () => run(load));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!selection) return;
  run(async () => {
    await window.pywebview.api.save_note(selection, draft.value);
    draft.value = "";
    await load();
    status.textContent = "批注已保存。";
  });
});
window.addEventListener("pywebviewready", () => run(load));

