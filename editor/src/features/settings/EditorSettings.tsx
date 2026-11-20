/**
 * 编辑器：Markdown 编辑区的字体大小、页面宽度、页边距、行高和字体（DC-071）。
 * 修改后立即生效，数值与取值范围见 settings/schema.ts。
 */

import { useSettings } from "../../settings/settingsStore";
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  type EditorFont,
  type EditorLineHeight,
  type EditorMargin,
  type EditorWidth,
} from "../../settings/schema";
import { SettingItem } from "./SettingsModal";

const WIDTHS: { value: EditorWidth; label: string }[] = [
  { value: "narrow", label: "窄" },
  { value: "standard", label: "标准" },
  { value: "wide", label: "宽" },
  { value: "full", label: "铺满" },
];

const MARGINS: { value: EditorMargin; label: string }[] = [
  { value: "small", label: "小" },
  { value: "medium", label: "中" },
  { value: "large", label: "大" },
];

const LINE_HEIGHTS: { value: EditorLineHeight; label: string }[] = [
  { value: "compact", label: "紧凑" },
  { value: "standard", label: "标准" },
  { value: "loose", label: "宽松" },
];

const FONTS: { value: EditorFont; label: string }[] = [
  { value: "sans", label: "无衬线" },
  { value: "serif", label: "衬线" },
];

/** 下拉框：选项文字与取值一一对应。 */
function OptionSelect<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <select className="dc-input" value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
}

export function EditorSettings() {
  const editor = useSettings((state) => state.settings.editor);
  const update = useSettings((state) => state.update);

  const handleFontSize = (text: string) => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const clamped = Math.min(Math.max(Math.round(parsed), EDITOR_FONT_SIZE_MIN), EDITOR_FONT_SIZE_MAX);
    update("editor", { fontSize: clamped });
  };

  return (
    <>
      <SettingItem name="字体大小" description={`正文字号，${EDITOR_FONT_SIZE_MIN}–${EDITOR_FONT_SIZE_MAX} 像素；标题按比例随之放大。`}>
        <input
          type="range"
          min={EDITOR_FONT_SIZE_MIN}
          max={EDITOR_FONT_SIZE_MAX}
          step={1}
          value={editor.fontSize}
          aria-label="字体大小"
          onChange={(event) => handleFontSize(event.target.value)}
        />
        <span>{editor.fontSize}</span>
      </SettingItem>
      <SettingItem name="页面宽度" description="正文区的最大宽度。窗口较宽时「铺满」会占满编辑区，只保留页边距。">
        <OptionSelect value={editor.width} options={WIDTHS} onChange={(width) => update("editor", { width })} />
      </SettingItem>
      <SettingItem name="页边距" description="正文左右两侧的留白。左侧需要容纳标题级别标记（H1～H6）。">
        <OptionSelect value={editor.margin} options={MARGINS} onChange={(margin) => update("editor", { margin })} />
      </SettingItem>
      <SettingItem name="行高" description="正文行间距。">
        <OptionSelect value={editor.lineHeight} options={LINE_HEIGHTS} onChange={(lineHeight) => update("editor", { lineHeight })} />
      </SettingItem>
      <SettingItem name="字体" description="正文字体。衬线适合长文阅读，缺少对应字体时系统自动回退。">
        <OptionSelect value={editor.fontFamily} options={FONTS} onChange={(fontFamily) => update("editor", { fontFamily })} />
      </SettingItem>
    </>
  );
}
