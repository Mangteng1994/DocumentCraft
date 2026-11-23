/**
 * 大纲折叠状态的计算（DC-077）。
 *
 * 折叠状态保存在应用状态 `outlineCollapsed` 中，而不是大纲组件内部，
 * 这样全局快捷键（Ctrl+Alt+1～3）和大纲头部菜单都能按层级一次折叠到位。
 */

import { buildHeadingTree, type HeadingNode } from "@vmark/utils/markdownOutline";
import { useAppStore } from "../store";

/** 「只留到几级标题」的可选级别。 */
export const OUTLINE_FOLD_LEVELS = [1, 2, 3] as const;
export type OutlineFoldLevel = (typeof OUTLINE_FOLD_LEVELS)[number];

/** 标题节点的折叠键，大纲每一行用同一个键判断是否折叠。 */
export function headingKey(node: HeadingNode): string {
  return `${node.level}:${node.text}:${node.index}`;
}

/**
 * 收集需要折叠的标题键：带子标题且级别不小于 minLevel 的标题。
 * minLevel 为 1 时折叠所有带子标题的标题（即「全部折叠」）；
 * 为 2 时 H1 保持展开、从 H2 起收起，表现为「只留到二级标题」。
 * 文档跳级时（如 H1 下直接是 H3），大纲是树形，被跳过的深层标题仍会显示在其父级下。
 */
export function collectCollapsedKeys(nodes: HeadingNode[], minLevel: number, result: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.children.length > 0) {
      if (node.level >= minLevel) {
        result.add(headingKey(node));
      }
      collectCollapsedKeys(node.children, minLevel, result);
    }
  }
  return result;
}

/** 折叠大纲到指定级别：切到大纲视图，只保留不深于 level 的标题。 */
export function foldOutlineToLevel(level: OutlineFoldLevel): void {
  const store = useAppStore.getState();
  const tree = buildHeadingTree(store.headings);
  store.setSidebarView("outline");
  store.setOutlineCollapsed(collectCollapsedKeys(tree, level));
}
