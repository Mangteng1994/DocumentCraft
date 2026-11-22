/**
 * 压缩文档媒体（DC-073）：选择 pptx、docx、xlsx，勾选视频与图片，后台压缩并显示进度。
 *
 * 压缩结果写入原文件同目录的「原名_压缩版.后缀」，原文件不改动；图片像素与视频画面尺寸不变。
 * 关闭窗口不会中断任务，任务状态见 compressStore。
 */

import { open } from "@tauri-apps/plugin-dialog";
import { revealEntry } from "../../backend";
import { Dialog, Field, StatusLine } from "../../components/Dialog";
import { formatSizeShort } from "../../format";
import { fileName } from "../../paths";
import { useAppStore } from "../../store";
import { useCompress, type CompressFile } from "./compressStore";

const KIND_LABEL: Record<CompressFile["kind"], string> = { video: "视频", jpeg: "图片", png: "图片" };

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function FileLine({ file }: { file: CompressFile }) {
  const name = fileName(file.name);
  if (file.status === "replaced") {
    return (
      <li className="dc-compress-line">
        {name}：{formatSizeShort(file.before)} → {formatSizeShort(file.after)}
      </li>
    );
  }
  return (
    <li className="dc-compress-line is-kept">
      {name}：保持原样（{file.reason || KIND_LABEL[file.kind]}）
    </li>
  );
}

export function CompressDialog() {
  const setOverlay = useAppStore((state) => state.setOverlay);
  const source = useCompress((state) => state.source);
  const video = useCompress((state) => state.video);
  const image = useCompress((state) => state.image);
  const phase = useCompress((state) => state.phase);
  const overall = useCompress((state) => state.overall);
  const currentName = useCompress((state) => state.currentName);
  const currentKind = useCompress((state) => state.currentKind);
  const currentIndex = useCompress((state) => state.currentIndex);
  const currentCount = useCompress((state) => state.currentCount);
  const currentFraction = useCompress((state) => state.currentFraction);
  const files = useCompress((state) => state.files);
  const result = useCompress((state) => state.result);
  const message = useCompress((state) => state.message);
  const setSource = useCompress((state) => state.setSource);
  const setVideo = useCompress((state) => state.setVideo);
  const setImage = useCompress((state) => state.setImage);
  const start = useCompress((state) => state.start);
  const cancel = useCompress((state) => state.cancel);
  const reset = useCompress((state) => state.reset);

  const running = phase === "running";
  const ready = source !== "" && (video || image);

  const chooseSource = async () => {
    const selected = await open({
      multiple: false,
      title: "选择要压缩的文档",
      filters: [{ name: "Office 文档", extensions: ["pptx", "docx", "xlsx"] }],
    });
    if (typeof selected === "string") {
      setSource(selected);
    }
  };

  const close = () => setOverlay(null);

  const footer = running ? (
    <>
      <button type="button" className="dc-button" onClick={() => void cancel()}>
        取消压缩
      </button>
      <button type="button" className="dc-button is-primary" onClick={close}>
        转入后台
      </button>
    </>
  ) : (
    <>
      <button type="button" className="dc-button" onClick={close}>
        关闭
      </button>
      {phase === "done" || phase === "cancelled" || phase === "failed" ? (
        <button type="button" className="dc-button is-primary" onClick={reset}>
          再压缩一个
        </button>
      ) : (
        <button type="button" className="dc-button is-primary" disabled={!ready} onClick={() => void start()}>
          压缩
        </button>
      )}
    </>
  );

  return (
    <Dialog title="压缩文档媒体" onClose={close} footer={footer}>
      <p className="dc-dialog-text">压缩 PPT、Word、Excel 里的视频和图片，保持原分辨率和页面位置。结果另存为同目录的「原名_压缩版」，原文件不会改动。</p>

      <Field label="文档" hint="支持 pptx、docx、xlsx；旧版 ppt、doc 请先另存为新格式。">
        <div className="dc-path-row">
          <input className="dc-input" readOnly value={source} placeholder="尚未选择文件" title={source} />
          <button type="button" className="dc-button" disabled={running} onClick={() => void chooseSource()}>
            选择文件
          </button>
        </div>
      </Field>

      <div className="dc-field">
        <span className="dc-field-label">压缩类型</span>
        <label className="dc-check">
          <input type="checkbox" checked={video} disabled={running} onChange={(event) => setVideo(event.target.checked)} />
          视频（重新编码为 H.264，画面尺寸与帧率不变）
        </label>
        <label className="dc-check">
          <input type="checkbox" checked={image} disabled={running} onChange={(event) => setImage(event.target.checked)} />
          图片（JPEG 与 PNG，像素尺寸不变）
        </label>
      </div>

      {running && (
        <div className="dc-compress-progress">
          <div className="dc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)}>
            <div className="dc-progress-bar" style={{ width: percent(overall) }} />
          </div>
          <p className="dc-field-hint">
            总进度 {percent(overall)}
            {currentName && `　第 ${currentIndex}/${currentCount} 个：${fileName(currentName)}（${KIND_LABEL[currentKind as CompressFile["kind"]] ?? ""}${currentKind === "video" ? ` ${percent(currentFraction)}` : ""}）`}
          </p>
        </div>
      )}

      {phase === "done" && result && (
        <div className="dc-compress-result">
          {result.target ? (
            <>
              <p className="dc-dialog-text">
                {formatSizeShort(result.before_bytes)} → {formatSizeShort(result.after_bytes)}，节省 {percent(1 - result.after_bytes / result.before_bytes)}；
                压缩 {result.replaced} 个媒体，保持原样 {result.kept} 个，用时 {Math.round(result.seconds)} 秒。
              </p>
              <p className="dc-field-hint" title={result.target}>
                已保存：{result.target}
              </p>
              <div className="dc-row-actions is-start">
                <button type="button" className="dc-button" onClick={() => void revealEntry(result.target as string)}>
                  打开所在文件夹
                </button>
              </div>
            </>
          ) : (
            <p className="dc-dialog-text">没有可压缩的内容，未生成新文件。</p>
          )}
          {result.warnings.map((warning) => (
            <StatusLine key={warning} text={warning} tone="warning" />
          ))}
        </div>
      )}

      {phase === "failed" && <StatusLine text={message} tone="error" />}
      {phase === "cancelled" && <StatusLine text={message} tone="warning" />}

      {files.length > 0 && (
        <ul className="dc-compress-log" aria-label="逐文件结果">
          {files.map((file) => (
            <FileLine key={file.name} file={file} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}
