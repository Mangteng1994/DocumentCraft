/**
 * 编辑器设置的结构与默认值。
 *
 * 设置保存在应用配置目录的 settings.json（见 src-tauri/src/settings.rs）。读取时与默认值逐项合并，
 * 旧版本缺少的字段自动补齐。AI 连接设置由 docflow 单独保存，不在这里。
 */

export type ThemeMode = "system" | "light" | "dark";
export type TemplateMode = "auto" | "style" | "full";
export type FigureStyle = "mono" | "colored";
export type SendShortcut = "enter" | "shift-enter";
export type CopilotMode = "chat" | "vault";

/** 可绑定快捷键的操作。scope 为 editor 的操作只在编辑区获得焦点时生效。 */
export const ACTIONS = [
  { id: "heading1", label: "1 级标题", scope: "editor", defaultKey: "Ctrl+1" },
  { id: "heading2", label: "2 级标题", scope: "editor", defaultKey: "Ctrl+2" },
  { id: "heading3", label: "3 级标题", scope: "editor", defaultKey: "Ctrl+3" },
  { id: "heading4", label: "4 级标题", scope: "editor", defaultKey: "Ctrl+4" },
  { id: "heading5", label: "5 级标题", scope: "editor", defaultKey: "Ctrl+5" },
  { id: "heading6", label: "6 级标题", scope: "editor", defaultKey: "Ctrl+6" },
  { id: "paragraph", label: "正文段落", scope: "editor", defaultKey: "Ctrl+0" },
  { id: "insertTable", label: "插入表格", scope: "editor", defaultKey: "Ctrl+T" },
  { id: "save", label: "保存", scope: "global", defaultKey: "Ctrl+S" },
  { id: "openSettings", label: "打开设置", scope: "global", defaultKey: "Ctrl+," },
  { id: "toggleCopilot", label: "打开或关闭 Copilot", scope: "global", defaultKey: "Ctrl+Shift+L" },
  { id: "quickAsk", label: "Copilot：Quick Ask", scope: "global", defaultKey: "Ctrl+Shift+K" },
  { id: "addSelectionToChat", label: "Copilot：添加选区到对话", scope: "global", defaultKey: "" },
] as const;

export type ActionId = (typeof ACTIONS)[number]["id"];
export type Hotkeys = Record<ActionId, string>;

export interface Settings {
  appearance: {
    theme: ThemeMode;
  };
  files: {
    /** 目录树除 Markdown 外也列出其他文件，并保留空文件夹。 */
    showAllFiles: boolean;
  };
  hotkeys: Hotkeys;
  copilot: {
    /** 工作区内的 Copilot 文件夹，对话记录和命令分别存于其下的 copilot-conversations/、copilot-custom-prompts/。 */
    folder: string;
    autoAttachActiveNote: boolean;
    autosave: boolean;
    sendShortcut: SendShortcut;
    systemPrompt: string;
    mode: CopilotMode;
  };
  wordExport: {
    template: string;
    mode: TemplateMode;
    includeNotes: boolean;
  };
  figure: {
    style: FigureStyle;
  };
  history: {
    /** 最近打开的工作区文件夹，最新的在前，最多 MAX_RECENT_WORKSPACES 个。 */
    recentWorkspaces: string[];
  };
}

export const MAX_RECENT_WORKSPACES = 10;

function defaultHotkeys(): Hotkeys {
  const entries = ACTIONS.map((action) => [action.id, action.defaultKey]);
  return Object.fromEntries(entries) as Hotkeys;
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: "system" },
  files: { showAllFiles: false },
  hotkeys: defaultHotkeys(),
  copilot: {
    folder: "copilot",
    autoAttachActiveNote: true,
    autosave: true,
    sendShortcut: "enter",
    systemPrompt: "",
    mode: "chat",
  },
  wordExport: { template: "", mode: "auto", includeNotes: true },
  figure: { style: "mono" },
  history: { recentWorkspaces: [] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 用默认值补齐读取到的设置，类型不符的字段回退到默认值。 */
function mergeSection<T extends object>(defaults: T, saved: unknown): T {
  if (!isRecord(saved)) {
    return { ...defaults };
  }
  const result = { ...defaults } as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = saved[key];
    if (typeof value === typeof fallback) {
      result[key] = value;
    }
  }
  return result as T;
}

/** 只保留字符串路径，按不区分大小写去重并截断。 */
function normalizeRecentWorkspaces(saved: unknown): string[] {
  if (!isRecord(saved) || !Array.isArray(saved.recentWorkspaces)) {
    return [];
  }
  const result: string[] = [];
  for (const item of saved.recentWorkspaces) {
    if (typeof item !== "string" || !item.trim()) {
      continue;
    }
    const duplicate = result.some((existing) => existing.toLowerCase() === item.toLowerCase());
    if (!duplicate) {
      result.push(item);
    }
  }
  return result.slice(0, MAX_RECENT_WORKSPACES);
}

export function normalizeSettings(saved: unknown): Settings {
  const root = isRecord(saved) ? saved : {};
  return {
    appearance: mergeSection(DEFAULT_SETTINGS.appearance, root.appearance),
    files: mergeSection(DEFAULT_SETTINGS.files, root.files),
    hotkeys: mergeSection(DEFAULT_SETTINGS.hotkeys, root.hotkeys),
    copilot: mergeSection(DEFAULT_SETTINGS.copilot, root.copilot),
    wordExport: mergeSection(DEFAULT_SETTINGS.wordExport, root.wordExport),
    figure: mergeSection(DEFAULT_SETTINGS.figure, root.figure),
    history: { recentWorkspaces: normalizeRecentWorkspaces(root.history) },
  };
}
