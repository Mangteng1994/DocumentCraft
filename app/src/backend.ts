/**
 * 前端调用 Tauri 命令与 docflow sidecar 的入口。
 */

import { invoke } from "@tauri-apps/api/core";

export interface TreeNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeNode[];
}

export function listTree(root: string): Promise<TreeNode> {
  return invoke<TreeNode>("list_tree", { root });
}

export function readText(path: string): Promise<string> {
  return invoke<string>("read_text", { path });
}

export function writeText(path: string, content: string): Promise<void> {
  return invoke<void>("write_text", { path, content });
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
