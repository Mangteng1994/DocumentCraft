/**
 * 科研配图（DC-035、DC-061）的后台任务状态（DC-076）。
 *
 * 状态放在 store 而不是设置窗口组件里：关闭窗口不会中断分析、排版和复核，重新打开仍能看到进度和已完成的预览。
 * 做法与文档媒体压缩（compressStore）一致。外发确认和文档保存由设置窗口在前台完成，确认后才调用 start。
 * 取消时先中止队列，再结束所有仍在运行的 sidecar 进程。
 */

import { create } from "zustand";
import { cancelDocflow, errorText } from "../../backend";
import { ensureSaved, refreshTree } from "../../documentActions";
import { useAppStore } from "../../store";
import {
  figureStage, prepareCandidate, rasterizeCandidate, refineFigure,
  type FigureAnalysis, type FigureCandidate, type FigureSession,
} from "./workflow";
import type { FigureLayout, FigureSpec } from "./spec";

export type FigurePhase =
  | "idle" | "planning" | "preparing" | "revising" | "ready" | "committing" | "cancelled" | "failed";

export interface IllustrateResult {
  output: string;
  review: string;
  images: number;
  issues: number;
}

export interface FigureAnalysisSession {
  session: FigureSession;
  analysis: FigureAnalysis;
}

/** 开始任务时固定下来的设置，运行中修改设置不影响本次任务。 */
export interface FigureStartInput {
  source: string;
  apiKey: string;
  connection: { provider: string; endpoint: string };
  monochrome: boolean;
  visualReview: boolean;
  plannerModel: string;
  figureModel: string;
  reviewModel: string;
}

export interface FigureChange {
  layout?: FigureLayout;
  spec?: FigureSpec;
}

/** 同时排版、复核的候选图数量。 */
const PREPARE_WORKERS = 3;

const ACTIVE_PHASES: FigurePhase[] = ["planning", "preparing", "revising", "committing"];

export function isFigureActive(phase: FigurePhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

/** 任务可以取消的阶段。写入文件的阶段很短，不提供取消。 */
export function isFigureCancellable(phase: FigurePhase): boolean {
  return phase === "planning" || phase === "preparing" || phase === "revising";
}

interface FigureState {
  phase: FigurePhase;
  source: string;
  current: FigureAnalysisSession | null;
  selectedId: number | undefined;
  /** done 为已处理完的候选图数，total 为有规格、需要排版的候选图数。 */
  progress: { done: number; total: number };
  busyText: string;
  message: string;
  result: IllustrateResult | null;
  controller: AbortController | null;
  jobs: Set<string>;
  runId: number;
  start: (input: FigureStartInput) => Promise<void>;
  cancel: () => Promise<void>;
  select: (id: number) => void;
  setChecked: (id: number, checked: boolean) => void;
  revise: (candidate: FigureCandidate, change: FigureChange) => Promise<void>;
  commit: (currentFilePath: string | null) => Promise<void>;
  setMessage: (message: string) => void;
  reset: () => void;
}

const IDLE = {
  phase: "idle" as FigurePhase,
  current: null as FigureAnalysisSession | null,
  selectedId: undefined as number | undefined,
  progress: { done: 0, total: 0 },
  busyText: "",
  message: "",
  result: null as IllustrateResult | null,
};

function setStatus(text: string): void {
  useAppStore.getState().setStatus(text);
}

/** 用新候选图替换同编号的旧候选图。 */
function withCandidate(current: FigureAnalysisSession | null, next: FigureCandidate): FigureAnalysisSession | null {
  if (!current) {
    return current;
  }
  const candidates = current.analysis.candidates.map((item) => item.id === next.id ? next : item);
  return { ...current, analysis: { ...current.analysis, candidates } };
}

export const useFigureJob = create<FigureState>((set, get) => {
  /** 并行排版和复核候选图，每完成一张就写回 store 并推进进度。 */
  const prepareAll = async (
    session: FigureSession, candidates: FigureCandidate[], signal: AbortSignal, runId: number,
  ): Promise<void> => {
    const queue = candidates.filter((candidate) => candidate.spec);
    const total = queue.length;
    const worker = async () => {
      while (queue.length > 0 && !signal.aborted) {
        const candidate = queue.shift();
        if (!candidate) {
          break;
        }
        const ready = await prepareCandidate(session, candidate, signal);
        if (signal.aborted || get().runId !== runId) {
          return;
        }
        const next = { ...ready, selected: Boolean(ready.png) };
        const done = get().progress.done + 1;
        set((state) => ({ current: withCandidate(state.current, next), progress: { done, total } }));
        setStatus(`科研配图：已完成 ${done}/${total}`);
      }
    };
    const count = Math.min(queue.length, PREPARE_WORKERS);
    await Promise.all(Array.from({ length: count }, worker));
  };

  return {
    ...IDLE,
    source: "",
    controller: null,
    jobs: new Set<string>(),
    runId: 0,

    setMessage: (message) => set({ message }),
    select: (selectedId) => set({ selectedId, message: "" }),
    reset: () => set({ ...IDLE, controller: null }),
    setChecked: (id, checked) => {
      const candidate = get().current?.analysis.candidates.find((item) => item.id === id);
      if (candidate) {
        set((state) => ({ current: withCandidate(state.current, { ...candidate, selected: checked }) }));
      }
    },

    start: async (input) => {
      if (isFigureActive(get().phase)) {
        return;
      }
      const controller = new AbortController();
      const signal = controller.signal;
      const jobs = new Set<string>();
      const runId = get().runId + 1;
      set({
        ...IDLE, phase: "planning", source: input.source, busyText: "正在规划图位并生成单图规格…",
        controller, jobs, runId,
      });
      setStatus("科研配图：正在规划图位");
      try {
        const analysis = await figureStage<FigureAnalysis>(input.source, "plan", {
          connection: input.connection, plannerModel: input.plannerModel, figureModel: input.figureModel,
        }, input.apiKey, jobs);
        if (signal.aborted || get().runId !== runId) {
          return;
        }
        const session: FigureSession = {
          source: input.source, digest: analysis.digest, apiKey: input.apiKey, connection: input.connection,
          monochrome: input.monochrome, visualReview: input.visualReview,
          figureModel: input.figureModel, reviewModel: input.reviewModel, jobs,
        };
        const total = analysis.candidates.filter((candidate) => candidate.spec).length;
        set({
          phase: "preparing",
          current: { analysis, session },
          selectedId: analysis.candidates[0]?.id,
          progress: { done: 0, total },
          busyText: input.visualReview ? "正在排版和复核候选图…" : "正在排版候选图…",
        });
        await prepareAll(session, analysis.candidates, signal, runId);
        if (signal.aborted || get().runId !== runId) {
          return;
        }
        const ready = get().current?.analysis.candidates.filter((item) => item.selected && item.png).length ?? 0;
        set({ phase: "ready", busyText: "" });
        setStatus(`科研配图完成：${ready} 张可回插，请到「设置 → 科研流程图」查看`);
      } catch (error) {
        if (signal.aborted || get().runId !== runId) {
          return;
        }
        set({ phase: "failed", busyText: "", message: errorText(error) });
        setStatus("科研配图失败");
      }
    },

    cancel: async () => {
      const { phase, controller, jobs } = get();
      if (!isFigureCancellable(phase)) {
        return;
      }
      controller?.abort();
      const pending = Array.from(jobs);
      jobs.clear();
      // 任务可能恰好已结束，结束进程失败不影响取消结果。
      await Promise.all(pending.map((job) => cancelDocflow(job).catch(() => undefined)));
      if (phase === "revising") {
        // 只取消单张图的修订，其余已完成的预览保留。
        set({ phase: "ready", busyText: "", message: "已取消这张图的修订。", runId: get().runId + 1 });
        return;
      }
      set({ ...IDLE, phase: "cancelled", message: "已取消，没有生成文件。", runId: get().runId + 1 });
      setStatus("科研配图已取消");
    },

    revise: async (candidate, change) => {
      const { current } = get();
      if (!current || get().phase !== "ready") {
        return;
      }
      const { session } = current;
      const controller = new AbortController();
      const signal = controller.signal;
      const runId = get().runId + 1;
      const manual = change.spec !== undefined;
      set({
        phase: "revising", controller, runId, message: "",
        busyText: manual ? "正在校验文字并重新排版…" : "正在重新生成这张图…",
      });
      try {
        const response = await refineFigure(session, candidate, manual ? "validate" : "generate", {
          ...change,
          spec: change.spec ?? (change.layout ? candidate.spec : undefined),
        });
        const diagram = candidate.diagram && change.layout ? { ...candidate.diagram, layout: change.layout } : candidate.diagram;
        const revised = { ...candidate, diagram, spec: response.spec, png: undefined, warning: undefined };
        const ready = manual
          ? await rasterizeCandidate(session, revised)
          : await prepareCandidate(session, revised, signal);
        if (signal.aborted || get().runId !== runId) {
          return;
        }
        if (!ready.png && candidate.png) {
          set({ phase: "ready", busyText: "", message: `调整后的图未通过排版检查，已保留原预览。 ${ready.error ?? ""}` });
          return;
        }
        const next = {
          ...ready, selected: Boolean(ready.png) && (candidate.selected ?? true), revision: (candidate.revision ?? 0) + 1,
        };
        set((state) => ({ current: withCandidate(state.current, next), phase: "ready", busyText: "" }));
      } catch (error) {
        if (signal.aborted || get().runId !== runId) {
          return;
        }
        set({ phase: "ready", busyText: "", message: errorText(error) });
      }
    },

    commit: async (currentFilePath) => {
      const { current, phase } = get();
      if (!current || phase !== "ready") {
        return;
      }
      const { analysis, session } = current;
      set({ phase: "committing", message: "", busyText: "正在写入配图版和审核清单…" });
      try {
        if (session.source === currentFilePath && !(await ensureSaved())) {
          set({ phase: "ready", busyText: "", message: "文档未能保存，已取消。" });
          return;
        }
        const images: Record<string, { png: string; spec: FigureSpec }> = {};
        const skipped: Record<string, string> = {};
        const notes: Record<string, string> = {};
        for (const candidate of analysis.candidates) {
          if (candidate.selected && candidate.png && candidate.spec) {
            images[candidate.id] = { png: candidate.png, spec: candidate.spec };
            const advice = candidate.report?.advisories ?? [];
            const adviceText = advice.length > 0 ? `版面建议：${advice.join("；")}` : undefined;
            const note = [candidate.warning, adviceText].filter(Boolean).join("。");
            if (note) {
              notes[candidate.id] = note;
            }
          } else {
            skipped[candidate.id] = candidate.error || "预览后未选择回插";
          }
        }
        const written = await figureStage<IllustrateResult>(session.source, "commit", {
          digest: analysis.digest, plan: analysis.plan, images, skipped, notes,
        });
        set({ phase: "ready", busyText: "", result: written });
        await refreshTree();
        setStatus(`科研配图已回插 ${written.images} 张`);
      } catch (error) {
        set({ phase: "ready", busyText: "", message: errorText(error) });
      }
    },
  };
});
