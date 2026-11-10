/**
 * 设置 → MD 转 Word：保存默认模板、模板模式与是否包含批注，并把当前文档导出为 DOCX。
 *
 * 导出读取磁盘上的文件，开始前会保存未保存的修改。已有输出默认受保护，
 * 只有用户在系统保存对话框中确认替换后才传 --overwrite。
 */

import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { builtinTemplate, docflow, errorText, openPath } from "../../backend";
import { ensureSaved } from "../../documentActions";
import { fileName } from "../../paths";
import type { TemplateMode } from "../../settings/schema";
import { useSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";
import { StatusLine } from "../../components/Dialog";
import { SettingHeading, SettingItem, Toggle } from "./SettingsModal";

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

export function WordExportSettings() {
  const filePath = useAppStore((state) => state.filePath);
  const notes = useAppStore((state) => state.notes);
  const wordExport = useSettings((state) => state.settings.wordExport);
  const update = useSettings((state) => state.update);
  const [output, setOutput] = useState(() => (filePath ? filePath.replace(/\.(md|markdown)$/i, ".docx") : ""));
  const [overwrite, setOverwrite] = useState(false);
  const [unresolved, setUnresolved] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // 未选择自定义模板时使用内置模板。
  const [builtinPath, setBuiltinPath] = useState("");
  useEffect(() => {
    builtinTemplate()
      .then(setBuiltinPath)
      .catch(() => setBuiltinPath(""));
  }, []);
  const customTemplate = wordExport.template;
  const effectiveTemplate = customTemplate || builtinPath;

  const chooseTemplate = async () => {
    const selected = await open({ multiple: false, title: "选择 Word 模板", filters: [{ name: "Word 文档", extensions: ["docx"] }] });
    if (typeof selected === "string") {
      update("wordExport", { template: selected });
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
      const args = ["md-to-word", "--input", filePath, "--template", effectiveTemplate, "--output", output, "--template-mode", wordExport.mode, "--json"];
      if (overwrite) {
        args.push("--overwrite");
      }
      if (wordExport.includeNotes) {
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

  const ready = Boolean(filePath && effectiveTemplate && output);

  return (
    <>
      <SettingHeading>默认参数</SettingHeading>
      <SettingItem
        name="Word 模板"
        description={customTemplate ? `自定义：${customTemplate}` : builtinPath ? "内置：我的文档模板" : "找不到内置模板，请选择 .docx 模板"}
      >
        <button type="button" className="dc-button" onClick={() => void chooseTemplate()}>
          更换模板
        </button>
        {customTemplate && (
          <button type="button" className="dc-button" onClick={() => update("wordExport", { template: "" })}>
            恢复内置模板
          </button>
        )}
      </SettingItem>
      <SettingItem name="模板模式" description="完整模板在 {{DOCFLOW_CONTENT}} 或书签 DOCFLOW_CONTENT 处插入正文。">
        <select className="dc-input" value={wordExport.mode} onChange={(event) => update("wordExport", { mode: event.target.value as TemplateMode })}>
          {MODES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </SettingItem>
      <SettingItem name="包含批注" description="把批注写为 WPS / Word 可编辑的批注。">
        <Toggle label="包含批注" checked={wordExport.includeNotes} onChange={(value) => update("wordExport", { includeNotes: value })} />
      </SettingItem>

      <SettingHeading>导出当前文档</SettingHeading>
      {!filePath ? (
        <p className="dc-setting-note">打开一篇 Markdown 后可在这里导出。</p>
      ) : (
        <>
          <SettingItem name={fileName(filePath)} description={`${notes.length} 条批注`} />
          <SettingItem name="保存到" description={output}>
            <button type="button" className="dc-button" onClick={() => void chooseOutput()}>
              更改位置
            </button>
          </SettingItem>
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
              text={`已生成 ${result.output}（${result.template_mode} 模板）${wordExport.includeNotes ? `，写入 ${result.notes ?? 0} 条批注` : ""}${result.skipped_notes ? `，跳过 ${result.skipped_notes} 条` : ""}。`}
            />
          )}
          <StatusLine text={message} tone="error" />
          <div className="dc-row-actions">
            {result?.output && (
              <button type="button" className="dc-button" onClick={() => void openPath(result.output ?? "")}>
                打开 Word
              </button>
            )}
            <button type="button" className="dc-button is-primary" disabled={!ready || busy} onClick={() => void runExport(false)}>
              {busy ? "正在导出…" : "导出 Word"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
