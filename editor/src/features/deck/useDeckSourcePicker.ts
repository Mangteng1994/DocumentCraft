import { useState } from "react";
import type { SearchSlide } from "../../backend";
import { assetKey, makeAssetReference, refersToSourcePage, toMarkdownText, useDeckDraft } from "./deckDraft";
import { useSlideSource, type SourceAsset } from "./deckSource";

export interface SlideAssetChoice {
  asset: SourceAsset;
  state: "available" | "added" | "changed";
  selected: boolean;
}

/** 管理同一张源页的点选和版本比对。展示层只需渲染选项并回传形状 ID。 */
export function useDeckSourcePicker(path: string, slide: SearchSlide, workspace: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<Set<number>>(() => new Set());
  const [notice, setNotice] = useState("");
  const preview = useSlideSource(path, slide.id, attempt);
  const { source, loading } = preview;
  const { draft, addAssets, appendMarkdown } = useDeckDraft(workspace);
  const added = new Map(draft.assets.map((asset) => [assetKey(asset), asset]));
  const choices: SlideAssetChoice[] = (source?.assets ?? []).map((asset) => {
    const key = assetKey({ path: source?.path ?? path, slideId: slide.id, shapeId: asset.shape_id });
    const prior = added.get(key);
    const state = prior ? (prior.fingerprint === asset.fingerprint ? "added" : "changed") : "available";
    return { asset, state, selected: selection.has(asset.shape_id) };
  });
  const selected = choices.filter((item) => item.selected && item.state !== "added");
  const textSelection = choices.filter((item) => item.selected && item.asset.kind === "text" && item.asset.text);
  const liveIds = new Set(source?.assets.map((asset) => asset.shape_id));
  const missing = source
    ? draft.assets.filter((asset) => refersToSourcePage(asset, source) && !liveIds.has(asset.shapeId))
    : [];

  const toggle = (id: number) => {
    setNotice("");
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const canAdd = Boolean(workspace && source && !loading && selected.length > 0);
  const addSelection = () => {
    if (!canAdd || !workspace || !source) {
      return;
    }
    const references = selected.map(({ asset }) => makeAssetReference(source, slide.title, asset));
    addAssets(workspace, references);
    setSelection(new Set());
    setNotice(`已将 ${references.length} 个素材加入当前新页。`);
  };

  const copyTextToMarkdown = () => {
    if (!workspace || !source || loading || textSelection.length === 0) {
      return;
    }
    const text = textSelection.map(({ asset }) => toMarkdownText(asset.text ?? "")).join("\n\n");
    appendMarkdown(workspace, text);
    const textIds = new Set(textSelection.map(({ asset }) => asset.shape_id));
    setSelection((current) => new Set([...current].filter((id) => !textIds.has(id))));
    setNotice(`已将 ${textSelection.length} 个文字对象的内容加入当前新页的 Markdown。`);
  };

  const retry = () => {
    setSelection(new Set());
    setNotice("");
    setAttempt((current) => current + 1);
  };

  return {
    ...preview,
    choices,
    missingCount: missing.length,
    notice,
    canAdd,
    canCopyText: Boolean(workspace && source && !loading && textSelection.length > 0),
    hasNativeText: selected.some(({ asset }) => asset.kind === "text"),
    copyTextToMarkdown,
    newPageAssetCount: draft.assets.length,
    selectedCount: selected.length,
    replacing: selected.some((item) => item.state === "changed"),
    toggle,
    addSelection,
    retry,
  };
}
