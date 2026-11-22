/**
 * 文档媒体压缩（DC-073）的任务状态。
 *
 * 状态放在 store 而不是对话框组件里：关闭对话框不会中断后台任务，重新打开仍能看到进度。
 * 任务通过 `docflow compress` 流式运行，每行 JSON 是一条进度事件；取消时由 Rust 结束整棵进程树。
 */

import { create } from "zustand";
import { cancelDocflow, docflowStream, errorText } from "../../backend";
import { formatSizeShort } from "../../format";
import { useAppStore } from "../../store";

export type CompressPhase = "idle" | "running" | "done" | "failed" | "cancelled";

export interface CompressFile {
  name: string;
  kind: "video" | "jpeg" | "png";
  status: "replaced" | "kept";
  reason: string;
  method: string;
  before: number;
  after: number;
}

export interface CompressResult {
  source: string;
  /** 没有任何可压缩内容时为 null，此时不生成文件。 */
  target: string | null;
  before_bytes: number;
  after_bytes: number;
  replaced: number;
  kept: number;
  seconds: number;
  warnings: string[];
  files: CompressFile[];
}

interface ProgressEvent {
  type: "start" | "file" | "progress" | "file_done" | "done";
  media_count?: number;
  index?: number;
  count?: number;
  name?: string;
  kind?: string;
  fraction?: number;
  overall?: number;
}

const CANCELLED_MESSAGE = "已取消。";

interface CompressState {
  source: string;
  video: boolean;
  image: boolean;
  phase: CompressPhase;
  job: string;
  /** 0 到 1，按媒体体积加权的总进度。 */
  overall: number;
  currentName: string;
  currentKind: string;
  currentIndex: number;
  currentCount: number;
  currentFraction: number;
  files: CompressFile[];
  result: CompressResult | null;
  message: string;
  setSource: (source: string) => void;
  setVideo: (value: boolean) => void;
  setImage: (value: boolean) => void;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

const IDLE_PROGRESS = {
  overall: 0,
  currentName: "",
  currentKind: "",
  currentIndex: 0,
  currentCount: 0,
  currentFraction: 0,
  files: [] as CompressFile[],
  result: null as CompressResult | null,
  message: "",
};

export const useCompress = create<CompressState>((set, get) => ({
  source: "",
  video: true,
  image: true,
  phase: "idle",
  job: "",
  ...IDLE_PROGRESS,
  setSource: (source) => set({ source, phase: "idle", ...IDLE_PROGRESS }),
  setVideo: (video) => set({ video }),
  setImage: (image) => set({ image }),
  reset: () => set({ phase: "idle", job: "", ...IDLE_PROGRESS }),

  start: async () => {
    const { source, video, image, phase } = get();
    if (phase === "running" || !source || (!video && !image)) {
      return;
    }
    set({ phase: "running", ...IDLE_PROGRESS });
    const setStatus = useAppStore.getState().setStatus;
    const onLine = (value: unknown) => {
      const event = value as ProgressEvent;
      if (event.type === "start") {
        set({ currentCount: event.media_count ?? 0 });
      } else if (event.type === "file") {
        set({
          currentName: event.name ?? "",
          currentKind: event.kind ?? "",
          currentIndex: event.index ?? 0,
          currentCount: event.count ?? 0,
          currentFraction: 0,
        });
      } else if (event.type === "progress") {
        set({ currentFraction: event.fraction ?? 0, overall: event.overall ?? get().overall });
      } else if (event.type === "file_done") {
        const record = value as CompressFile & { overall?: number };
        set((state) => ({ files: [...state.files, record], overall: record.overall ?? state.overall, currentFraction: 1 }));
      }
      setStatus(`正在压缩文档媒体：${Math.round(get().overall * 100)}%`);
    };
    try {
      const handle = docflowStream(["compress", "--source", source], onLine, { input: { video, image } });
      set({ job: handle.job });
      const result = (await handle.done) as CompressResult;
      set({ phase: "done", job: "", result, overall: 1 });
      setStatus(
        result.target
          ? `媒体压缩完成：${formatSizeShort(result.before_bytes)} → ${formatSizeShort(result.after_bytes)}`
          : "媒体压缩完成：没有可压缩的内容",
      );
    } catch (error) {
      const text = errorText(error);
      if (text === CANCELLED_MESSAGE) {
        set({ phase: "cancelled", job: "", message: "已取消，没有生成文件。" });
        setStatus("媒体压缩已取消");
      } else {
        set({ phase: "failed", job: "", message: text });
        setStatus("媒体压缩失败");
      }
    }
  },

  cancel: async () => {
    const { job, phase } = get();
    if (phase !== "running" || !job) {
      return;
    }
    await cancelDocflow(job);
  },
}));
