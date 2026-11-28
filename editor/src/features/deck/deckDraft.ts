import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DeckAssetKind, SlideSource, SourceAsset } from "./deckSource";

export interface DeckAssetReference {
  path: string;
  slideId: number;
  pageNumber: number;
  pageTitle: string | null;
  shapeId: number;
  fingerprint: string;
  sourceRevision: string;
  kind: DeckAssetKind;
  name: string;
  summary: string;
}

export interface DeckDraft {
  title: string;
  markdown: string;
  /** 早期草稿没有模板，首次导出时选择。 */
  template?: string;
  assets: DeckAssetReference[];
}

interface DeckDraftStore {
  drafts: Record<string, DeckDraft>;
  editDraft: (workspace: string, content: Partial<Pick<DeckDraft, "title" | "markdown" | "template">>) => void;
  appendMarkdown: (workspace: string, text: string) => void;
  addAssets: (workspace: string, assets: DeckAssetReference[]) => void;
  removeAsset: (workspace: string, key: string) => void;
}

const EMPTY_DRAFT: DeckDraft = { title: "", markdown: "", assets: [] };

function windowsKey(path: string): string {
  return path.replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase();
}

/** 将原文字当作 Markdown 中的字面文本，保留换行并避免旧内容被解析成语法。 */
export function toMarkdownText(text: string): string {
  const paragraphs = text.trim().split(/\r?\n[\t ]*\r?\n+/);
  return paragraphs.map((paragraph) => {
    const lines = paragraph.split(/\r?\n/);
    return lines.map((line) => line.trim().replace(/[!-\/:-@\[-`{-~]/g, "\\$&")).join("  \n");
  }).join("\n\n");
}

/** 同一源页的对象在草稿中只保留一份，更新来源时沿用已有顺序。 */
export function assetKey(asset: Pick<DeckAssetReference, "path" | "slideId" | "shapeId">): string {
  return JSON.stringify([windowsKey(asset.path), asset.slideId, asset.shapeId]);
}

/** 判断旧引用是否指向当前预览源页，页序变化不会改变同页身份。 */
export function refersToSourcePage(asset: DeckAssetReference, source: SlideSource): boolean {
  return asset.slideId === source.slide_id && windowsKey(asset.path) === windowsKey(source.path);
}

/** 从通过核对的源页对象生成草稿引用。 */
export function makeAssetReference(source: SlideSource, title: string | null, asset: SourceAsset): DeckAssetReference {
  return {
    path: source.path,
    slideId: source.slide_id,
    pageNumber: source.number,
    pageTitle: title,
    shapeId: asset.shape_id,
    fingerprint: asset.fingerprint,
    sourceRevision: source.revision,
    kind: asset.kind,
    name: asset.name,
    summary: asset.summary,
  };
}

const useDeckDraftStore = create<DeckDraftStore>()(persist((set) => ({
  drafts: {},
  editDraft: (workspace, content) => set((state) => {
    const key = windowsKey(workspace);
    const draft = state.drafts[key] ?? EMPTY_DRAFT;
    return { drafts: { ...state.drafts, [key]: { ...draft, ...content } } };
  }),
  appendMarkdown: (workspace, text) => set((state) => {
    const key = windowsKey(workspace);
    const draft = state.drafts[key] ?? EMPTY_DRAFT;
    const prefix = draft.markdown.trimEnd();
    const markdown = prefix ? `${prefix}\n\n${text}` : text;
    return { drafts: { ...state.drafts, [key]: { ...draft, markdown } } };
  }),
  addAssets: (workspace, assets) => set((state) => {
    const key = windowsKey(workspace);
    const draft = state.drafts[key] ?? EMPTY_DRAFT;
    const byIdentity = new Map(draft.assets.map((asset) => [assetKey(asset), asset]));
    for (const asset of assets) {
      byIdentity.set(assetKey(asset), asset);
    }
    return { drafts: { ...state.drafts, [key]: { ...draft, assets: [...byIdentity.values()] } } };
  }),
  removeAsset: (workspace, key) => set((state) => {
    const draftKey = windowsKey(workspace);
    const draft = state.drafts[draftKey] ?? EMPTY_DRAFT;
    const assets = draft.assets.filter((asset) => assetKey(asset) !== key);
    return { drafts: { ...state.drafts, [draftKey]: { ...draft, assets } } };
  }),
}), {
  name: "documentcraft-deck-drafts",
  partialize: (state) => ({ drafts: state.drafts }),
}));

/** 按工作区隔离新页草稿。保存 Markdown 和原生对象引用，预览图像仅保留在当前页面。 */
export function useDeckDraft(workspace: string | null) {
  const draft = useDeckDraftStore((state) => workspace ? state.drafts[windowsKey(workspace)] ?? EMPTY_DRAFT : EMPTY_DRAFT);
  const editDraft = useDeckDraftStore((state) => state.editDraft);
  const appendMarkdown = useDeckDraftStore((state) => state.appendMarkdown);
  const addAssets = useDeckDraftStore((state) => state.addAssets);
  const removeAsset = useDeckDraftStore((state) => state.removeAsset);
  return { draft, editDraft, appendMarkdown, addAssets, removeAsset };
}
