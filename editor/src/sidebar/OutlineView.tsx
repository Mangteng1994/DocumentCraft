/**
 * 文档大纲。移植自 VMark Sidebar/OutlineView：沿用其标题树、过滤与折叠逻辑
 * （vendor/vmark/utils/markdownOutline），去掉多窗口事件、按标签页保存的折叠状态和多格式分发。
 * 标题直接取自编辑器文档，点击跳到对应标题节点。
 */

import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ListOrdered, Search, X } from "lucide-react";
import { buildHeadingTree, filterHeadingTree, type HeadingNode } from "@vmark/utils/markdownOutline";
import { getEditor, revealPosition } from "../editor/editorHandle";
import { useAppStore } from "../store";
import { useSettings } from "../settings/settingsStore";
import { iconSize } from "../styles/tokens";

const OutlineItem = memo(function OutlineItem({
  node,
  collapsed,
  forceExpand,
  activeIndex,
  onToggle,
  onSelect,
}: {
  node: HeadingNode;
  collapsed: Set<string>;
  forceExpand: boolean;
  activeIndex: number | null;
  onToggle: (key: string) => void;
  onSelect: (node: HeadingNode) => void;
}) {
  const key = headingKey(node);
  const hasChildren = node.children.length > 0;
  const isCollapsed = !forceExpand && collapsed.has(key);
  const isActive = activeIndex === node.index;

  return (
    <li className="dc-outline-item">
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={isActive}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        className={`dc-outline-row dc-outline-level-${node.level}${isActive ? " is-active" : ""}`}
        onClick={() => onSelect(node)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(node);
          }
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="dc-outline-toggle"
            aria-label={isCollapsed ? "展开" : "折叠"}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(key);
            }}
          >
            {isCollapsed ? <ChevronRight size={iconSize.sm} /> : <ChevronDown size={iconSize.sm} />}
          </button>
        ) : (
          <span className="dc-outline-toggle" />
        )}
        <span className="dc-outline-level" aria-label={`${node.level} 级标题`}>
          H{node.level}
        </span>
        <span className="dc-outline-text" title={node.text}>
          {node.text}
        </span>
      </div>
      {hasChildren && !isCollapsed && (
        <ul className="dc-outline-children" role="group">
          {node.children.map((child) => (
            <OutlineItem
              key={child.index}
              node={child}
              collapsed={collapsed}
              forceExpand={forceExpand}
              activeIndex={activeIndex}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

/** 标题节点的折叠键，与 OutlineItem 中的 key 保持一致。 */
function headingKey(node: HeadingNode): string {
  return `${node.level}:${node.text}:${node.index}`;
}

/** 收集所有带子标题的节点的折叠键，供「全部折叠」使用。 */
function collectCollapsible(nodes: HeadingNode[], result: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.children.length > 0) {
      result.add(headingKey(node));
      collectCollapsible(node.children, result);
    }
  }
  return result;
}

export function OutlineView() {
  const headings = useAppStore((state) => state.headings);
  const filePath = useAppStore((state) => state.filePath);
  const headingNumbers = useSettings((state) => state.settings.editor.headingNumbers);
  const updateEditor = useSettings((state) => state.update);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const deferredQuery = useDeferredValue(query);
  const filterActive = deferredQuery.trim().length > 0;

  const tree = useMemo(() => buildHeadingTree(headings), [headings]);
  const visibleTree = useMemo(() => filterHeadingTree(tree, deferredQuery), [tree, deferredQuery]);

  const handleToggle = useCallback((key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const collapseAll = () => setCollapsed(collectCollapsible(tree, new Set()));
  const expandAll = () => setCollapsed(new Set());

  const handleSelect = useCallback((node: HeadingNode) => {
    setActiveIndex(node.index);
    const editor = getEditor();
    if (!editor) {
      return;
    }
    // line 存放的是标题节点位置，+1 把光标放进标题文字内。
    revealPosition(node.line + 1);
  }, []);

  if (!filePath) {
    return <div className="dc-sidebar-empty">打开文档后显示大纲。</div>;
  }
  if (headings.length === 0) {
    return <div className="dc-sidebar-empty">文档中没有标题。</div>;
  }

  return (
    <div className="dc-outline" role="complementary" aria-label="文档大纲">
      <div className="dc-outline-filter">
        <Search size={iconSize.sm} className="dc-outline-filter-icon" aria-hidden="true" />
        <input
          type="text"
          className="dc-input dc-input-bare"
          placeholder="过滤标题"
          aria-label="过滤标题"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
            }
          }}
        />
        {query && (
          <button type="button" className="dc-icon-button" aria-label="清除过滤" onClick={() => setQuery("")}>
            <X size={iconSize.sm} />
          </button>
        )}
        <button
          type="button"
          className={`dc-icon-button${headingNumbers ? " is-filled" : ""}`}
          aria-label="标题编号"
          aria-pressed={headingNumbers}
          title={headingNumbers ? "隐藏标题编号" : "显示标题编号（1、1.1、1.1.1、1.1.1.1）"}
          onClick={() => updateEditor("editor", { headingNumbers: !headingNumbers })}
        >
          <ListOrdered size={iconSize.sm} />
        </button>
        <button type="button" className="dc-icon-button" aria-label="全部折叠" title="全部折叠" onClick={collapseAll}>
          <ChevronsDownUp size={iconSize.sm} />
        </button>
        <button type="button" className="dc-icon-button" aria-label="全部展开" title="全部展开" onClick={expandAll}>
          <ChevronsUpDown size={iconSize.sm} />
        </button>
      </div>
      {visibleTree.length > 0 ? (
        <ul className="dc-outline-tree" role="tree">
          {visibleTree.map((node) => (
            <OutlineItem
              key={node.index}
              node={node}
              collapsed={collapsed}
              forceExpand={filterActive}
              activeIndex={activeIndex}
              onToggle={handleToggle}
              onSelect={handleSelect}
            />
          ))}
        </ul>
      ) : (
        <div className="dc-sidebar-empty">没有匹配的标题。</div>
      )}
    </div>
  );
}
