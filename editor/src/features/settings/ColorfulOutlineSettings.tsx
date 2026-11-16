/**
 * 五彩文档大纲（DC-067）：目录树按扩展名给文件着色。
 *
 * 设置页只有一个复选框；勾选后弹出配置窗口，之后可用「配置」按钮再次打开。
 * 配置窗口编辑的是草稿，点「保存」才写入设置，「取消」或 Esc 放弃修改。
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2 } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { defaultFileColorRules, HEX_COLOR, parseExtensions, type FileColorRule } from "../../settings/schema";
import { useSettings } from "../../settings/settingsStore";
import { iconSize } from "../../styles/tokens";
import { SettingItem } from "./SettingsModal";

/** 配置窗口中的一行草稿：扩展名与 HEX 都保留用户原样输入，保存时再校验。 */
interface RuleDraft {
  key: number;
  extensionsText: string;
  colorText: string;
}

let nextDraftKey = 0;

function toDraft(rule: FileColorRule): RuleDraft {
  nextDraftKey += 1;
  return { key: nextDraftKey, extensionsText: rule.extensions.join(", "), colorText: rule.color };
}

/** 新增规则默认使用第一条默认规则的颜色，避免出现非法的空颜色。 */
function emptyDraft(): RuleDraft {
  const fallbackColor = defaultFileColorRules()[0].color;
  nextDraftKey += 1;
  return { key: nextDraftKey, extensionsText: "", colorText: fallbackColor };
}

/** HEX 输入允许省略 #，保存时补齐并转大写。 */
function normalizeHex(text: string): string {
  const trimmed = text.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return withHash.toUpperCase();
}

function ColorfulOutlineDialog({ onClose }: { onClose: () => void }) {
  const savedRules = useSettings((state) => state.settings.colorfulOutline.rules);
  const update = useSettings((state) => state.update);
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => savedRules.map(toDraft));
  const [error, setError] = useState("");

  const changeDraft = (key: number, patch: Partial<RuleDraft>) => {
    setDrafts((previous) => previous.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  const removeDraft = (key: number) => {
    setDrafts((previous) => previous.filter((draft) => draft.key !== key));
  };

  const addDraft = () => {
    setDrafts((previous) => [...previous, emptyDraft()]);
  };

  const resetDrafts = () => {
    setDrafts(defaultFileColorRules().map(toDraft));
    setError("");
  };

  const save = () => {
    const rules: FileColorRule[] = [];
    for (const [index, draft] of drafts.entries()) {
      const extensions = parseExtensions(draft.extensionsText);
      const color = normalizeHex(draft.colorText);
      if (extensions.length === 0) {
        setError(`第 ${index + 1} 条规则缺少扩展名。`);
        return;
      }
      if (!HEX_COLOR.test(color)) {
        setError(`第 ${index + 1} 条规则的颜色「${draft.colorText}」不是 #RRGGBB 格式的 HEX。`);
        return;
      }
      rules.push({ extensions, color });
    }
    update("colorfulOutline", { rules });
    onClose();
  };

  const footer = (
    <>
      <button type="button" className="dc-button" onClick={resetDrafts}>
        恢复默认
      </button>
      <button type="button" className="dc-button" onClick={onClose}>
        取消
      </button>
      <button type="button" className="dc-button is-primary" onClick={save}>
        保存
      </button>
    </>
  );

  // 渲染到 body 并加标记：设置窗口据此在 Esc 时只关闭这个配置窗口，而不是连同设置窗口一起关闭。
  return createPortal(
    <div data-settings-subdialog>
      <Dialog title="五彩文档大纲配置" onClose={onClose} footer={footer}>
        <p className="dc-dialog-text">
          每条规则把若干扩展名映射到一种颜色，多个扩展名用逗号分隔。颜色用 HEX（#RRGGBB）表示，可直接输入或点色块选取。
        </p>
        <div className="dc-color-rules">
          {drafts.map((draft) => {
            const hex = normalizeHex(draft.colorText);
            const hexValid = HEX_COLOR.test(hex);
            // input[type=color] 只接受合法的 #rrggbb；HEX 还没输完时色块暂用默认蓝。
            const swatchHex = hexValid ? hex : defaultFileColorRules()[0].color;
            const swatchValue = swatchHex.toLowerCase();
            return (
              <div key={draft.key} className="dc-color-rule">
                <input
                  type="color"
                  className="dc-color-swatch"
                  aria-label="选取颜色"
                  value={swatchValue}
                  onChange={(event) => changeDraft(draft.key, { colorText: event.target.value.toUpperCase() })}
                />
                <input
                  className={`dc-input${hexValid ? "" : " is-invalid"}`}
                  aria-label="HEX 颜色"
                  value={draft.colorText}
                  placeholder="#RRGGBB"
                  onChange={(event) => changeDraft(draft.key, { colorText: event.target.value })}
                />
                <input
                  className="dc-input"
                  aria-label="扩展名"
                  value={draft.extensionsText}
                  placeholder=".pptx, .ppt"
                  style={hexValid ? ({ color: hex } as React.CSSProperties) : undefined}
                  onChange={(event) => changeDraft(draft.key, { extensionsText: event.target.value })}
                />
                <button type="button" className="dc-icon-button" aria-label="删除规则" title="删除规则" onClick={() => removeDraft(draft.key)}>
                  <Trash2 size={iconSize.sm} />
                </button>
              </div>
            );
          })}
          {drafts.length === 0 && <p className="dc-setting-note">没有规则，所有文件保持默认颜色。</p>}
        </div>
        <div>
          <button type="button" className="dc-button" onClick={addDraft}>
            <Plus size={iconSize.sm} />
            添加规则
          </button>
        </div>
        {error && <p className="dc-status-line is-error">{error}</p>}
      </Dialog>
    </div>,
    document.body,
  );
}

export function ColorfulOutlineSettings() {
  const enabled = useSettings((state) => state.settings.colorfulOutline.enabled);
  const update = useSettings((state) => state.update);
  const [configOpen, setConfigOpen] = useState(false);

  const handleCheck = (checked: boolean) => {
    update("colorfulOutline", { enabled: checked });
    // 勾选时立即弹出配置，取消勾选只关闭着色、保留已有规则。
    setConfigOpen(checked);
  };

  return (
    <>
      <SettingItem
        name="五彩文档大纲"
        description="勾选后目录树按扩展名给文件的图标和名称着色，默认 .docx 蓝、.xlsx 绿、.pdf 红、.pptx 与 .ppt 橙（莫兰迪色）。非 Markdown 文件需开启「显示所有文件」才会出现在目录树中。"
      >
        {enabled && (
          <button type="button" className="dc-button" onClick={() => setConfigOpen(true)}>
            配置
          </button>
        )}
        <label className="dc-check">
          <input type="checkbox" checked={enabled} onChange={(event) => handleCheck(event.target.checked)} />
          启用
        </label>
      </SettingItem>
      {configOpen && <ColorfulOutlineDialog onClose={() => setConfigOpen(false)} />}
    </>
  );
}
