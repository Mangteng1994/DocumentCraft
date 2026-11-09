/**
 * 外观：主题（跟随系统 / 浅色 / 深色），配色为 Obsidian 默认主题。
 */

import { useSettings } from "../../settings/settingsStore";
import type { ThemeMode } from "../../settings/schema";
import { SettingItem } from "./SettingsModal";

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function AppearanceSettings() {
  const theme = useSettings((state) => state.settings.appearance.theme);
  const update = useSettings((state) => state.update);
  return (
    <SettingItem name="主题" description="配色采用 Obsidian 默认主题。跟随系统时随 Windows 的浅色或深色模式切换。">
      <select className="dc-input" value={theme} onChange={(event) => update("appearance", { theme: event.target.value as ThemeMode })}>
        {THEMES.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </SettingItem>
  );
}
