/**
 * 工作区搜索：Ctrl+F 在侧栏标签栏下方打开搜索框（SearchBar），搜索框左侧的范围按钮切换三种模式：
 * 所有（文件名 + 纯文本正文）、所有文件名、所有纯文本正文。有关键词时结果列表（SearchResults）替换目录树，
 * 按文件分组。Markdown 结果在编辑器中打开并选中命中文字，其他文件交给系统默认应用。
 * 搜索由 Rust 端 `search_workspace` 完成；Word、PDF、Excel 的正文暂不搜索。
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, File, FileText, Search, X } from "lucide-react";
import { errorText, searchWorkspace, type SearchFile, type SearchResult } from "../backend";
import { openDocument, openSearchResult, openWithSystem } from "../documentActions";
import { parentDirectory, relativePath } from "../paths";
import { SEARCH_MODES, type SearchMode } from "../settings/schema";
import { useSettings } from "../settings/settingsStore";
import { useAppStore } from "../store";
import { iconSize, iconStroke } from "../styles/tokens";

/** 停止输入多久后发起搜索，避免每敲一个字就遍历一次工作区。 */
const SEARCH_DELAY_MS = 250;

const MARKDOWN_NAME = /\.(md|markdown)$/i;

/** 各搜索范围的名称、说明和输入框提示。 */
const MODE_INFO: Record<SearchMode, { label: string; description: string; placeholder: string }> = {
  all: { label: "所有", description: "文件名 + 纯文本正文（暂不含 Word、PDF、Excel 正文）", placeholder: "搜索文件名和纯文本正文" },
  names: { label: "所有文件名", description: "只匹配文件名，包含各种类型的文件", placeholder: "搜索文件名" },
  text: { label: "所有纯文本正文", description: "只匹配 Markdown、txt、csv 等纯文本内容", placeholder: "搜索纯文本正文" },
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
  const [mode, setMode] = useSearchMode();
  const [menuOpen, setMenuOpen] = useState(false);

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
                <span className="dc-search-line">{match.line}</span>
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
  }, [workspace, trimmed, mode]);

  if (!workspace) {
    return <div className="dc-sidebar-empty">打开工作区后可以搜索其中的 Markdown 文档。</div>;
  }

  const fileCount = result?.files.length ?? 0;
  const matchCount = result ? countMatches(result) : 0;

  let summary = "";
  if (searching) {
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

  return (
    <div className="dc-search">
      {summary && (
        <div className="dc-search-summary" role="status">
          {summary}
        </div>
      )}
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
