/**
 * Windows 路径小工具。工作区路径来自系统对话框，统一使用反斜杠拼接。
 */

const SEPARATOR = "\\";

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
}

export function fileName(path: string): string {
  return path.slice(lastSeparator(path) + 1);
}

export function parentDirectory(path: string): string {
  const index = lastSeparator(path);
  if (index <= 0) {
    return path;
  }
  return path.slice(0, index);
}

/** 去掉 .md / .markdown 扩展名，作为笔记标题。 */
export function noteTitle(path: string): string {
  return fileName(path).replace(/\.(md|markdown)$/i, "");
}

/** 拼接路径，片段中的正斜杠统一换成反斜杠。 */
export function joinPath(base: string, ...parts: string[]): string {
  let result = base.replace(/[\\/]+$/, "");
  for (const part of parts) {
    const cleaned = part.replace(/^[\\/]+|[\\/]+$/g, "").replaceAll("/", SEPARATOR);
    if (cleaned) {
      result = `${result}${SEPARATOR}${cleaned}`;
    }
  }
  return result;
}

/** 工作区内文件的相对路径（正斜杠），不在工作区内时返回原路径。 */
export function relativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, "").toLowerCase();
  if (!path.toLowerCase().startsWith(normalizedRoot)) {
    return path;
  }
  return path.slice(normalizedRoot.length).replace(/^[\\/]+/, "").replaceAll(SEPARATOR, "/");
}

/**
 * 把 Windows 文件名不允许的字符，以及 Obsidian 笔记名不允许的 [ ] # ^ 替换为空格，并截断过长的名称。
 * 对话记录和命令要能在 Obsidian 中作为笔记打开、被 [[ ]] 引用。
 */
export function safeFileName(name: string, maxLength = 40): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f[\]#^]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, maxLength).trim() || "untitled";
}
