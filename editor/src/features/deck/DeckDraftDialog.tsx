import { useState } from "react";
import { Ellipsis } from "lucide-react";
import { Dialog, Field, StatusLine } from "../../components/Dialog";
import { PopupMenu } from "../../components/PopupMenu";
import { fileName } from "../../paths";
import { iconSize } from "../../styles/tokens";
import { assetKey, type DeckAssetReference, useDeckDraft } from "./deckDraft";
import { DECK_ASSET_LABELS } from "./deckSource";
import { useDeckExport } from "./useDeckExport";

interface DeckDraftDialogProps {
  workspace: string | null;
  onClose: () => void;
  onSearch: () => void;
  onShowSource: (asset: DeckAssetReference) => void;
}

interface AssetMenu {
  x: number;
  y: number;
  asset: DeckAssetReference;
}

/** 显示同一张新页的 Markdown 内容与素材引用。 */
export function DeckDraftDialog({ workspace, onClose, onSearch, onShowSource }: DeckDraftDialogProps) {
  const { draft, editDraft, removeAsset } = useDeckDraft(workspace);
  const deckExport = useDeckExport(workspace, draft, (template) => {
    if (workspace) {
      editDraft(workspace, { template });
    }
  });
  const [menu, setMenu] = useState<AssetMenu | null>(null);
  const close = () => {
    if (menu) {
      setMenu(null);
    } else {
      onClose();
    }
  };

  if (!workspace) {
    return (
      <Dialog title="组汇报" onClose={onClose}>
        <StatusLine text="打开一个工作区后，可以搜索旧 PPT 并组一张新页。" />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="组汇报 · 当前新页"
      onClose={close}
      busy={deckExport.busy}
      footer={(
        <>
          <button type="button" className="dc-button" onClick={onSearch} disabled={deckExport.busy}>搜索旧 PPT 素材</button>
          <button type="button" className="dc-button is-primary" onClick={() => void deckExport.start()} disabled={!deckExport.ready}>
            {deckExport.busy ? "导出中…" : "导出 PPTX"}
          </button>
        </>
      )}
    >
      <Field label="本页标题">
        <input
          type="text"
          className="dc-input"
          value={draft.title}
          disabled={deckExport.busy}
          onChange={(event) => editDraft(workspace, { title: event.target.value })}
        />
      </Field>
      <Field label="本页内容（Markdown）">
        <textarea
          className="dc-input dc-textarea"
          value={draft.markdown}
          disabled={deckExport.busy}
          onChange={(event) => editDraft(workspace, { markdown: event.target.value })}
        />
      </Field>
      <Field label="单位 PPTX 模板" hint="沿用单位母版与版式。缺少占位符时，在版式内自动排版。">
        <div className="dc-path-row">
          <input
            className="dc-input"
            value={deckExport.template}
            title={deckExport.template}
            placeholder="尚未选择模板"
            aria-label="单位 PPTX 模板路径"
            readOnly
          />
          <button type="button" className="dc-button" onClick={() => void deckExport.chooseTemplate()} disabled={deckExport.busy}>选择模板</button>
        </div>
      </Field>
      {deckExport.progress && <div role="status"><StatusLine text={deckExport.progress} /></div>}
      {deckExport.error && <div role="alert"><StatusLine text={deckExport.error} tone="error" /></div>}
      {deckExport.result && (
        <div role="status">
          <StatusLine text={`已保存 ${deckExport.result.output}（版式：${deckExport.result.layout}，引擎：${deckExport.result.engine}）`} />
          {deckExport.result.warnings.map((warning) => <StatusLine key={warning} text={warning} tone="warning" />)}
          <button type="button" className="dc-link-button" onClick={() => void deckExport.showOutput()}>打开所在文件夹</button>
        </div>
      )}
      {draft.assets.length === 0 ? (
        <StatusLine text="从搜索命中的旧页里点选素材，加入这张新页。" />
      ) : (
        <ul className="dc-preview-blocks" aria-label="已加入的素材">
          {draft.assets.map((asset) => (
            <li key={assetKey(asset)} className="dc-preview-block">
              <div className="dc-preview-summary">
                <span>{DECK_ASSET_LABELS[asset.kind]} · {asset.name}</span>
                <button
                  type="button"
                  className="dc-icon-button"
                  aria-label={`${asset.name}的操作`}
                  aria-haspopup="menu"
                  disabled={deckExport.busy}
                  aria-expanded={menu !== null && assetKey(menu.asset) === assetKey(asset)}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: bounds.left, y: bounds.bottom, asset });
                  }}
                >
                  <Ellipsis size={iconSize.sm} />
                </button>
              </div>
              <p className="dc-preview-context" title={asset.path}>
                {fileName(asset.path)} · 第 {asset.pageNumber} 页{asset.pageTitle ? ` · ${asset.pageTitle}` : ""}
              </p>
              {asset.summary && <p className="dc-preview-context">{asset.summary}</p>}
            </li>
          ))}
        </ul>
      )}
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={[
            { label: "查看来源页", run: () => onShowSource(menu.asset) },
            { label: "移除素材", run: () => removeAsset(workspace, assetKey(menu.asset)) },
          ]}
        />
      )}
    </Dialog>
  );
}
