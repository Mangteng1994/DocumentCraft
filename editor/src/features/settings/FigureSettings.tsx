/**
 * 设置 → 科研流程图：保存默认绘图风格，并对当前文档执行 AI 配图分析与绘制。
 *
 * 结果写在源文件旁：配图版报告（Markdown 源生成 Markdown）与含 PNG 和《审核清单.md》的资源目录，
 * 原文件保持不变。提交前提示将外发的内容与目标服务。
 */

import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { docflow, errorText, openPath } from "../../backend";
import { ensureSaved, openDocument, refreshTree } from "../../documentActions";
import { fileName } from "../../paths";
import type { FigureStyle } from "../../settings/schema";
import { useSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";
import { StatusLine } from "../../components/Dialog";
import { aiDestination, loadAiStatus } from "./aiStatus";
import { SettingHeading, SettingItem } from "./SettingsModal";

interface IllustrateResult {
  output: string;
  review: string;
  images: number;
  issues: number;
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function FigureSettings() {
  const filePath = useAppStore((state) => state.filePath);
  const apiKey = useAppStore((state) => state.apiKey);
  const setOverlay = useAppStore((state) => state.setOverlay);
  const style = useSettings((state) => state.settings.figure.style);
  const update = useSettings((state) => state.update);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IllustrateResult | null>(null);
  const [message, setMessage] = useState("");

  const handleStart = async () => {
    if (!filePath) {
      return;
    }
    setMessage("");
    try {
      const status = await loadAiStatus();
      const confirmed = await ask(`将报告正文、标题层级、实图位置和引用线索发送到 ${aiDestination(status)} 进行分析。继续吗？`, {
        title: "提交报告分析",
        kind: "info",
        okLabel: "发送",
        cancelLabel: "取消",
      });
      if (!confirmed) {
        return;
      }
      setBusy(true);
      const saved = await ensureSaved();
      if (!saved) {
        setMessage("文档未能保存，已取消。");
        return;
      }
      const report = await docflow<IllustrateResult>(["illustrate", "--source", filePath, "--style", style], { apiKey });
      setResult(report);
      await refreshTree();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const openResult = async (path: string) => {
    if (isMarkdown(path)) {
      setOverlay(null);
      await openDocument(path);
      return;
    }
    await openPath(path);
  };

  return (
    <>
      <p className="dc-setting-note">
        AI 判断缺图、可新增配图、已有实图与待确认位置，本地程序绘制 PNG 并生成配图版报告与审核清单。原文件保持不变。使用「AI 连接」中保存的连接。
      </p>
      <SettingHeading>默认参数</SettingHeading>
      <SettingItem name="绘图风格">
        <select className="dc-input" value={style} onChange={(event) => update("figure", { style: event.target.value as FigureStyle })}>
          <option value="mono">黑白工程图</option>
          <option value="colored">按功能分区配色</option>
        </select>
      </SettingItem>

      <SettingHeading>为当前文档生成</SettingHeading>
      {!filePath ? (
        <p className="dc-setting-note">打开一篇报告后可在这里生成配图。</p>
      ) : (
        <>
          <SettingItem name={fileName(filePath)} />
          {result && <StatusLine text={`完成。新增 ${result.images} 张图，待确认 ${result.issues} 项。`} />}
          <StatusLine text={busy ? "分析可能需要几分钟，请保持窗口打开。" : ""} />
          <StatusLine text={message} tone="error" />
          <div className="dc-row-actions">
            {result && (
              <>
                <button type="button" className="dc-button" onClick={() => void openResult(result.review)}>
                  打开审核清单
                </button>
                <button type="button" className="dc-button" onClick={() => void openResult(result.output)}>
                  打开配图版
                </button>
              </>
            )}
            <button type="button" className="dc-button is-primary" disabled={busy} onClick={() => void handleStart()}>
              {busy ? "正在分析并绘制…" : "开始配图"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
