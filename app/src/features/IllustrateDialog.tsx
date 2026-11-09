/**
 * 科研配图：对当前文档执行 AI 配图分析与绘制。
 *
 * 结果写在源文件旁：配图版报告（Markdown 源生成 Markdown）与含 PNG 和《审核清单.md》的资源目录，
 * 原文件保持不变。提交前提示将外发的内容与目标服务。
 */

import { useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { docflow, errorText, openPath } from "../backend";
import { ensureSaved, openDocument, refreshTree } from "../documentActions";
import { useAppStore } from "../store";
import { Dialog, Field, StatusLine } from "../components/Dialog";
import { aiDestination, loadAiStatus } from "./aiSettings";

type Style = "mono" | "colored";

interface IllustrateResult {
  output: string;
  review: string;
  images: number;
  issues: number;
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function IllustrateDialog() {
  const filePath = useAppStore((state) => state.filePath);
  const apiKey = useAppStore((state) => state.apiKey);
  const setDialog = useAppStore((state) => state.setDialog);
  const [style, setStyle] = useState<Style>("mono");
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
      const confirmed = await ask(
        `将报告正文、标题层级、实图位置和引用线索发送到 ${aiDestination(status)} 进行分析。继续吗？`,
        { title: "提交报告分析", kind: "info", okLabel: "发送", cancelLabel: "取消" },
      );
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
      setDialog(null);
      await openDocument(path);
      return;
    }
    await openPath(path);
  };

  const footer = (
    <>
      <button type="button" className="dc-button" onClick={() => setDialog(null)} disabled={busy}>
        关闭
      </button>
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
      <button type="button" className="dc-button is-primary" disabled={!filePath || busy} onClick={() => void handleStart()}>
        {busy ? "正在分析并绘制…" : "开始配图"}
      </button>
    </>
  );

  return (
    <Dialog title="科研配图" onClose={() => setDialog(null)} footer={footer} busy={busy}>
      <p className="dc-dialog-text">
        AI 判断缺图、可新增配图、已有实图与待确认位置，本地程序绘制 PNG 并生成配图版报告与审核清单。原文件保持不变。
      </p>
      <Field label="绘图风格">
        <select className="dc-input" value={style} onChange={(event) => setStyle(event.target.value as Style)}>
          <option value="mono">黑白工程图</option>
          <option value="colored">按功能分区配色</option>
        </select>
      </Field>
      {result && <StatusLine text={`完成。新增 ${result.images} 张图，待确认 ${result.issues} 项。`} />}
      <StatusLine text={busy ? "分析可能需要几分钟，请保持窗口打开。" : ""} />
      <StatusLine text={message} tone="error" />
    </Dialog>
  );
}
