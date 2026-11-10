/**
 * 设置窗口，布局参照 Obsidian 设置：左侧分组导航，右侧为设置项列表。
 *
 * MD 转 Word 与科研流程图只从这里进入：各自的分页保存默认参数，并提供对当前文档执行的按钮。
 */

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { useSettings } from "../../settings/settingsStore";
import { useAppStore, type SettingsTab } from "../../store";
import { iconSize } from "../../styles/tokens";
import { AIConnectionSettings } from "./AIConnectionSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { CopilotSettings } from "./CopilotSettings";
import { FilesSettings } from "./FilesSettings";
import { FigureSettings } from "./FigureSettings";
import { HotkeySettings } from "./HotkeySettings";
import { WordExportSettings } from "./WordExportSettings";

const GROUPS: { title: string; tabs: { id: SettingsTab; label: string }[] }[] = [
  {
    title: "选项",
    tabs: [
      { id: "appearance", label: "外观" },
      { id: "files", label: "文件" },
      { id: "hotkeys", label: "快捷键" },
    ],
  },
  {
    title: "Copilot",
    tabs: [
      { id: "copilot", label: "Copilot" },
      { id: "ai", label: "AI 连接" },
    ],
  },
  {
    title: "文档工具",
    tabs: [
      { id: "word", label: "MD 转 Word" },
      { id: "figure", label: "科研流程图" },
    ],
  },
];

const TAB_CONTENT: Record<SettingsTab, () => ReactNode> = {
  appearance: () => <AppearanceSettings />,
  files: () => <FilesSettings />,
  hotkeys: () => <HotkeySettings />,
  copilot: () => <CopilotSettings />,
  ai: () => <AIConnectionSettings />,
  word: () => <WordExportSettings />,
  figure: () => <FigureSettings />,
};

export function SettingsModal({ tab }: { tab: SettingsTab }) {
  const setOverlay = useAppStore((state) => state.setOverlay);
  const openSettings = useAppStore((state) => state.openSettings);
  const error = useSettings((state) => state.error);
  const label = GROUPS.flatMap((group) => group.tabs).find((item) => item.id === tab)?.label ?? "";

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      // 快捷键录制框获得焦点时，Esc 由录制框处理。
      if (event.key === "Escape" && !(event.target as HTMLElement).closest("[data-hotkey-recorder]")) {
        setOverlay(null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setOverlay]);

  return (
    <div className="dc-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOverlay(null)}>
      <div className="dc-settings" role="dialog" aria-modal="true" aria-label="设置">
        <nav className="dc-settings-nav" aria-label="设置分类">
          {GROUPS.map((group) => (
            <div key={group.title} className="dc-settings-group">
              <div className="dc-settings-group-title">{group.title}</div>
              {group.tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`dc-settings-nav-item${item.id === tab ? " is-active" : ""}`}
                  aria-current={item.id === tab ? "page" : undefined}
                  onClick={() => openSettings(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <section className="dc-settings-content">
          <header className="dc-settings-header">
            <h2 className="dc-settings-title">{label}</h2>
            <button type="button" className="dc-icon-button" aria-label="关闭设置" onClick={() => setOverlay(null)}>
              <X size={iconSize.md} />
            </button>
          </header>
          {error && <p className="dc-status-line is-error">{error}</p>}
          <div className="dc-settings-body">{TAB_CONTENT[tab]()}</div>
        </section>
      </div>
    </div>
  );
}

/** 一行设置：左侧名称与说明，右侧控件。 */
export function SettingItem({ name, description, children }: { name: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="dc-setting-item">
      <div className="dc-setting-info">
        <div className="dc-setting-name">{name}</div>
        {description && <div className="dc-setting-description">{description}</div>}
      </div>
      {children && <div className="dc-setting-control">{children}</div>}
    </div>
  );
}

export function SettingHeading({ children }: { children: ReactNode }) {
  return <h3 className="dc-setting-heading">{children}</h3>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`dc-toggle${checked ? " is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="dc-toggle-knob" />
    </button>
  );
}
