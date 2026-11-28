/**
 * 前端调用 Tauri 命令与 docflow sidecar 的入口。
 */

import { Channel, invoke } from "@tauri-apps/api/core";

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[];
  /** 子项是否已读取。按需加载时，没展开过的文件夹为 false，展开时用 listDir 读取。 */
  loaded: boolean;
  /** 文件夹的条目太多，只列出了前一部分。 */
  truncated: boolean;
  /** 工作区很大，目录树改为按需加载（只对根节点有意义）。 */
  lazy: boolean;
  /** 最后修改时间（毫秒时间戳），读不到时为 0。 */
  modified: number;
}

/**
 * showAll 为真时列出全部文件和空文件夹，否则只列 Markdown。工作区很大（超出读取预算）时只返回顶层，
 * 根节点的 lazy 为真，其余文件夹的 loaded 为 false。
 */
export function listTree(root: string, showAll = false): Promise<TreeNode> {
  return invoke<TreeNode>("list_tree", { root, showAll });
}

/** 读取一个文件夹的直接子项，供按需加载时展开文件夹使用。 */
export function listDir(path: string, showAll = false): Promise<TreeNode> {
  return invoke<TreeNode>("list_dir", { path, showAll });
}

/** 在目录下新建空 Markdown 文件，返回路径；同名文件已存在时抛错。 */
export function createMarkdown(directory: string, name: string): Promise<string> {
  return invoke<string>("create_markdown", { directory, name });
}

/** 在目录下新建文件夹，返回路径；同名条目已存在时抛错。 */
export function createFolder(directory: string, name: string): Promise<string> {
  return invoke<string>("create_folder", { directory, name });
}

export interface SearchSlide {
  /** 幻灯片在源文稿中的当前页码，从 1 起。 */
  number: number;
  /** 幻灯片在源文稿中的持久 ID，调页序时不变。 */
  id: number;
  title: string | null;
}

export interface SearchMatch {
  line: number;
  occurrence: number;
  /** 位置说明：纯文本是行号，文档是「第 N 页」「第 N 段」等。 */
  locator: string;
  /** PPTX 命中才附带幻灯片信息，便于向汇报加入来源页。 */
  slide?: SearchSlide;
  before: string;
  hit: string;
  after: string;
}

export interface SearchFile {
  path: string;
  name: string;
  name_match: boolean;
  matches: SearchMatch[];
  more: boolean;
}

/** Word、Excel、PowerPoint、PDF 正文索引的覆盖情况。 */
export interface DocStats {
  total: number;
  indexed: number;
  failed: number;
  no_text: number;
  running: boolean;
  /** 工作区较大，没有自动建立索引，等用户手动触发。 */
  deferred: boolean;
}

export interface SearchResult {
  files: SearchFile[];
  truncated: boolean;
  /** 文件列表扫描被文件数上限打断，列表之外的文件夹没有参与搜索。 */
  scan_incomplete: boolean;
  docs: DocStats;
  /** 现场遍历超时，需要先在后台扫描文件夹；本次没有搜索结果。 */
  needs_scan: boolean;
  /** 使用的是大工作区缓存的文件列表。 */
  large: boolean;
  /** 参与搜索的文件总数。 */
  file_count: number;
  /** 使用缓存文件列表时，这份列表是多少秒前扫描的。 */
  scan_age_seconds: number;
}

/** 文档索引进度，来自后端的 search-index 事件。 */
export interface IndexProgress {
  root: string;
  /** scan：扫描文件夹，done 是已发现的文件数；index：解析文档。 */
  phase: "scan" | "index";
  done: number;
  total: number;
  failed: number;
  running: boolean;
}

/**
 * 在后台扫描文件夹并建立或增量更新正文索引。已有任务在运行时立即返回。
 * 大工作区默认只扫描、不建索引；manual 为真时才建立。refresh 为真时强制重新扫描文件列表。
 */
export function indexWorkspace(root: string, manual = false, refresh = false): Promise<void> {
  return invoke<void>("index_workspace", { root, manual, refresh });
}

/** 在工作区中搜索，不区分大小写。mode 见 settings/schema 的 SEARCH_MODES。 */
export function searchWorkspace(root: string, query: string, mode: string): Promise<SearchResult> {
  return invoke<SearchResult>("search_workspace", { root, query, mode });
}

/** 把粘贴的图片数据保存到文档旁的 assets/，返回相对于文档目录的路径。 */
export function storeImage(document: string, data: Uint8Array, extension: string): Promise<string> {
  return invoke<string>("store_image", { document, data: Array.from(data), extension });
}

/** 导入本地图片，当前 assets 内的文件直接复用，返回相对于文档目录的路径。 */
export function importImage(document: string, source: string): Promise<string> {
  return invoke<string>("import_image", { document, source });
}

export interface ImageRenameDocument {
  path: string;
  content: string;
}

export interface ImageReferenceChange extends ImageRenameDocument {
  original: string;
}

/** 完整读取工作区 Markdown，并补上跨工作区的已打开页签。 */
export function imageRenameDocuments(root: string, extraPaths: string[]): Promise<ImageRenameDocument[]> {
  return invoke<ImageRenameDocument[]>("image_rename_documents", { root, extraPaths });
}

/** 保留图片扩展名，改名并同步核对过的文档引用；冲突或写入失败时恢复。 */
export function renameImageWithReferences(document: string, source: string, newStem: string, changes: ImageReferenceChange[]): Promise<string> {
  return invoke<string>("rename_image_with_references", { document, source, newStem, changes });
}

export function readText(path: string): Promise<string> {
  return invoke<string>("read_text", { path });
}

export function writeText(path: string, content: string): Promise<void> {
  return invoke<void>("write_text", { path, content });
}

/** 内置 Word 模板（我的文档模板）的路径。 */
export function builtinTemplate(): Promise<string> {
  return invoke<string>("builtin_template");
}

export function openPath(path: string): Promise<void> {
  return invoke<void>("open_path", { path });
}

export interface DocflowOptions {
  /** 经标准输入传给 docflow 的 JSON。 */
  input?: unknown;
  /** 任务 id，传给 cancelDocflow 可结束进程。 */
  job?: string;
  /** 本次会话的 API Key，只经环境变量传给子进程。 */
  apiKey?: string;
}

interface DocflowFailure {
  status: "error";
  message: string;
}

let jobCounter = 0;

export function newJobId(prefix: string): string {
  jobCounter += 1;
  return `${prefix}-${Date.now()}-${jobCounter}`;
}

/** 运行一次 docflow 子命令并解析 JSON 结果。status 为 error 时抛出其消息。 */
export async function docflow<T>(args: string[], options: DocflowOptions = {}): Promise<T> {
  const job = options.job ?? newJobId("docflow");
  const input = options.input === undefined ? null : JSON.stringify(options.input);
  const output = await invoke<string>("docflow_run", {
    job,
    args,
    input,
    apiKey: options.apiKey ?? null,
  });
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error(`docflow 返回了无法识别的结果：${output}`);
  }
  const failure = result as DocflowFailure;
  if (failure && failure.status === "error") {
    throw new Error(failure.message);
  }
  return result as T;
}

export interface StreamHandle {
  job: string;
  /** 结束时以最后一行 JSON 解析结果兑现；进程被取消时以「已取消。」拒绝。 */
  done: Promise<unknown>;
}

/**
 * 运行逐行输出 JSON 的 docflow 子命令（如 chat），每行解析后交给 onLine。
 * 某行为 {"status": "error"} 时，done 以其消息拒绝。
 */
export function docflowStream(args: string[], onLine: (value: unknown) => void, options: DocflowOptions = {}): StreamHandle {
  const job = options.job ?? newJobId("stream");
  const input = options.input === undefined ? null : JSON.stringify(options.input);
  const channel = new Channel<string>();
  let failure: string | null = null;
  channel.onmessage = (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const error = value as DocflowFailure;
    if (error && error.status === "error") {
      failure = error.message;
      return;
    }
    onLine(value);
  };
  const done = invoke<string>("docflow_stream", {
    job,
    args,
    input,
    apiKey: options.apiKey ?? null,
    onLine: channel,
  }).then((last) => {
    if (failure) {
      throw new Error(failure);
    }
    return JSON.parse(last) as unknown;
  });
  return { job, done };
}

export function createDir(path: string): Promise<void> {
  return invoke<void>("create_dir", { path });
}

export function removeMarkdown(path: string): Promise<void> {
  return invoke<void>("remove_markdown", { path });
}

/** 文件或文件夹的属性（DC-064）。时间为 Unix 毫秒。 */
export interface FileProperties {
  name: string;
  path: string;
  folder: string;
  is_dir: boolean;
  extension: string;
  size: number;
  files: number;
  folders: number;
  /** 文件夹太大，统计中途停止，数字只是下限。 */
  partial: boolean;
  created: number | null;
  modified: number | null;
  accessed: number | null;
  readonly: boolean;
}

export function fileProperties(path: string): Promise<FileProperties> {
  return invoke<FileProperties>("file_properties", { path });
}

/** 复制到目标文件夹，重名时自动改名，返回新路径。 */
export function copyEntry(source: string, targetDir: string): Promise<string> {
  return invoke<string>("copy_entry", { source, targetDir });
}

/** 移动到目标文件夹，重名时自动改名，返回新路径。 */
export function moveEntry(source: string, targetDir: string): Promise<string> {
  return invoke<string>("move_entry", { source, targetDir });
}

/** 移入回收站。 */
export function trashEntry(path: string): Promise<void> {
  return invoke<void>("trash_entry", { path });
}

/** 重命名（留在原文件夹），返回新路径。已有同名条目时报错，不覆盖（DC-069）。 */
export function renameEntry(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_entry", { path, newName });
}

/** 在文件资源管理器中定位：文件夹直接打开，文件打开所在文件夹并选中（DC-069）。 */
export function revealEntry(path: string): Promise<void> {
  return invoke<void>("reveal_entry", { path });
}

/** 系统剪贴板上的文件列表；cut 为 true 表示剪切（粘贴时移动）。 */
export interface ClipboardFiles {
  paths: string[];
  cut: boolean;
}

/** 把文件或文件夹写入系统剪贴板，资源管理器等其他程序也能粘贴（DC-069）。 */
export function clipboardWriteFiles(paths: string[], cut: boolean): Promise<void> {
  return invoke<void>("clipboard_write_files", { paths, cut });
}

/** 读取系统剪贴板中的文件列表，没有文件时 paths 为空。 */
export function clipboardReadFiles(): Promise<ClipboardFiles> {
  return invoke<ClipboardFiles>("clipboard_read_files");
}

/** 读取原生剪贴板中的文本和 HTML，菜单粘贴也可读取单独的图片。 */
export function clipboardReadEditor(includeImage: boolean): Promise<{
  text: string;
  html: string;
  image: { mime: string; bytes: number[] } | null;
}> {
  return invoke("clipboard_read_editor", { includeImage });
}

/** 一次写入富文本与纯文本，供编辑区右键复制和剪切使用。 */
export function clipboardWriteEditor(html: string, text: string): Promise<void> {
  return invoke<void>("clipboard_write_editor", { html, text });
}

/** 清空系统剪贴板。 */
export function clipboardClear(): Promise<void> {
  return invoke<void>("clipboard_clear");
}

/** 搜索结果预览中的一个命中块（DC-066）。 */
export interface PreviewBlock {
  locator: string;
  /** Markdown 标题级别 1～6，不是标题为 0。 */
  heading_level: number;
  context_before: string;
  text: string;
  /** 命中文字在 text 中的范围：[起始字符序号, 字符数]。 */
  ranges: [number, number][];
  cut_start: boolean;
  cut_end: boolean;
  context_after: string;
}

export interface FilePreview {
  path: string;
  name: string;
  /** markdown、text、docx、xlsx、pptx、pdf 或 other。 */
  kind: string;
  size: number;
  name_ranges: [number, number][];
  blocks: PreviewBlock[];
  total_hits: number;
  truncated: boolean;
  /** 无法显示正文的原因。 */
  note: string;
}

export function previewFile(path: string, query: string, mode: string): Promise<FilePreview> {
  return invoke<FilePreview>("preview_file", { path, query, mode });
}

export function cancelDocflow(job: string): Promise<void> {
  return invoke<void>("docflow_cancel", { job });
}

/** 统一把 invoke 抛出的字符串或 Error 转成可显示的文字。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
