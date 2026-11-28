import { useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { docflowStream, errorText, revealEntry } from "../../backend";
import { joinPath, safeFileName } from "../../paths";
import type { DeckDraft } from "./deckDraft";
import { queueDeckOfficeJob } from "./deckSource";

type ExportStage = "queued" | "resolve" | "layout" | "open_source" | "copy" | "verify";

interface ExportProgress {
  status: "progress";
  stage: ExportStage;
  done: number;
  total: number;
  name?: string;
}

interface ExportResult {
  status: "ok";
  output: string;
  layout: string;
  engine: string;
  warnings: string[];
}

const STAGE_LABELS: Record<ExportStage, string> = {
  queued: "正在准备导出，等待现有预览任务释放演示软件…",
  resolve: "正在核对草稿和来源素材…",
  layout: "正在套用单位模板…",
  open_source: "正在读取历史 PPTX 素材",
  copy: "正在复制原生素材",
  verify: "正在核对已保存的对象类型和图表数据…",
};

const PPTX_FILTERS = [{ name: "PowerPoint 演示文稿", extensions: ["pptx"] }];

function statusIs(value: unknown, status: string): boolean {
  return typeof value === "object" && value !== null && "status" in value && value.status === status;
}

function progressText(progress: ExportProgress | null): string {
  if (!progress) {
    return "";
  }
  const label = STAGE_LABELS[progress.stage];
  if (progress.stage === "open_source") {
    return progress.name ? `${label} · ${progress.name}` : label;
  }
  if (progress.stage !== "copy") {
    return label;
  }
  return `${label}（${progress.done + 1}/${progress.total}）${progress.name ? ` · ${progress.name}` : ""}`;
}

/** 使用应用现有的保存对话框和 sidecar 流式进度导出草稿。 */
export function useDeckExport(workspace: string | null, draft: DeckDraft, onTemplate: (path: string) => void) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState("");
  const template = draft.template ?? "";
  const hasContent = Boolean(draft.title.trim() || draft.markdown.trim() || draft.assets.length > 0);
  const ready = Boolean(workspace && template && hasContent && !busy);

  const chooseTemplate = async () => {
    try {
      const selected = await open({ title: "选择单位 PPTX 模板", multiple: false, filters: PPTX_FILTERS });
      if (typeof selected === "string") {
        onTemplate(selected);
        setError("");
        setResult(null);
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const start = async () => {
    if (!workspace || !ready || running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const name = safeFileName(draft.title.trim() || "新汇报");
      const output = await save({
        title: "保存为新的 PPTX",
        filters: PPTX_FILTERS,
        defaultPath: joinPath(workspace, `${name}.pptx`),
      });
      if (!output) {
        return;
      }
      const args = ["deck-export", "--template", template, "--output", output];
      setProgress({ status: "progress", stage: "queued", done: 0, total: draft.assets.length });
      const report = await queueDeckOfficeJob(() => {
        const exportJob = docflowStream(args, (value) => {
          if (statusIs(value, "progress")) {
            setProgress(value as ExportProgress);
          }
        }, { input: { title: draft.title, markdown: draft.markdown, assets: draft.assets } });
        return exportJob.done;
      });
      if (!statusIs(report, "ok")) {
        throw new Error("导出没有返回有效的 PPTX 文件。");
      }
      setResult(report as ExportResult);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setProgress(null);
      setBusy(false);
      running.current = false;
    }
  };

  const showOutput = async () => {
    if (!result) {
      return;
    }
    try {
      await revealEntry(result.output);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  return { busy, ready, template, result, error, progress: progressText(progress), chooseTemplate, start, showOutput };
}
