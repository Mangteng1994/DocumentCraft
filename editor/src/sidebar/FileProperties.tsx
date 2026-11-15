/**
 * 文件或文件夹的属性窗口（DC-064）：名称、类型、完整路径、大小、各时间和只读状态。
 * 文件夹的大小和内容数量由后端统计，条目太多时只统计一部分并说明。
 */

import { useEffect, useState } from "react";
import { Dialog } from "../components/Dialog";
import { errorText, fileProperties, type FileProperties as Properties } from "../backend";
import { formatSize } from "../format";
import { useAppStore } from "../store";

function formatTime(timestamp: number | null): string {
  if (timestamp === null) {
    return "未知";
  }
  return new Date(timestamp).toLocaleString("zh-CN");
}

function typeLabel(info: Properties): string {
  if (info.is_dir) {
    return "文件夹";
  }
  if (!info.extension) {
    return "文件";
  }
  return `${info.extension.toUpperCase()} 文件`;
}

export function FileProperties({ path }: { path: string }) {
  const setOverlay = useAppStore((state) => state.setOverlay);
  const [info, setInfo] = useState<Properties | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setError("");
    fileProperties(path)
      .then((value) => {
        if (!cancelled) {
          setInfo(value);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(errorText(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const close = () => setOverlay(null);
  const rows: [string, string][] = [];
  if (info) {
    rows.push(["名称", info.name]);
    rows.push(["类型", typeLabel(info)]);
    rows.push(["位置", info.folder]);
    rows.push(["完整路径", info.path]);
    if (info.is_dir) {
      const partial = info.partial ? "（条目太多，只统计了一部分）" : "";
      rows.push(["内容", `${info.files.toLocaleString()} 个文件，${info.folders.toLocaleString()} 个文件夹${partial}`]);
      rows.push(["大小", `${formatSize(info.size)}${partial ? "，不含未统计部分" : ""}`]);
    } else {
      rows.push(["大小", formatSize(info.size)]);
    }
    rows.push(["创建时间", formatTime(info.created)]);
    rows.push(["修改时间", formatTime(info.modified)]);
    rows.push(["访问时间", formatTime(info.accessed)]);
    rows.push(["只读", info.readonly ? "是" : "否"]);
  }

  return (
    <Dialog
      title="属性"
      onClose={close}
      footer={
        <button type="button" className="dc-button" onClick={close}>
          关闭
        </button>
      }
    >
      {error && <p className="dc-status-line is-error">{error}</p>}
      {!info && !error && <p className="dc-status-line">正在读取…</p>}
      {info && (
        <dl className="dc-props">
          {rows.map(([label, value]) => (
            <div key={label} className="dc-props-row">
              <dt className="dc-props-label">{label}</dt>
              <dd className="dc-props-value">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Dialog>
  );
}
