/** 编辑器配图的 sidecar 协议、浏览器排版和单图复核。 */

import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { docflow, errorText } from "../../backend";
import { FigureView, type FigureReport } from "./FigureView";
import { figureToPng } from "./exportFigure";
import type { FigureSpec } from "./spec";

export const FIGURE_LAYOUTS = {
  auto: "由原文决定",
  layers: "上下分层",
  pipeline: "三段管线",
  lanes: "阶段泳道",
  sidebar: "主干加侧栏",
  loop: "底部闭环",
} as const;

export type FigureLayout = keyof typeof FIGURE_LAYOUTS;

export interface FigurePlacement {
  title: string;
  anchor: number;
  placement: "missing" | "new";
  evidence_ranges: { start: number; end: number }[];
  layout: FigureLayout;
}

export interface FigureCandidate {
  id: number;
  diagram: FigurePlacement | null;
  width?: number;
  height?: number;
  anchorText?: string;
  evidencePreview?: { id: number; text: string }[];
  spec?: FigureSpec;
  error?: string;
  warning?: string;
  png?: string;
  report?: FigureReport;
  selected?: boolean;
  revision?: number;
}

export interface FigureAnalysis {
  digest: string;
  plan: unknown;
  candidates: FigureCandidate[];
}

export interface FigureSession {
  source: string;
  digest: string;
  apiKey: string;
  monochrome: boolean;
  visualReview: boolean;
  figureModel: string;
  reviewModel: string;
  connection: { provider: string; endpoint: string };
}

interface FigureChange {
  layout?: FigureLayout;
  feedback?: string;
  spec?: FigureSpec;
  png?: string;
}

interface FigureRevision {
  status: "ok" | "pass" | "revise";
  spec?: FigureSpec;
  reason?: string;
}

export function figureStage<T>(source: string, stage: string, input: object, apiKey?: string): Promise<T> {
  return docflow<T>(["illustrate", "--source", source, "--stage", stage], { input, apiKey });
}

export function refineFigure(
  session: FigureSession, candidate: FigureCandidate, stage: "generate" | "review" | "validate", change: FigureChange,
): Promise<FigureRevision> {
  const payload = {
    digest: session.digest,
    diagram: candidate.diagram,
    figureModel: session.figureModel,
    reviewModel: session.reviewModel,
    connection: session.connection,
    ...change,
  };
  return figureStage(session.source, stage, payload, session.apiKey);
}

/** 挂载到布局树中测量并导出，预览使用同一张 PNG。 */
async function renderFigure(spec: FigureSpec, maxHeight: number, monochrome: boolean) {
  const host = document.createElement("div");
  host.className = "dc-figure-render-host";
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);
  const element = createRef<HTMLDivElement>();
  let rejectRender: (error: unknown) => void = () => {};
  const tree = createRoot(host, { onUncaughtError: (error) => rejectRender(error) });
  let timeout = 0;
  try {
    const report = await new Promise<FigureReport>((resolve, reject) => {
      rejectRender = reject;
      timeout = window.setTimeout(() => reject(new Error("等待配图排版超时。")), 15000);
      tree.render(<FigureView spec={spec} maxHeight={maxHeight} monochrome={monochrome} rootRef={element} onReport={resolve} />);
    });
    const png = report.fits && element.current ? await figureToPng(element.current) : undefined;
    return { report, png };
  } finally {
    window.clearTimeout(timeout);
    tree.unmount();
    host.remove();
  }
}

export async function rasterizeCandidate(session: FigureSession, candidate: FigureCandidate): Promise<FigureCandidate> {
  if (!candidate.spec || !candidate.height) {
    return candidate;
  }
  try {
    const rendered = await renderFigure(candidate.spec, candidate.height, session.monochrome);
    return { ...candidate, ...rendered, error: rendered.png ? undefined : rendered.report.warnings.join("；") };
  } catch (error) {
    return { ...candidate, png: undefined, error: errorText(error) };
  }
}

/** 本地排版失败时用反馈重新生成一次。视觉复核最多两轮，保留最近一张合格的预览。 */
export async function prepareCandidate(
  session: FigureSession, candidate: FigureCandidate, signal: AbortSignal,
): Promise<FigureCandidate> {
  if (!candidate.spec || signal.aborted) {
    return candidate;
  }
  let current = await rasterizeCandidate(session, candidate);
  if (!current.png && !signal.aborted) {
    try {
      const revised = await refineFigure(session, current, "generate", { spec: current.spec, feedback: current.error });
      current = await rasterizeCandidate(session, { ...current, spec: revised.spec });
    } catch (error) {
      return { ...current, error: `${current.error ?? "排版失败"}；调整失败：${errorText(error)}` };
    }
  }
  if (!session.visualReview || !current.png) {
    return current;
  }
  for (let round = 0; round < 2 && !signal.aborted; round += 1) {
    try {
      const reviewed = await refineFigure(session, current, "review", { spec: current.spec, png: current.png });
      if (reviewed.status === "pass") {
        return { ...current, warning: "视觉复核通过" };
      }
      const revised = await rasterizeCandidate(session, { ...current, spec: reviewed.spec });
      if (!revised.png) {
        return { ...current, warning: `保留原预览。视觉复核建议：${reviewed.reason}。调整稿未通过排版检查。` };
      }
      current = { ...revised, warning: `已按视觉复核建议调整：${reviewed.reason}` };
    } catch (error) {
      return { ...current, warning: `视觉复核失败，保留当前预览：${errorText(error)}` };
    }
  }
  return current;
}
