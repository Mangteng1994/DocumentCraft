/**
 * 把 Markdown 中的本地图片路径转换成 WebView 可加载的地址。
 *
 * 相对路径以当前文档所在目录为基准，与 docflow 转换 Word 时的规则一致。`file:///` 地址
 * （WPS、Typora 复制粘贴时常见）按本地绝对路径处理。网络地址与 data URI 原样返回。
 * 节点属性中保存的仍是原始路径，保存时写回 Markdown 的也是原值。
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

function decoded(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/**
 * `file:` 地址转成 Windows 路径：`file:///C:/a.png` → `C:\a.png`，`file://server/share/a.png` → `\\server\share\a.png`。
 * 不是 `file:` 地址时返回 null。
 */
function fileUrlToPath(source: string): string | null {
  const match = /^file:(\/\/)?(.*)$/i.exec(source);
  if (!match) {
    return null;
  }
  const rest = decoded(match[2]).replaceAll("/", "\\");
  // file:///C:\...：三斜杠后是盘符，去掉开头的分隔符。
  const withoutLeading = rest.replace(/^\\+(?=[a-zA-Z]:)/, "");
  if (isAbsoluteWindowsPath(withoutLeading)) {
    return withoutLeading;
  }
  // file://server/share：双斜杠后是主机名。
  return `\\\\${withoutLeading.replace(/^\\+/, "")}`;
}

/** 图片引用指向的本地绝对路径（`file:` 地址或盘符路径）；相对路径、网络地址返回 null。 */
export function absoluteLocalPath(source: string): string | null {
  const fromUrl = fileUrlToPath(source);
  if (fromUrl) {
    return fromUrl;
  }
  const path = decoded(source);
  if (isAbsoluteWindowsPath(path)) {
    return path;
  }
  return null;
}

/** 图片引用的位置说明（DC-079）：本地图片带绝对路径，网络地址与 data URI 不是本地文件。 */
export interface ImageLocation {
  kind: "local" | "remote";
  /** 本地图片的绝对路径；相对路径但还没有打开文档时为 null。 */
  absolute: string | null;
}

/** 解析图片引用指向的位置，规则与 resolveImageSource 一致：相对路径以当前文档所在目录为基准。 */
export function describeImageSource(source: string): ImageLocation {
  if (/^(https?:|data:|blob:|asset:)/i.test(source)) {
    return { kind: "remote", absolute: null };
  }
  const absolute = absoluteLocalPath(source);
  if (absolute) {
    return { kind: "local", absolute };
  }
  if (!documentDirectory) {
    return { kind: "local", absolute: null };
  }
  const separator = documentDirectory.endsWith("\\") ? "" : "\\";
  return { kind: "local", absolute: `${documentDirectory}${separator}${decoded(source).replaceAll("/", "\\")}` };
}

export function resolveImageSource(source: unknown): string {
  if (typeof source !== "string" || !source) {
    return "";
  }
  if (/^(https?:|data:|blob:|asset:)/i.test(source)) {
    return source;
  }
  const absolute = absoluteLocalPath(source);
  if (absolute) {
    return convertFileSrc(absolute);
  }
  if (!documentDirectory) {
    return source;
  }
  const separator = documentDirectory.endsWith("\\") ? "" : "\\";
  const path = `${documentDirectory}${separator}${decoded(source).replaceAll("/", "\\")}`;
  return convertFileSrc(path);
}
