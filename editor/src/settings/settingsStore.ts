/**
 * 设置状态与持久化。修改后延迟写盘，连续调整快捷键时不逐键写文件。
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./schema";

const SAVE_DELAY_MS = 300;

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  /** 按分区合并修改，例如 update("copilot", { autosave: false })。 */
  update: <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>) => void;
  replaceSection: <K extends keyof Settings>(section: K, value: Settings[K]) => void;
}

let saveTimer: number | undefined;

function scheduleSave(settings: Settings, onError: (message: string) => void): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const content = JSON.stringify(settings, null, 2);
    invoke("save_settings", { content }).catch((error) => onError(String(error)));
  }, SAVE_DELAY_MS);
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  error: "",

  load: async () => {
    try {
      const text = await invoke<string>("load_settings");
      const settings = normalizeSettings(JSON.parse(text));
      set({ settings, loaded: true, error: "" });
    } catch (error) {
      set({ loaded: true, error: `设置读取失败，已使用默认设置：${String(error)}` });
    }
  },

  update: (section, patch) => {
    const current = get().settings;
    const settings = { ...current, [section]: { ...current[section], ...patch } };
    set({ settings });
    scheduleSave(settings, (message) => set({ error: message }));
  },

  replaceSection: (section, value) => {
    const settings = { ...get().settings, [section]: value };
    set({ settings });
    scheduleSave(settings, (message) => set({ error: message }));
  },
}));

export function getSettings(): Settings {
  return useSettings.getState().settings;
}
