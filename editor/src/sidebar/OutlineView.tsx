/**
 * 文档大纲。移植自 VMark Sidebar/OutlineView：沿用其标题树、过滤与折叠逻辑
 * （vendor/vmark/utils/markdownOutline），去掉多窗口事件、按标签页保存的折叠状态和多格式分发。
 * 标题直接取自编辑器文档，点击跳到对应标题节点。
 * 折叠状态在应用状态里（outlineCollapsed），以便快捷键按层级折叠（DC-077）。
 */

import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, ListChevronsDownUp, ListOrdered, Search, X } from "lucide-react";
import { buildHeadingTree, filterHeadingTree, type HeadingNode } from "@vmark/utils/markdownOutline";
import { PopupMenu } from "../components/PopupMenu";
import { getEditor, revealPosition } from "../editor/editorHandle";
import { computeHeadingLabels } from "../editor/headingNumbers";
import { useAppStore } from "../store";
import type { MenuEntry } from "../editor/EditorContextMenu";
import type { ActionId } from "../settings/schema";
import { useSettings } from "../settings/settingsStore";
import { iconSize } from "../styles/tokens";
import { collectCollapsedKeys, foldOutlineToLevel, headingKey, OUTLINE_FOLD_LEVELS } from "./outlineFold";

const FOLD_LEVEL_ENTRIES: { level: (typeof OUTLINE_FOLD_LEVELS)[number]; label: string; hotkey: ActionId }[] = [
  { level: 1, label: "只留一级标题", hotkey: "outlineLevel1" },
  { level: 2, label: "只留到二级标题", hotkey: "outlineLevel2" },
  { level: 3, label: "只留到三级标题", hotkey: "outlineLevel3" },
];

const OutlineItem = memo(function OutlineItem({
  node,
  collapsed,
  forceExpand,
  activeIndex,
  numberLabels,
  onToggle,
  onSelect,
}: {
  node: HeadingNode;
  collapsed: Set<string>;
  forceExpand: boolean;
  activeIndex: number | null;
  /** 与编辑区一致的标题编号，按标题在文档中的顺序索引；关闭标题编号时为 null。 */
  numberLabels: (string | null)[] | null;
  onToggle: (key: string) => void;
  onSelect: (node: HeadingNode) => void;
}) {
  const key = headingKey(node);
  const hasChildren = node.children.length > 0;
  const isCollapsed = !forceExpand && collapsed.has(key);
  const isActive = activeIndex === node.index;
  const numberLabel = numberLabels ? numberLabels[node.index] : null;

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
        {numberLabel && <span className="dc-outline-number">{numberLabel}</span>}
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
              numberLabels={numberLabels}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

export function OutlineView() {
  const headings = useAppStore((state) => state.headings);
  const filePath = useAppStore((state) => state.filePath);
  const headingNumbers = useSettings((state) => state.settings.editor.headingNumbers);
  const updateEditor = useSettings((state) => state.update);
  const [query, setQuery] = useState("");
  const collapsed = useAppStore((state) => state.outlineCollapsed);
  const setCollapsed = useAppStore((state) => state.setOutlineCollapsed);
  const [foldMenu, setFoldMenu] = useState<{ x: number; y: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const deferredQuery = useDeferredValue(query);
  const filterActive = deferredQuery.trim().length > 0;

  const tree = useMemo(() => buildHeadingTree(headings), [headings]);
  // 编号按完整标题列表计算（过滤只影响显示），因此过滤后各标题的编号保持不变。
  const numberLabels = useMemo(
    () => (headingNumbers ? computeHeadingLabels(headings.map((heading) => heading.level)) : null),
    [headings, headingNumbers],
  );
  const visibleTree = useMemo(() => filterHeadingTree(tree, deferredQuery), [tree, deferredQuery]);

  const handleToggle = useCallback(
    (key: string) => {
      const next = new Set(useAppStore.getState().outlineCollapsed);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      setCollapsed(next);
    },
    [setCollapsed],
  );

  const collapseAll = () => setCollapsed(collectCollapsedKeys(tree, 1));
  const expandAll = () => setCollapsed(new Set());
  const foldEntries: MenuEntry[] = FOLD_LEVEL_ENTRIES.map((entry) => ({
    label: entry.label,
    hotkey: entry.hotkey,
    run: () => foldOutlineToLevel(entry.level),
  }));

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
        <button
          type="button"
          className="dc-icon-button"
          aria-label="折叠到级别"
          aria-haspopup="menu"
          title="折叠到级别：只留一级、二级或三级标题"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setFoldMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <ListChevronsDownUp size={iconSize.sm} />
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
              numberLabels={numberLabels}
              onToggle={handleToggle}
              onSelect={handleSelect}
            />
          ))}
        </ul>
      ) : (
        <div className="dc-sidebar-empty">没有匹配的标题。</div>
      )}
      {foldMenu && <PopupMenu x={foldMenu.x} y={foldMenu.y} entries={foldEntries} onClose={() => setFoldMenu(null)} />}
    </div>
  );
}
