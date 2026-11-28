import { useEffect, useState } from "react";
import { docflowStream, errorText } from "../../backend";

export type DeckAssetKind = "image" | "chart" | "table" | "group" | "text";

export const DECK_ASSET_LABELS: Record<DeckAssetKind, string> = {
  image: "图片",
  chart: "图表",
  table: "表格",
  group: "组合",
  text: "文字",
};

/** 源对象坐标是相对于原页的比例，属于文稿数据。 */
export interface SlideBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  rotation: number;
}

export interface SourceAsset {
  shape_id: number;
  kind: DeckAssetKind;
  name: string;
  summary: string;
  text?: string;
  bounds: SlideBounds | null;
  fingerprint: string;
}

export interface SlideSource {
  status: "assets";
  path: string;
  slide_id: number;
  number: number;
  width: number;
  height: number;
  revision: string;
  assets: SourceAsset[];
}

interface SlideRender {
  status: "ok";
  png: string | null;
  warning: string;
}

interface SlidePreviewState {
  source: SlideSource | null;
  png: string | null;
  warning: string;
  error: string;
  loading: boolean;
}

const INITIAL: SlidePreviewState = {
  source: null,
  png: null,
  warning: "",
  error: "",
  loading: true,
};

function hasStatus(value: unknown, status: string): boolean {
  return typeof value === "object" && value !== null && "status" in value && value.status === status;
}

// 部分 COM 服务会复用同一进程，预览和导出串行使用演示软件。
let pendingOfficeJob: Promise<void> = Promise.resolve();

/** 在当前演示软件任务释放文稿后再运行下一项。 */
export function queueDeckOfficeJob<T>(task: () => Promise<T>): Promise<T> {
  const next = pendingOfficeJob.then(task);
  pendingOfficeJob = next.then(() => undefined, () => undefined);
  return next;
}

/** 读取当前页的素材清单和原页图像，丢弃已切走页面的结果。 */
export function useSlideSource(path: string, slideId: number, attempt: number): SlidePreviewState {
  const [state, setState] = useState(INITIAL);
  useEffect(() => {
    let current = true;
    setState(INITIAL);
    const request = async () => {
      if (!current) {
        return;
      }
      try {
        const args = ["deck-preview", "--source", path, "--slide-id", String(slideId)];
        const preview = docflowStream(args, (event) => {
          if (current && hasStatus(event, "assets")) {
            setState((previous) => ({ ...previous, source: event as SlideSource }));
          }
        });
        const result = await preview.done;
        if (current) {
          if (!hasStatus(result, "ok")) {
            throw new Error("无法识别旧页预览结果。");
          }
          const { png, warning } = result as SlideRender;
          setState((previous) => ({ ...previous, png, warning, loading: false }));
        }
      } catch (reason) {
        if (current) {
          setState({ ...INITIAL, error: errorText(reason), loading: false });
        }
      }
    };
    void queueDeckOfficeJob(request);
    return () => {
      current = false;
    };
  }, [path, slideId, attempt]);
  return state;
}
