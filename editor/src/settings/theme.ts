/**
 * 按设置应用浅色或深色主题。选择「跟随系统」时监听系统配色变化。
 */

import { useEffect } from "react";
import { useSettings } from "./settingsStore";

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
