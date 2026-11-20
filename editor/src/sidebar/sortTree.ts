/**
 * 目录树排序（DC-071）：文件夹始终排在文件之前，同类按所选依据排序，名称相同时再按名称兜底。
 * 排序只在前端渲染时进行，不改动后端返回的数据，切换排序不需要重新读取目录。
 */

import type { TreeNode } from "../backend";
import type { SortKey } from "../settings/schema";

const NAME_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** 取扩展名（小写、含点）；没有扩展名或以点开头的名称返回空串。 */
function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  if (index <= 0) {
    return "";
  }
  return name.slice(index).toLowerCase();
}

function compareByKey(left: TreeNode, right: TreeNode, key: SortKey): number {
  if (key === "modified") {
    return left.modified - right.modified;
  }
  if (key === "type") {
    return NAME_COLLATOR.compare(extensionOf(left.name), extensionOf(right.name));
  }
  return NAME_COLLATOR.compare(left.name, right.name);
}

/**
 * 返回排好序的新数组。descending 只翻转所选依据的方向：文件夹仍在文件前面，名称兜底始终升序。
 * 修改时间升序即「最早修改在前」，降序即「最近修改在前」。
 */
export function sortNodes(nodes: TreeNode[], key: SortKey, descending: boolean): TreeNode[] {
  const direction = descending ? -1 : 1;
  return [...nodes].sort((left, right) => {
    if (left.is_dir !== right.is_dir) {
      return left.is_dir ? -1 : 1;
    }
    const primary = compareByKey(left, right, key) * direction;
    if (primary !== 0) {
      return primary;
    }
    return NAME_COLLATOR.compare(left.name, right.name);
  });
}
