/** 用正文位置恢复页签视口，并在图片改变排版时维持原来的视觉偏移。 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

interface ReadingAnchor {
  position: number;
  offset: number;
}

export interface DocumentViewport {
  scrollTop: number;
  anchor: ReadingAnchor | null;
}

interface ViewportRestore {
  view: EditorView;
  doc: PMNode;
  viewport: DocumentViewport;
  isAtRestoredScroll: () => boolean;
  dispose: () => void;
}

const READER_INPUT_EVENTS = ["wheel", "pointerdown", "keydown"] as const;
// WebView 的滚动位置可能按设备像素舍入。
const SCROLL_TOLERANCE = 1;
let restoring: ViewportRestore | null = null;

function scrollContainer(view: EditorView): HTMLElement | null {
  return view.dom.closest<HTMLElement>(".dc-editor-scroll");
}

/** 记录视口上缘命中的正文位置和偏移，滚动值留作无可用正文位置时的退路。 */
export function captureDocumentViewport(view: EditorView): DocumentViewport {
  if (restoring?.view === view && restoring.doc === view.state.doc && restoring.isAtRestoredScroll()) {
    // 快速切走时图片可能还没加载完，保留原锚点，避免记录临时的滚动位置。
    return restoring.viewport;
  }
  const container = scrollContainer(view);
  const scrollTop = container?.scrollTop ?? 0;
  if (!container || scrollTop <= 0) {
    return { scrollTop, anchor: null };
  }
  const bounds = container.getBoundingClientRect();
  const viewportTop = bounds.top + container.clientTop;
  const viewportLeft = bounds.left + container.clientLeft;
  const content = view.dom.getBoundingClientRect();
  const left = Math.max(content.left, viewportLeft);
  const right = Math.min(content.right, viewportLeft + container.clientWidth);
  const top = Math.max(content.top, viewportTop);
  const bottom = Math.min(content.bottom, viewportTop + container.clientHeight);
  if (left >= right || top >= bottom) {
    return { scrollTop, anchor: null };
  }
  const hit = view.posAtCoords({ left: (left + right) / 2, top: top + Math.min(1, (bottom - top) / 2) });
  if (!hit) {
    return { scrollTop, anchor: null };
  }
  const offset = view.coordsAtPos(hit.pos).top - viewportTop;
  return { scrollTop, anchor: { position: hit.pos, offset } };
}

/** 用户滚动、主动定位或换文档时，结束当前页签的恢复。 */
export function stopRestoringDocumentViewport(): void {
  const previous = restoring;
  restoring = null;
  previous?.dispose();
}

/** 先恢复到正文锚点，再随排版变化补偿锚点上方图片的高度。 */
export function restoreDocumentViewport(view: EditorView, viewport: DocumentViewport): void {
  const container = scrollContainer(view);
  if (!container) {
    return;
  }
  const doc = view.state.doc;
  const anchor = viewport.anchor;
  if (!anchor || anchor.position > doc.content.size) {
    container.scrollTop = viewport.scrollTop;
    return;
  }

  // 恢复期间由正文锚点补偿位移，避免 WebView 的自动滚动锚定同时改写滚动位置。
  const overflowAnchor = container.style.overflowAnchor;
  container.style.overflowAnchor = "none";
  let appliedScrollTop = container.scrollTop;
  const isAtRestoredScroll = () => {
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const expected = Math.min(appliedScrollTop, maxScrollTop);
    return Math.abs(container.scrollTop - expected) < SCROLL_TOLERANCE;
  };
  const handleScroll = () => {
    if (!isAtRestoredScroll()) {
      stopRestoringDocumentViewport();
    }
  };
  const alignAnchor = () => {
    if (restoring !== restoration) {
      return;
    }
    if (view.state.doc !== doc || !container.isConnected || !isAtRestoredScroll()) {
      stopRestoringDocumentViewport();
      return;
    }
    if (container.clientHeight === 0) {
      return;
    }
    const viewportTop = container.getBoundingClientRect().top + container.clientTop;
    const offset = view.coordsAtPos(anchor.position).top - viewportTop;
    const change = offset - anchor.offset;
    if (Math.abs(change) >= SCROLL_TOLERANCE) {
      container.scrollTop += change;
    }
    appliedScrollTop = container.scrollTop;
  };

  const resize = new ResizeObserver(alignAnchor);
  const restoration: ViewportRestore = {
    view,
    doc,
    viewport,
    isAtRestoredScroll,
    dispose() {
      resize.disconnect();
      container.style.overflowAnchor = overflowAnchor;
      container.removeEventListener("scroll", handleScroll);
      view.dom.removeEventListener("load", alignAnchor, true);
      view.dom.removeEventListener("error", alignAnchor, true);
      for (const event of READER_INPUT_EVENTS) {
        container.removeEventListener(event, stopRestoringDocumentViewport, true);
      }
    },
  };
  restoring = restoration;
  resize.observe(view.dom);
  resize.observe(container);
  // 单张图片的位置变化不一定反映在正文的总高度上。
  view.dom.addEventListener("load", alignAnchor, true);
  view.dom.addEventListener("error", alignAnchor, true);
  container.addEventListener("scroll", handleScroll, { passive: true });
  for (const event of READER_INPUT_EVENTS) {
    container.addEventListener(event, stopRestoringDocumentViewport, { capture: true, passive: true });
  }
  alignAnchor();
}
