/**
 * 搜索结果预览页（DC-066）：在侧栏搜索结果中左键点击文件后，盖在中间文档区上，显示「识别到了什么」。
 *
 * - 关键词出现在文件名里：显示文件名并高亮命中；
 * - Markdown 标题命中：标注标题级别，显示标题文字；
 * - 正文命中：显示所在页、段或行，以及命中所在的那一行和上下文，命中文字高亮。
 * 正文由后端 `preview_file` 读取（Markdown、txt 等纯文本，Word、Excel、PowerPoint、PDF）。
 * 交互参考开源项目 pivotsearch（Apache-2.0，https://github.com/alrece/pivotsearch，AnyTXT 的开源替代品）：
 * 选中结果后在预览区显示命中内容、自动滚动到首个命中、可在命中之间逐个切换。AnyTXT 本身是闭源免费软件，
 * 没有可采用的源码；本页的布局与高亮实现是本项目自己的。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, File, FileText, X } from "lucide-react";
import { errorText, previewFile, type FilePreview } from "../../backend";
import { closeSearchPreview, openDocument, openSearchResult, openWithSystem } from "../../documentActions";
import { formatSize } from "../../format";
import { useAppStore } from "../../store";
import { iconSize, iconStroke } from "../../styles/tokens";

const KIND_LABELS: Record<string, string> = {
  markdown: "Markdown 文档",
  text: "文本文件",
  docx: "Word 文档",
  xlsx: "Excel 表格",
  pptx: "PowerPoint 演示文稿",
  pdf: "PDF 文档",
  other: "其他文件",
};

/** 把文字按命中范围切开，命中部分用 mark 高亮。范围是 Unicode 字符序号，所以先按字符切分，不能直接用字符串下标。 */
function Highlighted({ text, ranges, cutStart = false, cutEnd = false }: { text: string; ranges: [number, number][]; cutStart?: boolean; cutEnd?: boolean }) {
  const characters = Array.from(text);
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach(([start, length], index) => {
    if (start < cursor) {
      return;
    }
    if (start > cursor) {
      parts.push(characters.slice(cursor, start).join(""));
    }
    parts.push(
      <mark key={index} className="dc-search-hit">
        {characters.slice(start, start + length).join("")}
      </mark>,
    );
    cursor = start + length;
  });
  if (cursor < characters.length) {
    parts.push(characters.slice(cursor).join(""));
  }
  return (
    <>
      {cutStart && "…"}
      {parts}
      {cutEnd && "…"}
    </>
  );
}

export function SearchPreview() {
  const target = useAppStore((state) => state.preview);
  const [data, setData] = useState<FilePreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 当前聚焦的命中块：打开时是被点击的那一处，没有指定时是第一处。
  const [activeIndex, setActiveIndex] = useState(0);

  const path = target?.path;
  const query = target?.query;
  const mode = target?.mode;
  const focusLocator = target?.focusLocator ?? "";

  useEffect(() => {
    if (!path || query === undefined || !mode) {
      return;
    }
    // 切换文件或关键词后，旧请求的结果直接丢弃。
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    previewFile(path, query, mode)
      .then((value) => {
        if (!cancelled) {
          setData(value);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(errorText(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, query, mode]);

  // 读取完成后，聚焦被点击的那一处匹配；没有指定时聚焦第一处。
  useEffect(() => {
    if (!data) {
      return;
    }
    const index = focusLocator ? data.blocks.findIndex((block) => block.locator === focusLocator) : -1;
    setActiveIndex(index >= 0 ? index : 0);
  }, [data, focusLocator]);

  // 聚焦的命中块变化时（读取完成、点上一处或下一处）平滑滚动到它。
  useEffect(() => {
    if (!data || data.blocks.length === 0) {
      return;
    }
    bodyRef.current?.querySelector('[data-focus="true"]')?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [data, activeIndex]);

  // Esc 关闭预览页；设置等浮层打开时 Esc 属于浮层。
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && useAppStore.getState().overlay === null) {
        closeSearchPreview();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  if (!target) {
    return null;
  }

  const isMarkdown = /\.(md|markdown)$/i.test(target.name);
  const hasBlocks = (data?.blocks.length ?? 0) > 0;
  const nothingFound = data !== null && !hasBlocks && data.name_ranges.length === 0 && !data.note;

  // 第 i 个命中块之前一共有多少处命中，作为编辑器中「第几处」的序号。
  let hitsBefore = 0;
  const offsets = (data?.blocks ?? []).map((block) => {
    const offset = hitsBefore;
    hitsBefore += block.ranges.length;
    return offset;
  });
  const blockCount = data?.blocks.length ?? 0;

  const openInEditor = (occurrence: number) => {
    if (hasBlocks) {
      void openSearchResult(target.path, target.query, occurrence);
    } else {
      void openDocument(target.path);
    }
  };

  return (
    <section className="dc-preview" aria-label="搜索结果预览">
      <header className="dc-preview-header">
        <div className="dc-preview-title-row">
          {isMarkdown ? (
            <FileText size={iconSize.md} strokeWidth={iconStroke.regular} />
          ) : (
            <File size={iconSize.md} strokeWidth={iconStroke.regular} />
          )}
          <h2 className="dc-preview-title" title={target.name}>
            {data ? <Highlighted text={data.name} ranges={data.name_ranges} /> : target.name}
          </h2>
        </div>
        <div className="dc-preview-actions">
          {isMarkdown ? (
            <button type="button" className="dc-button" onClick={() => openInEditor(0)}>
              在编辑器中打开
            </button>
          ) : (
            <button type="button" className="dc-button" onClick={() => void openWithSystem(target.path, target.name)}>
              <ExternalLink size={iconSize.sm} />
              用默认应用打开
            </button>
          )}
          <button type="button" className="dc-icon-button" aria-label="关闭预览" title="关闭预览（Esc）" onClick={closeSearchPreview}>
            <X size={iconSize.md} />
          </button>
        </div>
      </header>
      <div className="dc-preview-meta">
        {data ? `${KIND_LABELS[data.kind] ?? "文件"} · ${formatSize(data.size)} · ` : ""}
        {target.path}
      </div>
      <div className="dc-preview-body" ref={bodyRef}>
        {loading && <p className="dc-status-line">正在读取文件…</p>}
        {error && <p className="dc-status-line is-error">{error}</p>}
        {data && data.name_ranges.length > 0 && (
          <section className="dc-preview-section" aria-label="文件名">
            <div className="dc-preview-block-head">
              <span className="dc-preview-tag">文件名</span>
              <span>关键词出现在文件名中</span>
            </div>
            <p className="dc-preview-line is-heading">
              <Highlighted text={data.name} ranges={data.name_ranges} />
            </p>
          </section>
        )}
        {data && hasBlocks && (
          <div className="dc-preview-summary">
            <span>
              正文中找到 {data.total_hits.toLocaleString()} 处匹配，分布在 {blockCount.toLocaleString()} 行
              {data.truncated ? "（匹配太多，只列出前一部分）" : ""}
            </span>
            <span className="dc-preview-nav">
              <button
                type="button"
                className="dc-icon-button"
                aria-label="上一处"
                title="上一处"
                disabled={activeIndex <= 0}
                onClick={() => setActiveIndex(activeIndex - 1)}
              >
                <ChevronUp size={iconSize.sm} />
              </button>
              <span className="dc-preview-nav-count">
                {activeIndex + 1} / {blockCount}
              </span>
              <button
                type="button"
                className="dc-icon-button"
                aria-label="下一处"
                title="下一处"
                disabled={activeIndex >= blockCount - 1}
                onClick={() => setActiveIndex(activeIndex + 1)}
              >
                <ChevronDown size={iconSize.sm} />
              </button>
            </span>
          </div>
        )}
        {data?.note && <p className="dc-status-line is-warning">{data.note}</p>}
        {nothingFound && <p className="dc-status-line">没有找到匹配的内容。</p>}
        {data && hasBlocks && (
          <ol className="dc-preview-blocks">
            {data.blocks.map((block, index) => {
              const focused = index === activeIndex;
              return (
                <li
                  key={`${block.locator}-${index}`}
                  className={`dc-preview-block${focused ? " is-focus" : ""}`}
                  data-focus={focused ? "true" : undefined}
                  onClick={() => setActiveIndex(index)}
                >
                  <div className="dc-preview-block-head">
                    <span className="dc-preview-locator">{block.locator}</span>
                    {block.heading_level > 0 && <span className="dc-preview-tag">{`H${block.heading_level} 标题`}</span>}
                    {isMarkdown && (
                      <button type="button" className="dc-link-button" onClick={() => openInEditor(offsets[index])}>
                        在编辑器中打开此处
                      </button>
                    )}
                  </div>
                  {block.context_before && <p className="dc-preview-context">{block.context_before}</p>}
                  <p className={`dc-preview-line${block.heading_level > 0 ? " is-heading" : ""}`}>
                    <Highlighted text={block.text} ranges={block.ranges} cutStart={block.cut_start} cutEnd={block.cut_end} />
                  </p>
                  {block.context_after && <p className="dc-preview-context">{block.context_after}</p>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
