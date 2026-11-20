/**
 * 按设置应用浅色或深色主题。选择「跟随系统」时监听系统配色变化。
 */

import { useEffect } from "react";
import { useSettings } from "./settingsStore";

const EDITOR_FONT_SIZE_VARIABLE = "--dc-editor-font-size";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function useTheme(): void {
  const mode = useSettings((state) => state.settings.appearance.theme);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia(DARK_QUERY);
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches);
      root.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    if (mode !== "system") {
      return;
    }
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
}

/**
 * 把编辑区排版设置（DC-071）写到根元素：宽度、页边距、行高、字体用 data 属性切换 tokens.css 里的令牌，
 * 字体大小是用户给的数值，写成样式变量。
 */
export function useEditorAppearance(): void {
  const editor = useSettings((state) => state.settings.editor);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.editorWidth = editor.width;
    root.dataset.editorMargin = editor.margin;
    root.dataset.editorLine = editor.lineHeight;
    root.dataset.editorFont = editor.fontFamily;
    root.style.setProperty(EDITOR_FONT_SIZE_VARIABLE, `${editor.fontSize}px`);
  }, [editor]);
}
