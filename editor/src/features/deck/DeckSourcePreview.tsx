import { X } from "lucide-react";
import type { SearchSlide } from "../../backend";
import { StatusLine } from "../../components/Dialog";
import { iconSize } from "../../styles/tokens";
import { DeckSlideView } from "./DeckSlideView";
import { useDeckSourcePicker } from "./useDeckSourcePicker";

interface DeckSourcePreviewProps {
  path: string;
  fileName: string;
  slide: SearchSlide;
  workspace: string | null;
  onClose: () => void;
  onOpenDraft: () => void;
}

/** 搜索命中页的预览入口。新页草稿在同一工作区内跨搜索结果共享。 */
export function DeckSourcePreview({ path, fileName, slide, workspace, onClose, onOpenDraft }: DeckSourcePreviewProps) {
  const picker = useDeckSourcePicker(path, slide, workspace);
  const { source, png, warning, error, loading, notice, choices, retry } = picker;
  const pageNumber = source?.number ?? slide.number;
  const pageTitle = slide.title ? `第 ${pageNumber} 页 · ${slide.title}` : `第 ${pageNumber} 页`;
  const addLabel = picker.hasNativeText ? "带格式加入新页" : "加入当前新页";

  return (
    <section className="dc-preview" aria-label="旧幻灯片素材预览">
      <header className="dc-preview-header">
        <h2 className="dc-preview-title" title={fileName}>{fileName}</h2>
        <div className="dc-preview-actions">
          <button type="button" className="dc-button" onClick={onOpenDraft}>当前新页（{picker.newPageAssetCount}）</button>
          <button type="button" className="dc-icon-button" aria-label="关闭旧页预览" onClick={onClose}>
            <X size={iconSize.md} />
          </button>
        </div>
      </header>
      <div className="dc-preview-meta" title={path}>{pageTitle}</div>
      <div className="dc-preview-body">
        {loading && <div role="status"><StatusLine text={source ? "正在生成原页图像…" : "正在读取当前页…"} /></div>}
        {error && (
          <div role="alert">
            <StatusLine text={error} tone="error" />
            <button type="button" className="dc-link-button" onClick={retry}>重试预览</button>
          </div>
        )}
        {warning && (
          <div role="status">
            <StatusLine text={warning} tone="warning" />
            <button type="button" className="dc-link-button" onClick={retry}>重试预览</button>
          </div>
        )}
        {source && (
          <div className="dc-deck-slide">
            {picker.missingCount > 0 && (
              <div role="status">
                <StatusLine
                  text={`草稿中有 ${picker.missingCount} 个素材在此页已找不到。请重新选取，并在当前新页移除旧引用。`}
                  tone="warning"
                />
              </div>
            )}
            <div className="dc-row-actions is-start">
              <button
                type="button"
                className="dc-button is-primary"
                onClick={picker.addSelection}
                disabled={!picker.canAdd}
              >
                {picker.replacing ? `确认更新并${addLabel}` : addLabel}
                {picker.selectedCount > 0 && `（${picker.selectedCount}）`}
              </button>
              {choices.some(({ asset }) => asset.kind === "text") && (
                <button
                  type="button"
                  className="dc-button"
                  title="将文字内容加入草稿，导出时随单位模板排版"
                  onClick={picker.copyTextToMarkdown}
                  disabled={!picker.canCopyText}
                >
                  取文字到 Markdown
                </button>
              )}
            </div>
            {notice && <div role="status"><StatusLine text={notice} /></div>}
            <DeckSlideView pageTitle={pageTitle} png={png} choices={choices} onToggle={picker.toggle} />
          </div>
        )}
      </div>
    </section>
  );
}
