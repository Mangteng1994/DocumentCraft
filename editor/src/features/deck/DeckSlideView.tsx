import type { CSSProperties } from "react";
import { DECK_ASSET_LABELS, type SlideBounds, type SourceAsset } from "./deckSource";
import type { SlideAssetChoice } from "./useDeckSourcePicker";
import "./deck.css";

interface DeckSlideViewProps {
  pageTitle: string;
  png: string | null;
  choices: SlideAssetChoice[];
  onToggle: (id: number) => void;
}

/** 定位值来自 PPTX，按钮的边框、颜色和排版使用应用设计令牌。 */
function hotspotStyle(bounds: SlideBounds): CSSProperties {
  return {
    left: `${bounds.left * 100}%`,
    top: `${bounds.top * 100}%`,
    width: `${bounds.width * 100}%`,
    height: `${bounds.height * 100}%`,
    transform: `rotate(${bounds.rotation}deg)`,
  };
}

function assetLabel(asset: SourceAsset): string {
  return `${DECK_ASSET_LABELS[asset.kind]} · ${asset.name}`;
}

export function DeckSlideView({ pageTitle, png, choices, onToggle }: DeckSlideViewProps) {
  return (
    <div className="dc-deck-slide">
      {png && (
        <div className="dc-deck-preview">
          <img className="dc-deck-preview-image" src={`data:image/png;base64,${png}`} alt={pageTitle} />
          {choices.map(({ asset, selected, state }) => asset.bounds && (
            <button
              key={asset.shape_id}
              type="button"
              className="dc-deck-hotspot"
              style={hotspotStyle(asset.bounds)}
              title={assetLabel(asset)}
              aria-label={assetLabel(asset)}
              aria-pressed={selected || (state === "added" && asset.kind !== "text")}
              disabled={state === "added" && asset.kind !== "text"}
              onClick={() => onToggle(asset.shape_id)}
              tabIndex={-1}
            />
          ))}
        </div>
      )}
      {choices.length === 0 ? (
        <p className="dc-status-line">这一页没有可选的文字、图片、图表、表格或组合。</p>
      ) : (
        <ul className="dc-search-matches" aria-label="当前页素材">
          {choices.map(({ asset, selected, state }) => (
            <li key={asset.shape_id}>
              <button
                type="button"
                className="dc-search-match dc-deck-asset"
                aria-pressed={selected || (state === "added" && asset.kind !== "text")}
                disabled={state === "added" && asset.kind !== "text"}
                onClick={() => onToggle(asset.shape_id)}
              >
                <span className="dc-search-snippet">{assetLabel(asset)}{asset.summary ? ` · ${asset.summary}` : ""}</span>
                {state === "added" && <span className="dc-preview-tag">{selected ? "已选文字" : "已加入"}</span>}
                {state === "changed" && <span className="dc-preview-tag">来源有变化</span>}
                {state === "available" && selected && <span className="dc-preview-tag">已选</span>}
                {state === "changed" && selected && <span className="dc-preview-tag">将替换</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
