/**
 * 应用外壳，布局参照 Obsidian：
 * 左侧 Ribbon（打开文件夹、打开文件、Copilot、批注、压缩文档媒体，底部为设置）、左侧栏（文件 / 大纲 / 搜索）、
 * 中间编辑区（顶部文档页签）、右侧栏（Copilot / 批注）和状态栏（左侧为工作区切换）。左右侧栏可拖动调宽。
 * MD 转 Word 与科研流程图从「设置」进入，不在主界面放置按钮。
 */

import { useEffect, type ReactNode } from "react";
import { Bot, FileText, FolderOpen, MessageSquare, Minimize2, Settings, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { MarkdownEditor } from "./editor/MarkdownEditor";
import { EditorContextMenu } from "./editor/EditorContextMenu";
import { ImagePathPopover } from "./editor/ImagePathPopover";
import { InsertTablePicker } from "./editor/InsertTablePicker";
import { Sidebar } from "./sidebar/Sidebar";
import { CommentsPanel } from "./features/comments/CommentsPanel";
import { CopilotView } from "./features/copilot/CopilotView";
import { QuickAsk } from "./features/copilot/QuickAsk";
import { useCopilot } from "./features/copilot/copilotStore";
import { toggleCopilot } from "./features/copilot/actions";
import { SettingsModal } from "./features/settings/SettingsModal";
import { CompressDialog } from "./features/compress/CompressDialog";
import { useCompress } from "./features/compress/compressStore";
import { isFigureActive, useFigureJob } from "./features/figures/figureStore";
import { SearchPreview } from "./features/preview/SearchPreview";
import { FileProperties } from "./sidebar/FileProperties";
import { DocumentTabs } from "./components/DocumentTabs";
import { PaneResizer, paneWidthStyle } from "./components/PaneResizer";
import { RecentWorkspaces } from "./components/RecentWorkspaces";
import { listenSearchIndex } from "./sidebar/searchIndex";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { WordCountStatus } from "./components/WordCountStatus";
import { UpdateBadge } from "./features/updater/UpdateBadge";
import { useAutoUpdate } from "./features/updater/useAutoUpdate";
import { chooseFile, chooseWorkspace } from "./documentActions";
import { fileName } from "./paths";
import { useSettings } from "./settings/settingsStore";
import { useEditorAppearance, useTheme } from "./settings/theme";
import { useHotkeys } from "./settings/useHotkeys";
import { useAppStore, type Overlay } from "./store";
import { iconSize, iconStroke } from "./styles/tokens";

function RibbonButton({ label, icon, onClick, pressed }: { label: string; icon: ReactNode; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" className={`dc-ribbon-button${pressed ? " is-pressed" : ""}`} onClick={onClick} aria-pressed={pressed} aria-label={label} title={label}>
      {icon}
    </button>
  );
}

function WelcomeView() {
  return (
    <div className="dc-welcome">
      <h1 className="dc-welcome-title">DocumentCraft</h1>
      <p className="dc-welcome-text">面向科研文档的 Markdown 阅读编辑器。打开工作区浏览文档，在编辑器中批注、与 Copilot 整理，并在设置中按 Word 模板导出。</p>
      <div className="dc-welcome-actions">
        <button type="button" className="dc-link-button is-large" onClick={() => void chooseWorkspace()}>
          打开文件夹
        </button>
        <button type="button" className="dc-link-button is-large" onClick={() => void chooseFile()}>
          打开 Markdown 文件
        </button>
      </div>
      <RecentWorkspaces />
    </div>
  );
}

function ActiveOverlay({ overlay }: { overlay: Overlay }) {
  if (!overlay) {
    return null;
  }
  if (overlay.kind === "settings") {
    return <SettingsModal tab={overlay.tab} />;
  }
  if (overlay.kind === "properties") {
    return <FileProperties path={overlay.path} />;
  }
  if (overlay.kind === "insertTable") {
    return <InsertTablePicker />;
  }
  if (overlay.kind === "compress") {
    return <CompressDialog />;
  }
  return <QuickAsk commandName={overlay.commandName} />;
}

export function App() {
  const filePath = useAppStore((state) => state.filePath);
  const dirty = useAppStore((state) => state.dirty);
  const workspace = useAppStore((state) => state.workspace);
  const rightPanel = useAppStore((state) => state.rightPanel);
  const setRightPanel = useAppStore((state) => state.setRightPanel);
  const overlay = useAppStore((state) => state.overlay);
  const preview = useAppStore((state) => state.preview);
  const openSettings = useAppStore((state) => state.openSettings);
  const setOverlay = useAppStore((state) => state.setOverlay);
  const compressPhase = useCompress((state) => state.phase);
  const compressOverall = useCompress((state) => state.overall);
  const figurePhase = useFigureJob((state) => state.phase);
  const figureProgress = useFigureJob((state) => state.progress);
  const status = useAppStore((state) => state.status);
  const notes = useAppStore((state) => state.notes);
  const loadSettings = useSettings((state) => state.load);
  const copilotFolder = useSettings((state) => state.settings.copilot.folder);
  const reloadCommands = useCopilot((state) => state.reloadCommands);
  const layout = useSettings((state) => state.settings.layout);

  useTheme();
  useEditorAppearance();
  useHotkeys();
  useAutoUpdate();

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // 右键菜单与 / 菜单都需要命令列表，工作区或 Copilot 文件夹变化时重新读取。
  useEffect(() => {
    void reloadCommands();
  }, [workspace, copilotFolder, reloadCommands]);

  // 文档正文索引的进度来自后端事件，整个运行期间监听。
  useEffect(() => listenSearchIndex(), []);

  // 关闭窗口前检查所有页签的未保存修改。
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      if (useAppStore.getState().imageRenameRunning) {
        event.preventDefault();
        useAppStore.getState().setStatus("图片正在改名并更新引用，请完成后再关闭窗口。");
        return;
      }
      const unsaved = useAppStore.getState().tabs.filter((tab) => tab.dirty);
      if (unsaved.length === 0) {
        return;
      }
      const names = unsaved.map((tab) => `「${fileName(tab.path)}」`).join("、");
      const discard = await ask(`${names}有未保存的修改，仍要关闭吗？`, {
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

  const figureRunning = isFigureActive(figurePhase);
  // 规划阶段是一次 sidecar 请求，没有进度事件，只显示阶段；排版阶段显示已完成/总数。
  let figureLabel = "科研配图进行中";
  if (figurePhase === "planning") {
    figureLabel = "科研配图：规划中";
  } else if (figurePhase === "preparing" && figureProgress.total > 0) {
    figureLabel = `科研配图进行中 ${figureProgress.done}/${figureProgress.total}`;
  }
  const hasDocument = filePath !== null;
  const ribbonIcon = { size: iconSize.md, strokeWidth: iconStroke.regular };

  return (
    <div className="dc-app">
      <nav className="dc-ribbon" aria-label="功能区">
        <RibbonButton label="打开文件夹" icon={<FolderOpen {...ribbonIcon} />} onClick={() => void chooseWorkspace()} />
        <RibbonButton label="打开 Markdown 文件" icon={<FileText {...ribbonIcon} />} onClick={() => void chooseFile()} />
        <RibbonButton label="Copilot" icon={<Bot {...ribbonIcon} />} onClick={toggleCopilot} pressed={rightPanel === "copilot"} />
        <RibbonButton
          label={`批注${notes.length > 0 ? `（${notes.length}）` : ""}`}
          icon={<MessageSquare {...ribbonIcon} />}
          onClick={() => setRightPanel(rightPanel === "comments" ? null : "comments")}
          pressed={rightPanel === "comments"}
        />
        <RibbonButton
          label={compressPhase === "running" ? `压缩文档媒体（进行中 ${Math.round(compressOverall * 100)}%）` : "压缩文档媒体"}
          icon={<Minimize2 {...ribbonIcon} />}
          onClick={() => setOverlay({ kind: "compress" })}
          pressed={compressPhase === "running" || overlay?.kind === "compress"}
        />
        <span className="dc-ribbon-spacer" />
        <RibbonButton
          label={figureRunning ? `设置（${figureLabel}）` : "设置"}
          icon={<Settings {...ribbonIcon} />}
          onClick={() => openSettings(figureRunning ? "figure" : undefined)}
          pressed={figureRunning}
        />
      </nav>

      <div className={`dc-workbench${rightPanel ? " has-panel" : ""}`} style={paneWidthStyle(layout.sidebarWidth, layout.panelWidth)}>
        <Sidebar />
        <main className="dc-main">
          {hasDocument && <DocumentTabs />}
          {/* 编辑器常驻，避免切换文档时重建 ProseMirror 视图。 */}
          <div className={hasDocument ? "dc-editor-area" : "dc-editor-area is-hidden"}>
            <MarkdownEditor />
          </div>
          {!hasDocument && <WelcomeView />}
          {/* 搜索结果预览页盖在文档区上，编辑器保持挂载，关闭后原样恢复。 */}
          {preview && <SearchPreview />}
        </main>
        {rightPanel && (
          <aside className="dc-panel" aria-label={rightPanel === "comments" ? "批注" : "Copilot"}>
            <PaneResizer pane="panel" />
            <div className="dc-panel-header">
              <h2 className="dc-panel-title">{rightPanel === "comments" ? "批注" : "Copilot"}</h2>
              <button type="button" className="dc-icon-button" aria-label="关闭侧栏" onClick={() => setRightPanel(null)}>
                <X size={iconSize.sm} />
              </button>
            </div>
            {rightPanel === "comments" ? <CommentsPanel /> : <CopilotView />}
          </aside>
        )}
      </div>

      <footer className="dc-statusbar">
        <WorkspaceSwitcher />
        <span className="dc-statusbar-path" title={filePath ?? ""}>
          {filePath ?? "未打开文档"}
        </span>
        <UpdateBadge />
        <span className="dc-statusbar-message" title={dirty ? "未保存" : status}>{dirty ? "未保存" : status}</span>
        <WordCountStatus />
      </footer>

      <EditorContextMenu />
      <ImagePathPopover />
      <ActiveOverlay overlay={overlay} />
    </div>
  );
}
