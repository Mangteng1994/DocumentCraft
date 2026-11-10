/**
 * 前端调用 Tauri 命令与 docflow sidecar 的入口。
 */

import { Channel, invoke } from "@tauri-apps/api/core";

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[];
}

/** showAll 为真时列出全部文件和空文件夹，否则只列 Markdown。 */
export function listTree(root: string, showAll = false): Promise<TreeNode> {
  return invoke<TreeNode>("list_tree", { root, showAll });
}

/** 在目录下新建空 Markdown 文件，返回路径；同名文件已存在时抛错。 */
export function createMarkdown(directory: string, name: string): Promise<string> {
  return invoke<string>("create_markdown", { directory, name });
}

/** 在目录下新建文件夹，返回路径；同名条目已存在时抛错。 */
export function createFolder(directory: string, name: string): Promise<string> {
  return invoke<string>("create_folder", { directory, name });
}

export interface SearchMatch {
  line: number;
  occurrence: number;
  /** 位置说明：纯文本是行号，文档是「第 N 页」「第 N 段」等。 */
  locator: string;
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
}

export interface SearchResult {
  files: SearchFile[];
  truncated: boolean;
  docs: DocStats;
}

/** 文档索引进度，来自后端的 search-index 事件。 */
export interface IndexProgress {
  root: string;
  done: number;
  total: number;
  failed: number;
  running: boolean;
}

/** 在后台建立或增量更新文档正文索引。已有任务在运行时立即返回。 */
export function indexWorkspace(root: string): Promise<void> {
  return invoke<void>("index_workspace", { root });
}

/** 在工作区中搜索，不区分大小写。mode 见 settings/schema 的 SEARCH_MODES。 */
export function searchWorkspace(root: string, query: string, mode: string): Promise<SearchResult> {
  return invoke<SearchResult>("search_workspace", { root, query, mode });
}

/** 把粘贴的图片数据保存到文档旁的 assets/，返回相对于文档目录的路径。 */
export function storeImage(document: string, data: Uint8Array, extension: string): Promise<string> {
  return invoke<string>("store_image", { document, data: Array.from(data), extension });
}

/** 把本地图片复制到文档旁的 assets/，返回相对于文档目录的路径。 */
export function importImage(document: string, source: string): Promise<string> {
  return invoke<string>("import_image", { document, source });
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
