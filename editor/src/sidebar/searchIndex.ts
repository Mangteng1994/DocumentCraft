/**
 * 文档正文索引的前端接入：监听后端的进度事件，并在需要时启动索引。
 *
 * 搜索 Word、Excel、PowerPoint、PDF 的正文依赖后端在后台建立的文本索引。第一次打开搜索时先扫描文件夹、
 * 再建立索引，之后只增量处理新增和修改过的文件。进度（扫描或解析）写入 store，搜索结果据此提示并按节流刷新。
 * 大工作区（网络共享、文件很多）只扫描、不自动建立索引，用户在搜索结果上方点按钮后才建立。
 */

import { listen } from "@tauri-apps/api/event";
import { errorText, indexWorkspace, type IndexProgress } from "../backend";
import { useAppStore } from "../store";

/** 索引进行中，搜索结果最多隔这么久刷新一次，避免每处理几个文件就重新搜索。 */
const REFRESH_INTERVAL_MS = 3000;
const INDEX_EVENT = "search-index";

function samePath(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

/** 监听索引进度事件，返回取消监听的函数。只处理当前工作区的事件。 */
export function listenSearchIndex(): () => void {
  let lastRefresh = 0;
  const unlisten = listen<IndexProgress>(INDEX_EVENT, (event) => {
    const progress = event.payload;
    const store = useAppStore.getState();
    if (!samePath(store.workspace, progress.root)) {
      return;
    }
    const now = Date.now();
    // 结束时一定刷新一次；进行中按间隔节流。
    const refresh = !progress.running || now - lastRefresh >= REFRESH_INTERVAL_MS;
    if (refresh) {
      lastRefresh = now;
    }
    store.setIndexProgress(progress, refresh);
  });
  return () => {
    void unlisten.then((stop) => stop());
  };
}

interface IndexingOptions {
  /** 大工作区也建立文档索引（默认只扫描）。 */
  manual?: boolean;
  /** 强制重新扫描文件列表，不复用缓存。 */
  refresh?: boolean;
}

/** 启动（或增量更新）当前工作区的扫描与文档索引。后端已有任务在运行时直接返回。 */
export async function startIndexing(root: string, options: IndexingOptions = {}): Promise<void> {
  try {
    await indexWorkspace(root, options.manual ?? false, options.refresh ?? false);
  } catch (error) {
    useAppStore.getState().setStatus(`建立文档索引失败：${errorText(error)}`);
  }
}
