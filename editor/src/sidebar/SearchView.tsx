/**
 * 工作区搜索：在当前工作区的所有 Markdown 中按文件名和正文搜索，结果按文件分组。
 * 点击文件名打开文档，点击匹配行打开文档并选中对应文字。搜索由 Rust 端 `search_workspace` 完成。
 */

import { useEffect, useRef, useState } from "react";
import { FileText, Search, X } from "lucide-react";
import { errorText, searchWorkspace, type SearchFile, type SearchResult } from "../backend";
import { openDocument, openSearchResult } from "../documentActions";
import { parentDirectory, relativePath } from "../paths";
import { useAppStore } from "../store";
import { iconSize, iconStroke } from "../styles/tokens";

/** 停止输入多久后发起搜索，避免每敲一个字就遍历一次工作区。 */
const SEARCH_DELAY_MS = 250;

function countMatches(result: SearchResult): number {
  let total = 0;
  for (const file of result.files) {
    total += file.matches.length;
  }
  return total;
}

function SearchFileGroup({ file, root, query }: { file: SearchFile; root: string; query: string }) {
  const folder = relativePath(root, parentDirectory(file.path));
  return (
    <li className="dc-search-file">
      <button type="button" className="dc-search-file-row" title={file.path} onClick={() => void openDocument(file.path)}>
        <FileText size={iconSize.sm} strokeWidth={iconStroke.regular} />
        <span className={`dc-search-file-name${file.name_match ? " is-name-match" : ""}`}>{file.name}</span>
        {folder && <span className="dc-search-file-folder">{folder}</span>}
        <span className="dc-search-count">{file.matches.length}</span>
      </button>
      {file.matches.length > 0 && (
        <ul className="dc-search-matches">
          {file.matches.map((match) => (
            <li key={match.occurrence}>
              <button
                type="button"
                className="dc-search-match"
                onClick={() => void openSearchResult(file.path, query, match.occurrence)}
              >
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

export function SearchView() {
  const workspace = useAppStore((state) => state.workspace);
  const query = useAppStore((state) => state.searchQuery);
  const setQuery = useAppStore((state) => state.setSearchQuery);
  const focusRequest = useAppStore((state) => state.searchFocusRequest);
  const inputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!workspace || !trimmed) {
      setResult(null);
      setError("");
      setSearching(false);
      return;
    }
    // 关键词变化或视图卸载后，旧请求的结果直接丢弃。
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchWorkspace(workspace, trimmed);
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
  }, [workspace, query]);

  if (!workspace) {
    return <div className="dc-sidebar-empty">打开工作区后可以搜索其中的 Markdown 文档。</div>;
  }

  const trimmed = query.trim();
  const fileCount = result?.files.length ?? 0;
  const matchCount = result ? countMatches(result) : 0;

  let summary = "";
  if (searching) {
    summary = "正在搜索…";
  } else if (error) {
    summary = error;
  } else if (result && fileCount === 0) {
    summary = "没有找到匹配的文档。";
  } else if (result) {
    summary = `${fileCount} 个文档，${matchCount} 处正文匹配`;
    if (result.truncated) {
      summary += "（结果过多，只列出前一部分）";
    }
  }

  return (
    <div className="dc-search">
      <div className="dc-outline-filter">
        <Search size={iconSize.sm} className="dc-outline-filter-icon" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          className="dc-input dc-input-bare"
          placeholder="搜索文件名和正文"
          aria-label="在工作区中搜索"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
            }
          }}
        />
        {query && (
          <button type="button" className="dc-icon-button" aria-label="清除搜索" title="清除搜索" onClick={() => setQuery("")}>
            <X size={iconSize.sm} />
          </button>
        )}
      </div>
      {trimmed && summary && (
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
