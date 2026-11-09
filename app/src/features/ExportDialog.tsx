/**
 * 导出 Word：按样式模板或完整模板把当前文档转换为 DOCX，可选写入批注。
 *
 * 导出读取磁盘上的文件，开始前会保存未保存的修改。已有输出默认受保护，
 * 只有用户在系统保存对话框中确认替换后才传 --overwrite。
 */

import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { docflow, errorText, openPath } from "../backend";
import { ensureSaved } from "../documentActions";
import { useAppStore } from "../store";
import { Dialog, Field, StatusLine } from "../components/Dialog";

type TemplateMode = "auto" | "style" | "full";

const MODES: { value: TemplateMode; label: string }[] = [
  { value: "auto", label: "自动识别" },
  { value: "style", label: "仅使用样式" },
  { value: "full", label: "完整模板（正文锚点）" },
];

interface ExportResult {
  status: "converted" | "unresolved";
  output?: string;
  template_mode?: string;
  count?: number;
  notes?: number;
  skipped_notes?: number;
}

export function ExportDialog() {
  const filePath = useAppStore((state) => state.filePath);
  const notes = useAppStore((state) => state.notes);
  const setDialog = useAppStore((state) => state.setDialog);
  const [template, setTemplate] = useState("");
  const [output, setOutput] = useState(() => (filePath ? filePath.replace(/\.(md|markdown)$/i, ".docx") : ""));
  const [mode, setMode] = useState<TemplateMode>("auto");
  const [withNotes, setWithNotes] = useState(notes.length > 0);
  const [overwrite, setOverwrite] = useState(false);
  const [unresolved, setUnresolved] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const chooseTemplate = async () => {
    const selected = await open({ multiple: false, title: "选择 Word 模板", filters: [{ name: "Word 文档", extensions: ["docx"] }] });
    if (typeof selected === "string") {
      setTemplate(selected);
    }
  };

  const chooseOutput = async () => {
    const selected = await save({ title: "保存 Word 文档", defaultPath: output, filters: [{ name: "Word 文档", extensions: ["docx"] }] });
    if (selected) {
      setOutput(selected);
      // 系统保存对话框已就替换已有文件征得确认。
      setOverwrite(true);
    }
  };

  const runExport = async (skipUnresolved: boolean) => {
    if (!filePath) {
      return;
    }
    setBusy(true);
    setMessage("");
    setResult(null);
    try {
      const saved = await ensureSaved();
      if (!saved) {
        setMessage("文档未能保存，已取消导出。");
        return;
      }
      const args = ["md-to-word", "--input", filePath, "--template", template, "--output", output, "--template-mode", mode, "--json"];
      if (overwrite) {
        args.push("--overwrite");
      }
      if (withNotes) {
        args.push("--with-notes");
      }
      if (skipUnresolved) {
        args.push("--skip-unresolved");
      }
      const report = await docflow<ExportResult>(args);
      if (report.status === "unresolved") {
        setUnresolved(report.count ?? 0);
        return;
      }
      setUnresolved(null);
      setResult(report);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(filePath && template && output);
  const footer = (
    <>
      <button type="button" className="dc-button" onClick={() => setDialog(null)} disabled={busy}>
        关闭
      </button>
      {result?.output && (
        <button type="button" className="dc-button" onClick={() => void openPath(result.output ?? "")}>
          打开 Word
        </button>
      )}
      <button type="button" className="dc-button is-primary" disabled={!ready || busy} onClick={() => void runExport(false)}>
        {busy ? "正在导出…" : "导出"}
      </button>
    </>
  );

  return (
    <Dialog title="导出 Word" onClose={() => setDialog(null)} footer={footer} busy={busy}>
      <Field label="Word 模板">
        <div className="dc-path-row">
          <input className="dc-input" readOnly value={template} placeholder="选择 .docx 模板" />
          <button type="button" className="dc-button" onClick={() => void chooseTemplate()}>
            浏览
          </button>
        </div>
      </Field>
      <Field label="模板模式" hint="完整模板在 {{DOCFLOW_CONTENT}} 或书签 DOCFLOW_CONTENT 处插入正文。">
        <select className="dc-input" value={mode} onChange={(event) => setMode(event.target.value as TemplateMode)}>
          {MODES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="保存到">
        <div className="dc-path-row">
          <input className="dc-input" readOnly value={output} />
          <button type="button" className="dc-button" onClick={() => void chooseOutput()}>
            浏览
          </button>
        </div>
      </Field>
      <label className="dc-check">
        <input type="checkbox" checked={withNotes} onChange={(event) => setWithNotes(event.target.checked)} />
        包含批注（{notes.length} 条，写入为 WPS / Word 可编辑的批注）
      </label>
      {unresolved !== null && (
        <div className="dc-callout is-warning">
          <p>有 {unresolved} 条批注无法在导出正文中唯一定位，或位于暂不支持导出的段落（含公式、图片、换行等）。</p>
          <button type="button" className="dc-button" disabled={busy} onClick={() => void runExport(true)}>
            跳过这些批注并导出
          </button>
        </div>
      )}
      {result && (
        <StatusLine
          text={`已生成 ${result.output}（${result.template_mode} 模板）${withNotes ? `，写入 ${result.notes ?? 0} 条批注` : ""}${result.skipped_notes ? `，跳过 ${result.skipped_notes} 条` : ""}。`}
        />
      )}
      <StatusLine text={message} tone="error" />
    </Dialog>
  );
}
