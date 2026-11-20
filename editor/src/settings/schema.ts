/**
 * 编辑器设置的结构与默认值。
 *
 * 设置保存在应用配置目录的 settings.json（见 src-tauri/src/settings.rs）。读取时与默认值逐项合并，
 * 旧版本缺少的字段自动补齐。AI 连接设置由 docflow 单独保存，不在这里。
 */

import { fileTypeColorDefaults } from "../styles/tokens";

export type ThemeMode = "system" | "light" | "dark";
export type TemplateMode = "auto" | "style" | "full";
export type FigureStyle = "mono" | "colored";
export type SendShortcut = "enter" | "shift-enter";
export type CopilotMode = "chat" | "vault";

/** 目录树排序依据：名称、修改时间、文件类型（扩展名）。文件夹始终排在文件之前。 */
export const SORT_KEYS = ["name", "modified", "type"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** 编辑区（DC-071）：页面宽度、左右页边距、行高、字体族的取值，对应 tokens.css 中的令牌。 */
export const EDITOR_WIDTHS = ["narrow", "standard", "wide", "full"] as const;
export const EDITOR_MARGINS = ["small", "medium", "large"] as const;
export const EDITOR_LINE_HEIGHTS = ["compact", "standard", "loose"] as const;
export const EDITOR_FONTS = ["sans", "serif"] as const;
export type EditorWidth = (typeof EDITOR_WIDTHS)[number];
export type EditorMargin = (typeof EDITOR_MARGINS)[number];
export type EditorLineHeight = (typeof EDITOR_LINE_HEIGHTS)[number];
export type EditorFont = (typeof EDITOR_FONTS)[number];

/** 编辑区字体大小（像素）的可调范围。 */
export const EDITOR_FONT_SIZE_MIN = 14;
export const EDITOR_FONT_SIZE_MAX = 22;
export const EDITOR_FONT_SIZE_DEFAULT = 16;

/** 五彩文档大纲的一条着色规则：扩展名（小写、带点，如 ".docx"）与 HEX 颜色（#RRGGBB）。 */
export interface FileColorRule {
  extensions: string[];
  color: string;
}

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
  { id: "closeTab", label: "关闭当前页签", scope: "global", defaultKey: "Ctrl+W" },
  { id: "nextTab", label: "下一个页签", scope: "global", defaultKey: "Ctrl+Tab" },
  { id: "previousTab", label: "上一个页签", scope: "global", defaultKey: "Ctrl+Shift+Tab" },
  { id: "searchWorkspace", label: "在工作区中搜索", scope: "global", defaultKey: "Ctrl+F" },
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
    /** 侧栏搜索的范围，见 SEARCH_MODES。 */
    searchMode: SearchMode;
    /** 目录树排序依据与方向（DC-071）。 */
    sortKey: SortKey;
    sortDescending: boolean;
  };
  /** 编辑区排版（DC-071）。 */
  editor: {
    fontSize: number;
    width: EditorWidth;
    margin: EditorMargin;
    lineHeight: EditorLineHeight;
    fontFamily: EditorFont;
  };
  hotkeys: Hotkeys;
  /** 五彩文档大纲（DC-068）：开启后目录树按扩展名给文件的图标和名称着色。 */
  colorfulOutline: {
    enabled: boolean;
    rules: FileColorRule[];
  };
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
    plannerModel: string;
    figureModel: string;
    reviewModel: string;
    visualReview: boolean;
  };
  layout: {
    /** 左侧栏与右侧栏宽度（像素），0 表示使用设计令牌中的默认宽度。 */
    sidebarWidth: number;
    panelWidth: number;
  };
  history: {
    /** 最近打开的工作区文件夹，最新的在前，最多 MAX_RECENT_WORKSPACES 个。 */
    recentWorkspaces: string[];
  };
  update: {
    /** 启动时与之后每 UPDATE_CHECK_INTERVAL_MS 向 GitHub Release 检查一次新版本。 */
    autoCheck: boolean;
    /** 发现新版本后在后台自动下载；安装始终由用户确认。 */
    autoDownload: boolean;
    /** 上一次检查的时间（毫秒时间戳，成功与失败都记录），0 表示从未检查。 */
    lastCheckedAt: number;
  };
}

/** 自动检查更新的间隔：6 小时。 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 搜索范围：所有（文件名 + 纯文本正文）、所有文件名、所有纯文本正文。值与 Rust 端 search_workspace 的 mode 一致。 */
export const SEARCH_MODES = ["all", "names", "text"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const MAX_RECENT_WORKSPACES = 10;

/** HEX 颜色只接受 #RRGGBB，便于 input[type=color] 直接使用。 */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 五彩文档大纲的默认规则，颜色取自设计令牌中的莫兰迪色。 */
export function defaultFileColorRules(): FileColorRule[] {
  return [
    { extensions: [".docx"], color: fileTypeColorDefaults.word },
    { extensions: [".xlsx"], color: fileTypeColorDefaults.excel },
    { extensions: [".pdf"], color: fileTypeColorDefaults.pdf },
    { extensions: [".pptx", ".ppt"], color: fileTypeColorDefaults.powerpoint },
  ];
}

/**
 * 把用户输入的扩展名文本拆成规则使用的列表。
 *
 * 支持中英文逗号、分号和空白分隔，自动补上前导点并转小写，去掉重复项。
 */
export function parseExtensions(text: string): string[] {
  const result: string[] = [];
  for (const part of text.split(/[,，;；\s]+/)) {
    const trimmed = part.trim().toLowerCase();
    if (!trimmed || trimmed === ".") {
      continue;
    }
    const extension = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (!result.includes(extension)) {
      result.push(extension);
    }
  }
  return result;
}

function defaultHotkeys(): Hotkeys {
  const entries = ACTIONS.map((action) => [action.id, action.defaultKey]);
  return Object.fromEntries(entries) as Hotkeys;
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: { theme: "system" },
  files: { showAllFiles: false, searchMode: "all", sortKey: "name", sortDescending: false },
  editor: { fontSize: EDITOR_FONT_SIZE_DEFAULT, width: "standard", margin: "medium", lineHeight: "standard", fontFamily: "sans" },
  hotkeys: defaultHotkeys(),
  colorfulOutline: { enabled: false, rules: defaultFileColorRules() },
  copilot: {
    folder: "copilot",
    autoAttachActiveNote: true,
    autosave: true,
    sendShortcut: "enter",
    systemPrompt: "",
    mode: "chat",
  },
  wordExport: { template: "", mode: "auto", includeNotes: true },
  figure: { style: "colored", plannerModel: "", figureModel: "", reviewModel: "", visualReview: false },
  layout: { sidebarWidth: 0, panelWidth: 0 },
  history: { recentWorkspaces: [] },
  update: { autoCheck: true, autoDownload: true, lastCheckedAt: 0 },
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

/**
 * 读取保存的五彩文档大纲设置。
 *
 * 规则列表不能用 mergeSection 按类型合并（数组的 typeof 也是 object），这里逐条校验：
 * 颜色不是 #RRGGBB 或扩展名为空的规则丢弃。从未保存过规则时使用默认规则；
 * 用户主动删光规则时保存的是空数组，保持为空。
 */
function normalizeColorfulOutline(saved: unknown): Settings["colorfulOutline"] {
  if (!isRecord(saved)) {
    return { enabled: false, rules: defaultFileColorRules() };
  }
  const enabled = typeof saved.enabled === "boolean" ? saved.enabled : false;
  if (!Array.isArray(saved.rules)) {
    return { enabled, rules: defaultFileColorRules() };
  }
  const rules: FileColorRule[] = [];
  for (const item of saved.rules) {
    if (!isRecord(item) || typeof item.color !== "string" || !HEX_COLOR.test(item.color) || !Array.isArray(item.extensions)) {
      continue;
    }
    const extensionText = item.extensions.filter((value): value is string => typeof value === "string").join(",");
    const extensions = parseExtensions(extensionText);
    if (extensions.length > 0) {
      rules.push({ extensions, color: item.color.toUpperCase() });
    }
  }
  return { enabled, rules };
}

/** 0.2.4 的搜索默认快捷键。设置文件会整体保存快捷键，旧默认值需要迁移到 Ctrl+F。 */
const LEGACY_SEARCH_HOTKEY = "Ctrl+Shift+F";

export function normalizeSettings(saved: unknown): Settings {
  const root = isRecord(saved) ? saved : {};
  const hotkeys = mergeSection(DEFAULT_SETTINGS.hotkeys, root.hotkeys);
  const files = mergeSection(DEFAULT_SETTINGS.files, root.files);
  // 设置文件被手改成未知的搜索范围时回退到默认值，避免后端报「未知的搜索范围」。
  if (!SEARCH_MODES.includes(files.searchMode)) {
    files.searchMode = DEFAULT_SETTINGS.files.searchMode;
  }
  if (!SORT_KEYS.includes(files.sortKey)) {
    files.sortKey = DEFAULT_SETTINGS.files.sortKey;
  }
  const editor = mergeSection(DEFAULT_SETTINGS.editor, root.editor);
  // 设置文件被手改成范围外的取值时回退默认值，避免写出无效的样式变量。
  if (!EDITOR_WIDTHS.includes(editor.width)) {
    editor.width = DEFAULT_SETTINGS.editor.width;
  }
  if (!EDITOR_MARGINS.includes(editor.margin)) {
    editor.margin = DEFAULT_SETTINGS.editor.margin;
  }
  if (!EDITOR_LINE_HEIGHTS.includes(editor.lineHeight)) {
    editor.lineHeight = DEFAULT_SETTINGS.editor.lineHeight;
  }
  if (!EDITOR_FONTS.includes(editor.fontFamily)) {
    editor.fontFamily = DEFAULT_SETTINGS.editor.fontFamily;
  }
  const sizeValid = Number.isFinite(editor.fontSize);
  const sizeClamped = Math.min(Math.max(Math.round(editor.fontSize), EDITOR_FONT_SIZE_MIN), EDITOR_FONT_SIZE_MAX);
  editor.fontSize = sizeValid ? sizeClamped : EDITOR_FONT_SIZE_DEFAULT;
  if (hotkeys.searchWorkspace === LEGACY_SEARCH_HOTKEY) {
    hotkeys.searchWorkspace = DEFAULT_SETTINGS.hotkeys.searchWorkspace;
  }
  return {
    appearance: mergeSection(DEFAULT_SETTINGS.appearance, root.appearance),
    files,
    editor,
    hotkeys,
    colorfulOutline: normalizeColorfulOutline(root.colorfulOutline),
    copilot: mergeSection(DEFAULT_SETTINGS.copilot, root.copilot),
    wordExport: mergeSection(DEFAULT_SETTINGS.wordExport, root.wordExport),
    figure: mergeSection(DEFAULT_SETTINGS.figure, root.figure),
    layout: mergeSection(DEFAULT_SETTINGS.layout, root.layout),
    history: { recentWorkspaces: normalizeRecentWorkspaces(root.history) },
    update: mergeSection(DEFAULT_SETTINGS.update, root.update),
  };
}
