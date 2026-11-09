/**
 * 把 Markdown 中的本地图片路径转换成 WebView 可加载的地址。
 *
 * 相对路径以当前文档所在目录为基准，与 docflow 转换 Word 时的规则一致。
 * 网络地址与 data URI 原样返回。节点属性中保存的仍是原始路径，保存时写回 Markdown 的也是原值。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

let documentDirectory = "";

/** 切换文档时更新图片的相对路径基准。 */
export function setDocumentDirectory(directory: string): void {
  documentDirectory = directory;
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function resolveImageSource(source: unknown): string {
  if (typeof source !== "string" || !source) {
    return "";
  }
  if (/^(https?:|data:|blob:|asset:)/i.test(source)) {
    return source;
  }
  let path = source;
  try {
    path = decodeURI(source);
  } catch {
    path = source;
  }
  if (!isAbsoluteWindowsPath(path)) {
    if (!documentDirectory) {
      return source;
    }
    const separator = documentDirectory.endsWith("\\") ? "" : "\\";
    path = `${documentDirectory}${separator}${path.replaceAll("/", "\\")}`;
  }
  return convertFileSrc(path);
}
