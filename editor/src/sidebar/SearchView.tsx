/**
 * 工作区搜索：Ctrl+F 在侧栏标签栏下方打开搜索框（SearchBar），搜索框左侧的范围按钮切换三种模式：
 * 所有（文件名 + 正文）、所有文件名、所有正文。有关键词时结果列表（SearchResults）替换目录树，
 * 按文件分组。Markdown 结果在编辑器中打开并选中命中文字，其他文件交给系统默认应用。
 * 搜索由 Rust 端 `search_workspace` 完成；Word、Excel、PowerPoint、PDF 的正文来自后台建立的索引，
 * 首次打开搜索时开始建立，进度显示在结果上方。
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, File, FileText, Search, X } from "lucide-react";
import { errorText, searchWorkspace, type SearchFile, type SearchResult } from "../backend";
import { openDocument, openSearchResult, openWithSystem } from "../documentActions";
import { parentDirectory, relativePath } from "../paths";
import { SEARCH_MODES, type SearchMode } from "../settings/schema";
import { useSettings } from "../settings/settingsStore";
import { useAppStore } from "../store";
import { startIndexing } from "./searchIndex";
import { iconSize, iconStroke } from "../styles/tokens";

/** 停止输入多久后发起搜索，避免每敲一个字就遍历一次工作区。 */
const SEARCH_DELAY_MS = 250;

const MARKDOWN_NAME = /\.(md|markdown)$/i;

/** 各搜索范围的名称、说明和输入框提示。 */
const MODE_INFO: Record<SearchMode, { label: string; description: string; placeholder: string }> = {
  all: { label: "所有", description: "文件名 + 正文（含 Word、Excel、PowerPoint、PDF）", placeholder: "搜索文件名和正文" },
  names: { label: "所有文件名", description: "只匹配文件名，包含各种类型的文件", placeholder: "搜索文件名" },
  text: { label: "所有正文", description: "只匹配正文：Markdown、txt 等纯文本，以及 Word、Excel、PowerPoint、PDF", placeholder: "搜索正文" },
};

function useSearchMode(): [SearchMode, (mode: SearchMode) => void] {
  const mode = useSettings((state) => state.settings.files.searchMode);
  const update = useSettings((state) => state.update);
  return [mode, (next) => update("files", { searchMode: next })];
}

/** 打开结果文件：Markdown 在编辑器中打开，其他文件用系统默认应用。 */
function openFile(file: SearchFile): void {
  if (MARKDOWN_NAME.test(file.name)) {
    void openDocument(file.path);
    return;
  }
  void openWithSystem(file.path, file.name);
}

/** 把秒数说成「刚刚」「N 分钟前」「N 小时前」。 */
function formatAge(seconds: number): string {
  if (seconds < 60) {
    return "刚刚";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function countMatches(result: SearchResult): number {
  let total = 0;
  for (const file of result.files) {
    total += file.matches.length;
  }
  return total;
}

/** 标签栏下方的搜索框。Esc 或 × 关闭搜索并恢复目录树。 */
export function SearchBar() {
  const query = useAppStore((state) => state.searchQuery);
  const setQuery = useAppStore((state) => state.setSearchQuery);
  const closeSearch = useAppStore((state) => state.closeSearch);
  const focusRequest = useAppStore((state) => state.searchFocusRequest);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const workspace = useAppStore((state) => state.workspace);
  const [mode, setMode] = useSearchMode();
  const [menuOpen, setMenuOpen] = useState(false);

  // 搜索框打开时、或切换到含正文的范围时，确保文档索引已建立或更新（增量，已是最新则很快结束）。
  useEffect(() => {
    if (workspace && mode !== "names") {
      void startIndexing(workspace);
    }
  }, [workspace, mode]);

  // 每次按 Ctrl+F 都聚焦并选中已有关键词，方便直接改写。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  // 点击菜单外部或按 Esc 关闭范围菜单；菜单打开时 Esc 只关菜单，不关闭搜索。
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handlePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenuOpen(false);
        inputRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", handlePointer);
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("keydown", handleKey, true);
    };
  }, [menuOpen]);

  const chooseMode = (next: SearchMode) => {
    setMode(next);
    setMenuOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="dc-search-bar" ref={rootRef}>
      <div className="dc-outline-filter">
        <button
          type="button"
          className="dc-search-mode-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`搜索范围：${MODE_INFO[mode].label}`}
          title={`搜索范围：${MODE_INFO[mode].label}`}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Search size={iconSize.sm} aria-hidden="true" />
          <ChevronDown size={iconSize.sm} aria-hidden="true" />
        </button>
        <input
          ref={inputRef}
          type="text"
          className="dc-input dc-input-bare"
          placeholder={MODE_INFO[mode].placeholder}
          aria-label="在工作区中搜索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeSearch();
            }
          }}
        />
        <button type="button" className="dc-icon-button" aria-label="关闭搜索" title="关闭搜索（Esc）" onClick={closeSearch}>
          <X size={iconSize.sm} />
        </button>
      </div>
      {menuOpen && (
        <div className="dc-search-mode-menu" role="menu" aria-label="搜索范围">
          {SEARCH_MODES.map((item) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={item === mode}
              className={`dc-search-mode-item${item === mode ? " is-current" : ""}`}
              onClick={() => chooseMode(item)}
            >
              <span className="dc-search-mode-check">{item === mode && <Check size={iconSize.sm} />}</span>
              <span className="dc-search-mode-text">
                <span className="dc-search-mode-label">{MODE_INFO[item].label}</span>
                <span className="dc-search-mode-description">{MODE_INFO[item].description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SearchFileGroup({ file, root, query }: { file: SearchFile; root: string; query: string }) {
  const folder = relativePath(root, parentDirectory(file.path));
  const isMarkdown = MARKDOWN_NAME.test(file.name);
  const openMatch = (occurrence: number) => {
    if (isMarkdown) {
      void openSearchResult(file.path, query, occurrence);
      return;
    }
    void openWithSystem(file.path, file.name);
  };
  return (
    <li className="dc-search-file">
      <button type="button" className="dc-search-file-row" title={file.path} onClick={() => openFile(file)}>
        {isMarkdown ? (
          <FileText size={iconSize.sm} strokeWidth={iconStroke.regular} />
        ) : (
          <File size={iconSize.sm} strokeWidth={iconStroke.regular} />
        )}
        <span className={`dc-search-file-name${file.name_match ? " is-name-match" : ""}`}>{file.name}</span>
        {folder && <span className="dc-search-file-folder">{folder}</span>}
        {file.matches.length > 0 && <span className="dc-search-count">{file.matches.length}</span>}
      </button>
      {file.matches.length > 0 && (
        <ul className="dc-search-matches">
          {file.matches.map((match) => (
            <li key={match.occurrence}>
              <button type="button" className="dc-search-match" onClick={() => openMatch(match.occurrence)}>
                <span className="dc-search-line">{match.locator}</span>
                <span className="dc-search-snippet">
                  {match.before}
                  <mark className="dc-search-hit">{match.hit}</mark>
                  {match.after}
                </span>
              </button>
            </li>
          ))}
          {file.more && <li className="dc-search-more">此文件还有更多匹配，未全部列出</li>}
        </ul>
      )}
    </li>
  );
}

/** 搜索结果列表。仅在搜索框打开且有关键词时渲染，替换目录树。 */
export function SearchResults() {
  const workspace = useAppStore((state) => state.workspace);
  const query = useAppStore((state) => state.searchQuery);
  const [mode] = useSearchMode();
  const indexVersion = useAppStore((state) => state.indexVersion);
  const indexProgress = useAppStore((state) => state.indexProgress);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const trimmed = query.trim();

  useEffect(() => {
    if (!workspace || !trimmed) {
      setResult(null);
      setError("");
      setSearching(false);
      return;
    }
    // 关键词变化或列表卸载后，旧请求的结果直接丢弃。
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchWorkspace(workspace, trimmed, mode);
        if (cancelled) {
          return;
        }
        setResult(found);
        setError("");
      } catch (reason) {
        if (cancelled) {
          return;
        }
        setResult(null);
        setError(errorText(reason));
      } finally {
        if (!cancelled) {
          setSearching(false);
        }
      }
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [workspace, trimmed, mode, indexVersion]);

  // 现场遍历超时（工作区很大）：先在后台扫描文件夹，扫描完成后会自动重新搜索。
  useEffect(() => {
    if (workspace && result?.needs_scan && !(indexProgress?.running ?? false)) {
      void startIndexing(workspace);
    }
  }, [workspace, result, indexProgress]);

  // 搜索期间出现了新增或刚修改的文档（已索引数少于总数且后台没有在建立）时，补做一次增量索引。
  // 同一个「总数:已索引数」状态只触发一次，避免文档始终无法索引时反复启动。大工作区推迟索引，不自动补做。
  const autoStarted = useRef("");
  useEffect(() => {
    const docs = result?.docs;
    if (!workspace || !docs || mode === "names" || docs.running || docs.deferred || docs.indexed >= docs.total) {
      return;
    }
    const key = `${workspace}:${docs.total}:${docs.indexed}`;
    if (autoStarted.current === key) {
      return;
    }
    autoStarted.current = key;
    void startIndexing(workspace);
  }, [workspace, mode, result]);

  if (!workspace) {
    return <div className="dc-sidebar-empty">打开工作区后可以搜索其中的文档。</div>;
  }

  const fileCount = result?.files.length ?? 0;
  const matchCount = result ? countMatches(result) : 0;

  const scanning = indexProgress?.running === true && indexProgress.phase === "scan";
  let summary = "";
  // 刷新索引进度触发的重新搜索期间保留旧结果和旧摘要，避免闪烁。
  if (result?.needs_scan || (scanning && !result)) {
    summary = "这个工作区很大，正在扫描文件夹，完成后会自动搜索。";
  } else if (searching && !result) {
    summary = "正在搜索…";
  } else if (error) {
    summary = error;
  } else if (result && fileCount === 0) {
    summary = "没有找到匹配的文件。";
  } else if (result) {
    summary = mode === "names" ? `${fileCount} 个文件名匹配` : `${fileCount} 个文件，${matchCount} 处正文匹配`;
    if (result.truncated) {
      summary += "（结果过多，只列出前一部分）";
    }
  }

  // 文档正文索引的提示：建立中显示进度，建立后说明哪些文档搜不到正文。
  const notes: string[] = [];
  const docs = result?.docs;
  if (scanning && indexProgress) {
    notes.push(`正在扫描文件夹，已发现 ${indexProgress.done.toLocaleString()} 个文件。`);
  }
  if (docs && docs.total > 0 && mode !== "names" && !docs.deferred) {
    const running = docs.running || (indexProgress?.running ?? false);
    if (running) {
      const done = indexProgress ? indexProgress.done : docs.indexed;
      const total = indexProgress ? indexProgress.total : docs.total;
      notes.push(`正在建立 Word、Excel、PowerPoint、PDF 的正文索引（${done}/${total}），完成前结果可能不完整。`);
    } else if (docs.indexed < docs.total) {
      notes.push(`还有 ${docs.total - docs.indexed} 个文档未建立索引，正在准备。`);
    }
    if (docs.failed > 0) {
      notes.push(`${docs.failed} 个文档无法解析（可能已加密或损坏），只能按文件名搜索。`);
    }
    if (docs.no_text > 0) {
      notes.push(`${docs.no_text} 个文档没有文字层（多为扫描件），暂不支持识别图片中的文字。`);
    }
  }

  // 大工作区：说明文件列表来自缓存并提供重新扫描；文档和纯文本索引推迟时提供手动建立的按钮。
  const showDeferred = Boolean(docs?.deferred) && mode !== "names" && (docs?.total ?? 0) > 0 && (docs?.indexed ?? 0) < (docs?.total ?? 0);
  const busy = indexProgress?.running === true;

  return (
    <div className="dc-search">
      {summary && (
        <div className="dc-search-summary" role="status">
          {summary}
        </div>
      )}
      {result?.large && !result.needs_scan && (
        <div className="dc-search-note">
          工作区很大（{result.file_count.toLocaleString()} 个文件），文件列表是 {formatAge(result.scan_age_seconds)}扫描的。
          <button type="button" className="dc-link-button" disabled={busy} onClick={() => void startIndexing(workspace, { refresh: true })}>
            重新扫描
          </button>
        </div>
      )}
      {showDeferred && docs && (
        <div className="dc-search-note">
          没有自动建立正文索引：这个工作区很大，有 {docs.total.toLocaleString()} 个 Word、Excel、PowerPoint、PDF 和 Markdown 文档需要读取。现在只能搜到文件名。
          <button type="button" className="dc-link-button" disabled={busy} onClick={() => void startIndexing(workspace, { manual: true })}>
            建立正文索引
          </button>
        </div>
      )}
      {notes.map((note) => (
        <div key={note} className="dc-search-note">
          {note}
        </div>
      ))}
      {result && fileCount > 0 && (
        <ul className="dc-search-results" aria-label="搜索结果">
          {result.files.map((file) => (
            <SearchFileGroup key={file.path} file={file} root={workspace} query={trimmed} />
          ))}
        </ul>
      )}
    </div>
  );
}
