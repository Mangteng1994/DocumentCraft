/**
 * 应用外壳：顶部工具栏、左侧文件树/大纲、中间编辑区、右侧批注/Copilot 面板和状态栏。
 * 布局参照 VMark AppShell，去掉了标签页、终端、底部栏和多窗口。
 */

import { useEffect } from "react";
import {
  Bot,
  FileDown,
  FileText,
  FolderOpen,
  MessageSquare,
  Save,
  Settings,
  Workflow,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { MarkdownEditor } from "./editor/MarkdownEditor";
import { Sidebar } from "./sidebar/Sidebar";
import { CommentsPanel } from "./features/comments/CommentsPanel";
import { CopilotPanel } from "./features/CopilotPanel";
import { ExportDialog } from "./features/ExportDialog";
import { IllustrateDialog } from "./features/IllustrateDialog";
import { AISettingsDialog } from "./features/AISettingsDialog";
import { chooseFile, chooseWorkspace, fileName, saveDocument } from "./documentActions";
import { useAppStore, type DialogKind, type RightPanel } from "./store";
import { iconSize } from "./styles/tokens";

function ToolbarButton({
  label,
  icon,
  onClick,
  disabled = false,
  pressed,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`dc-toolbar-button${pressed ? " is-pressed" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function WelcomeView() {
  return (
    <div className="dc-welcome">
      <h1 className="dc-welcome-title">DocumentCraft</h1>
      <p className="dc-welcome-text">面向科研文档的 Markdown 阅读编辑器。打开工作区浏览文档，在编辑器中批注、整理，并按 Word 模板导出。</p>
      <div className="dc-row-actions">
        <button type="button" className="dc-button is-primary" onClick={() => void chooseWorkspace()}>
          <FolderOpen size={iconSize.md} />
          打开文件夹
        </button>
        <button type="button" className="dc-button" onClick={() => void chooseFile()}>
          <FileText size={iconSize.md} />
          打开 Markdown
        </button>
      </div>
    </div>
  );
}

function ActiveDialog({ dialog }: { dialog: DialogKind }) {
  if (dialog === "export") {
    return <ExportDialog />;
  }
  if (dialog === "illustrate") {
    return <IllustrateDialog />;
  }
  if (dialog === "ai") {
    return <AISettingsDialog />;
  }
  return null;
}

export function App() {
  const filePath = useAppStore((state) => state.filePath);
  const dirty = useAppStore((state) => state.dirty);
  const rightPanel = useAppStore((state) => state.rightPanel);
  const setRightPanel = useAppStore((state) => state.setRightPanel);
  const dialog = useAppStore((state) => state.dialog);
  const setDialog = useAppStore((state) => state.setDialog);
  const status = useAppStore((state) => state.status);
  const notes = useAppStore((state) => state.notes);

  const togglePanel = (panel: Exclude<RightPanel, null>) => {
    setRightPanel(rightPanel === panel ? null : panel);
  };

  // Ctrl+S 保存。
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveDocument();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // 关闭窗口前提示未保存的修改。
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      const { dirty: unsaved, filePath: path } = useAppStore.getState();
      if (!unsaved || !path) {
        return;
      }
      const discard = await ask(`「${fileName(path)}」有未保存的修改，仍要关闭吗？`, {
        title: "DocumentCraft",
        kind: "warning",
        okLabel: "不保存并关闭",
        cancelLabel: "返回编辑",
      });
      if (!discard) {
        event.preventDefault();
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const name = filePath ? fileName(filePath) : "";
    const title = name ? `${dirty ? "● " : ""}${name} · DocumentCraft` : "DocumentCraft";
    void getCurrentWindow().setTitle(title);
  }, [filePath, dirty]);

  const hasDocument = filePath !== null;

  return (
    <div className="dc-app">
      <header className="dc-toolbar">
        <ToolbarButton label="打开文件夹" icon={<FolderOpen size={iconSize.md} />} onClick={() => void chooseWorkspace()} />
        <ToolbarButton label="打开文件" icon={<FileText size={iconSize.md} />} onClick={() => void chooseFile()} />
        <ToolbarButton label="保存" icon={<Save size={iconSize.md} />} onClick={() => void saveDocument()} disabled={!hasDocument || !dirty} />
        <span className="dc-toolbar-separator" />
        <ToolbarButton label="导出 Word" icon={<FileDown size={iconSize.md} />} onClick={() => setDialog("export")} disabled={!hasDocument} />
        <ToolbarButton label="科研配图" icon={<Workflow size={iconSize.md} />} onClick={() => setDialog("illustrate")} disabled={!hasDocument} />
        <span className="dc-toolbar-spacer" />
        <ToolbarButton
          label={`批注${notes.length > 0 ? ` ${notes.length}` : ""}`}
          icon={<MessageSquare size={iconSize.md} />}
          onClick={() => togglePanel("comments")}
          pressed={rightPanel === "comments"}
        />
        <ToolbarButton label="Copilot" icon={<Bot size={iconSize.md} />} onClick={() => togglePanel("copilot")} pressed={rightPanel === "copilot"} />
        <ToolbarButton label="AI 设置" icon={<Settings size={iconSize.md} />} onClick={() => setDialog("ai")} />
      </header>

      <div className={`dc-workbench${rightPanel ? " has-panel" : ""}`}>
        <Sidebar />
        <main className="dc-main">
          {/* 编辑器常驻，避免切换文档时重建 ProseMirror 视图。 */}
          <div className={hasDocument ? "dc-editor-area" : "dc-editor-area is-hidden"}>
            <MarkdownEditor />
          </div>
          {!hasDocument && <WelcomeView />}
        </main>
        {rightPanel && (
          <aside className="dc-panel" aria-label={rightPanel === "comments" ? "批注" : "Copilot"}>
            <div className="dc-panel-header">
              <h2 className="dc-panel-title">{rightPanel === "comments" ? "批注" : "Copilot · 工作区整理"}</h2>
            </div>
            {rightPanel === "comments" ? <CommentsPanel /> : <CopilotPanel />}
          </aside>
        )}
      </div>

      <footer className="dc-statusbar">
        <span className="dc-statusbar-path" title={filePath ?? ""}>
          {filePath ?? "未打开文档"}
        </span>
        <span className="dc-statusbar-message">{dirty ? "未保存" : status}</span>
      </footer>

      <ActiveDialog dialog={dialog} />
    </div>
  );
}
