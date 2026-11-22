/** 设置中的科研配图入口。从图位分析到逐张预览、修订及回插。 */

import { useEffect, useRef, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { errorText, openPath } from "../../backend";
import { ensureSaved, openDocument, refreshTree } from "../../documentActions";
import { fileName } from "../../paths";
import type { FigureStyle } from "../../settings/schema";
import { useSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";
import { figureTokens } from "../../styles/tokens";
import { StatusLine } from "../../components/Dialog";
import { FigureTextEditor } from "../figures/FigureTextEditor";
import { FIGURE_LAYOUTS, type FigureLayout, type FigureSpec } from "../figures/spec";
import {
  figureStage, prepareCandidate, rasterizeCandidate, refineFigure,
  type FigureAnalysis, type FigureCandidate, type FigureSession,
} from "../figures/workflow";
import { aiDestination, loadAiStatus } from "./aiStatus";
import { SettingHeading, SettingItem, Toggle } from "./SettingsModal";

interface IllustrateResult {
  output: string;
  review: string;
  images: number;
  issues: number;
}

interface AnalysisSession {
  session: FigureSession;
  analysis: FigureAnalysis;
}

function titleOf(candidate: FigureCandidate): string {
  return typeof candidate.diagram?.title === "string" ? candidate.diagram.title : `候选图 ${candidate.id}`;
}

/** 在三路浏览器排版及复核任务完成后返回。 */
async function prepareAll(
  session: FigureSession, candidates: FigureCandidate[], signal: AbortSignal,
  onCandidate: (candidate: FigureCandidate) => void,
): Promise<void> {
  const queue = candidates.filter((candidate) => candidate.spec);
  const worker = async () => {
    while (queue.length && !signal.aborted) {
      const candidate = queue.shift();
      if (!candidate) {
        break;
      }
      const ready = await prepareCandidate(session, candidate, signal);
      if (!signal.aborted) {
        onCandidate({ ...ready, selected: Boolean(ready.png) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(queue.length, 3) }, worker));
}

export function FigureSettings() {
  const filePath = useAppStore((state) => state.filePath);
  const apiKey = useAppStore((state) => state.apiKey);
  const setOverlay = useAppStore((state) => state.setOverlay);
  const settings = useSettings((state) => state.settings.figure);
  const update = useSettings((state) => state.update);
  const [pickedSource, setPickedSource] = useState("");
  const [current, setCurrent] = useState<AnalysisSession | null>(null);
  const [selectedId, setSelectedId] = useState<number>();
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<IllustrateResult | null>(null);
  const [message, setMessage] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const source = pickedSource || filePath;
  const candidates = current?.analysis.candidates ?? [];
  const selected = candidates.find((candidate) => candidate.id === selectedId);
  const count = candidates.filter((candidate) => candidate.selected && candidate.png).length;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const replaceCandidate = (next: FigureCandidate) => {
    setCurrent((previous) => {
      if (!previous) {
        return previous;
      }
      const candidates = previous.analysis.candidates.map((candidate) => candidate.id === next.id ? next : candidate);
      return { ...previous, analysis: { ...previous.analysis, candidates } };
    });
  };

  const browse = async () => {
    try {
      const path = await open({
        title: "选择科研报告",
        multiple: false,
        filters: [{ name: "Markdown 或 Word 报告", extensions: ["md", "markdown", "docx", "doc"] }],
      });
      if (typeof path === "string") {
        setPickedSource(path);
      }
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  const start = async () => {
    const signal = lifetime.current?.signal;
    if (!source || !signal || signal.aborted) {
      return;
    }
    setMessage("");
    setBusy("正在准备报告…");
    try {
      const status = await loadAiStatus();
      const extra = settings.visualReview ? "开启视觉复核后，每张合格候选图及其取证段落也会发送，最多两轮。" : "";
      const confirmed = await ask(
        `将报告正文、标题层级、实图位置和引用线索发送到 ${aiDestination(status)}。分图生成只发送相应取证段落。${extra}继续吗？`,
        { title: "提交报告分析", kind: "info", okLabel: "发送", cancelLabel: "取消" },
      );
      if (!confirmed || signal.aborted) {
        return;
      }
      if (source === filePath && !(await ensureSaved())) {
        setMessage("文档未能保存，已取消。");
        return;
      }
      setBusy("正在规划图位并生成单图规格…");
      const connection = { provider: status.provider, endpoint: status.endpoint };
      const analysis = await figureStage<FigureAnalysis>(source, "plan", {
        connection, plannerModel: settings.plannerModel, figureModel: settings.figureModel,
      }, apiKey);
      if (signal.aborted) {
        return;
      }
      const session: FigureSession = {
        source, digest: analysis.digest, apiKey, connection, monochrome: settings.style === "mono",
        visualReview: settings.visualReview, figureModel: settings.figureModel, reviewModel: settings.reviewModel,
      };
      setCurrent({ analysis, session });
      setResult(null);
      setSelectedId(analysis.candidates[0]?.id);
      setBusy(settings.visualReview ? "正在排版和复核候选图…" : "正在排版候选图…");
      await prepareAll(session, analysis.candidates, signal, replaceCandidate);
    } catch (error) {
      if (!signal.aborted) {
        setMessage(errorText(error));
      }
    } finally {
      if (!signal.aborted) {
        setBusy("");
      }
    }
  };

  const revise = async (candidate: FigureCandidate, change: { layout?: FigureLayout; spec?: FigureSpec }) => {
    const signal = lifetime.current?.signal;
    if (!current || !signal || signal.aborted) {
      return;
    }
    const { session } = current;
    const manual = change.spec !== undefined;
    setBusy(manual ? "正在校验文字并重新排版…" : "正在重新生成这张图…");
    setMessage("");
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
      if (signal.aborted) {
        return;
      }
      if (!ready.png && candidate.png) {
        setMessage(`调整后的图未通过排版检查，已保留原预览。 ${ready.error ?? ""}`);
        return;
      }
      replaceCandidate({
        ...ready, selected: Boolean(ready.png) && (candidate.selected ?? true), revision: (candidate.revision ?? 0) + 1,
      });
    } catch (error) {
      if (!signal.aborted) {
        setMessage(errorText(error));
      }
    } finally {
      if (!signal.aborted) {
        setBusy("");
      }
    }
  };

  const commit = async () => {
    if (!current) {
      return;
    }
    const { analysis, session } = current;
    setMessage("");
    setBusy("正在写入配图版和审核清单…");
    try {
      if (session.source === filePath && !(await ensureSaved())) {
        setMessage("文档未能保存，已取消。");
        return;
      }
      const images: Record<string, { png: string; spec: FigureSpec }> = {};
      const skipped: Record<string, string> = {};
      const notes: Record<string, string> = {};
      for (const candidate of analysis.candidates) {
        if (candidate.selected && candidate.png && candidate.spec) {
          images[candidate.id] = { png: candidate.png, spec: candidate.spec };
          const advice = candidate.report?.advisories ?? [];
          const noteParts = [candidate.warning, advice.length ? `版面建议：${advice.join("；")}` : undefined];
          const note = noteParts.filter(Boolean).join("。");
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
      setResult(written);
      await refreshTree();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy("");
    }
  };

  const openResult = async (path: string) => {
    try {
      if (/\.(md|markdown)$/i.test(path)) {
        if (await openDocument(path)) {
          setOverlay(null);
        }
      } else {
        await openPath(path);
      }
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  return (
    <>
      <SettingItem name="源报告" description={source || "打开 Markdown 或选择本地 Word 报告。"}>
        {pickedSource && filePath && <button type="button" className="dc-button" disabled={Boolean(busy)} onClick={() => setPickedSource("")}>使用当前文档</button>}
        <button type="button" className="dc-button" disabled={Boolean(busy)} onClick={() => void browse()}>选择报告…</button>
      </SettingItem>
      <SettingItem name="绘图风格">
        <select
          aria-label="绘图风格" className="dc-input" value={settings.style} disabled={Boolean(busy)}
          onChange={(event) => update("figure", { style: event.target.value as FigureStyle })}
        >
          <option value="colored">按功能分区配色</option>
          <option value="mono">黑白工程图</option>
        </select>
      </SettingItem>
      <details className="dc-figure-details">
        <summary>分阶段模型与视觉复核</summary>
        <p className="dc-setting-note">填写当前 AI 连接支持的模型 ID，留空使用「AI 连接」中保存的模型。</p>
        <SettingItem name="视觉复核" description="将成图和取证段落发送给支持图像输入的模型，最多复核两轮。">
          <Toggle
            label="视觉复核" checked={settings.visualReview} disabled={Boolean(busy)}
            onChange={(visualReview) => update("figure", { visualReview })}
          />
        </SettingItem>
        {([
          ["plannerModel", "图位规划"], ["figureModel", "单图生成"], ["reviewModel", "视觉复核模型"],
        ] as const).map(([key, label]) => (
          <label className="dc-figure-field" key={key}>
            <span>{label}</span>
            <input
              className="dc-input" value={settings[key]} placeholder="使用已连接模型" disabled={Boolean(busy)}
              onChange={(event) => update("figure", { [key]: event.target.value })}
            />
          </label>
        ))}
      </details>
      <div className="dc-figure-actions">
        <button type="button" className={current ? "dc-button" : "dc-button is-primary"} disabled={!source || Boolean(busy)} onClick={() => void start()}>
          {current ? "重新分析报告" : "分析报告"}
        </button>
        {busy && <span className="dc-setting-note" role="status">{busy}</span>}
      </div>
      {message && <StatusLine tone="error" text={message} />}
      {current && (
        <>
          <SettingHeading>配图预览</SettingHeading>
          <p className="dc-setting-note">{fileName(current.session.source)} · {candidates.length} 个候选 · 已选 {count} 张</p>
          {selected && (
            <>
              <label className="dc-figure-field">
                <span>候选图</span>
                <select
                  className="dc-input" value={selected.id}
                  onChange={(event) => { setSelectedId(Number(event.target.value)); setMessage(""); }}
                >
                  {candidates.map((item) => (
                    <option value={item.id} key={item.id}>{item.id}. {titleOf(item)}{item.error ? "（待处理）" : ""}</option>
                  ))}
                </select>
              </label>
              <FigurePreview
                key={selected.id} candidate={selected} busy={Boolean(busy)}
                onSelect={(checked) => replaceCandidate({ ...selected, selected: checked })}
                onRevise={(change) => void revise(selected, change)}
              />
            </>
          )}
          {!candidates.length && <p className="dc-setting-note">分析未找到可生成的候选图。审核清单可查看图位记录。</p>}
          <div className="dc-figure-actions">
            <button type="button" className="dc-button is-primary" disabled={Boolean(busy)} onClick={() => void commit()}>
              {count ? `回插选中的 ${count} 张图` : "保存审核清单"}
            </button>
          </div>
        </>
      )}
      {result && (
        <SettingItem name={`已回插 ${result.images} 张图 · ${result.issues} 项待确认`} description={result.output}>
          <button type="button" className="dc-button" onClick={() => void openResult(result.review)}>审核清单</button>
          <button type="button" className="dc-button" onClick={() => void openResult(result.output)}>打开配图版</button>
        </SettingItem>
      )}
    </>
  );
}

function FigurePreview({ candidate, busy, onSelect, onRevise }: {
  candidate: FigureCandidate;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onRevise: (change: { layout?: FigureLayout; spec?: FigureSpec }) => void;
}) {
  const [layout, setLayout] = useState<FigureLayout>(candidate.diagram?.layout ?? "auto");
  const [actualSize, setActualSize] = useState(false);
  const diagram = candidate.diagram;
  const ranges = Array.isArray(diagram?.evidence_ranges)
    ? diagram.evidence_ranges.filter((range) => range && Number.isInteger(range.start) && Number.isInteger(range.end))
    : [];
  const editable = Boolean(diagram && candidate.height);
  const printWidth = Math.round((candidate.report?.widthPt ?? figureTokens.width) * figureTokens.pxPerPt);
  return (
    <div className="dc-figure-candidate">
      {candidate.png && (
        <figure className="dc-figure-preview">
          <img
            src={candidate.png} alt={titleOf(candidate)} width={printWidth}
            className={actualSize ? "is-actual-size" : undefined}
          />
          <figcaption className="dc-setting-note dc-figure-actions">
            <span>{candidate.report?.widthPt.toFixed(0)} × {candidate.report?.heightPt.toFixed(0)} pt</span>
            <button type="button" className="dc-button" onClick={() => setActualSize(!actualSize)}>
              {actualSize ? "适应窗口" : "按版心尺寸查看"}
            </button>
          </figcaption>
        </figure>
      )}
      {candidate.error && <StatusLine tone="error" text={candidate.error} />}
      {candidate.warning && <p className="dc-setting-note">{candidate.warning}</p>}
      {candidate.png && candidate.report?.advisories.length ? (
        <p className="dc-setting-note">版面建议：{candidate.report.advisories.join("；")}</p>
      ) : null}
      {candidate.anchorText && (
        <details className="dc-figure-details">
          <summary>{diagram?.placement === "missing" ? "补缺图" : "新增图"} · 段落 {diagram?.anchor} 后 · 取证 {ranges.map(({ start, end }) => start === end ? start : `${start}–${end}`).join("、")}</summary>
          <p className="dc-setting-note">插入位置 · {candidate.anchorText}</p>
          {candidate.evidencePreview?.map(({ id, text }) => <p key={id} className="dc-setting-note">段落 {id} · {text}</p>)}
        </details>
      )}
      {editable && (
        <div className="dc-figure-actions">
          <label className="dc-figure-check">
            <input type="checkbox" checked={Boolean(candidate.selected)} disabled={busy || !candidate.png} onChange={(event) => onSelect(event.target.checked)} />
            回插这张图
          </label>
          <select aria-label="调整版式" className="dc-input" value={layout} disabled={busy} onChange={(event) => setLayout(event.target.value as FigureLayout)}>
            {Object.entries(FIGURE_LAYOUTS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select>
          <button type="button" className="dc-button" disabled={busy || layout === diagram?.layout} onClick={() => onRevise({ layout })}>应用版式</button>
          <button type="button" className="dc-button" disabled={busy} onClick={() => onRevise({})}>重新生成</button>
        </div>
      )}
      {candidate.spec && (
        <FigureTextEditor key={candidate.revision ?? 0} spec={candidate.spec} disabled={busy} onApply={(spec) => onRevise({ spec })} />
      )}
    </div>
  );
}
