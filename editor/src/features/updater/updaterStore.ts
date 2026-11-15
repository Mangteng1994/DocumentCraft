/**
 * 应用更新（DC-063）：检查、下载与安装。
 *
 * 更新源是本项目 GitHub 的最新正式 Release（`tauri.conf.json` 的 plugins.updater.endpoints 指向其
 * latest.json）。安装包由官方 updater 插件用 minisign 公钥校验签名，校验不过不会安装。
 * 状态只在内存里；是否自动检查、自动下载与上次检查时间保存在设置的 `update` 分区。
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { ask } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { fileName } from "../../paths";
import { getSettings, useSettings } from "../../settings/settingsStore";
import { useAppStore } from "../../store";

/**
 * idle：没有待安装的新版本；checking：正在向 GitHub 查询；available：发现新版本、尚未下载；
 * downloading：下载中；ready：已下载，等待用户安装；installing：已交给安装程序。
 */
export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing";

interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion: string;
  notes: string;
  /** 已下载与总字节数；服务器没给长度时 total 为 0。 */
  downloaded: number;
  total: number;
  /** 手动检查后「已是最新版本」之类的说明，开始下一次检查时清空。 */
  notice: string;
  error: string;
}

export const useUpdate = create<UpdateState>(() => ({
  phase: "idle",
  currentVersion: "",
  newVersion: "",
  notes: "",
  downloaded: 0,
  total: 0,
  notice: "",
  error: "",
}));

const BYTES_PER_MEGABYTE = 1024 * 1024;

function megabytes(bytes: number): string {
  return (bytes / BYTES_PER_MEGABYTE).toFixed(1);
}

/** 下载进度文字：知道总大小时带百分比，否则只显示已下载大小。 */
export function downloadProgressText(downloaded: number, total: number): string {
  if (total > 0) {
    const percent = Math.min(100, Math.round((downloaded / total) * 100));
    return `${percent}%（${megabytes(downloaded)} / ${megabytes(total)} MB）`;
  }
  return `${megabytes(downloaded)} MB`;
}

/** 插件返回的更新句柄。它持有已下载的安装包，不能放进 store 序列化，只在模块内保存。 */
let pending: Update | null = null;

/** 读取应用自身的版本号，供设置页显示。 */
export async function loadCurrentVersion(): Promise<void> {
  try {
    const currentVersion = await getVersion();
    useUpdate.setState({ currentVersion });
  } catch (error) {
    useUpdate.setState({ error: `无法读取当前版本：${String(error)}` });
  }
}

/**
 * 向 GitHub 查询新版本。无论成功还是失败都记录检查时间：网络不通时下一轮仍按 6 小时间隔重试，
 * 不会因为失败而连续请求。发现新版本且开启了自动下载时，接着在后台下载。
 */
export async function checkForUpdate(): Promise<void> {
  const phase = useUpdate.getState().phase;
  if (phase !== "idle" && phase !== "available") {
    return;
  }
  useUpdate.setState({ phase: "checking", error: "", notice: "" });
  useSettings.getState().update("update", { lastCheckedAt: Date.now() });

  let found: Update | null = null;
  try {
    found = await check();
  } catch (error) {
    const restored: UpdatePhase = pending ? "available" : "idle";
    useUpdate.setState({ phase: restored, error: `检查更新失败：${String(error)}` });
    return;
  }

  if (!found) {
    pending = null;
    useUpdate.setState({ phase: "idle", newVersion: "", notes: "", notice: "当前已是最新版本。" });
    return;
  }
  pending = found;
  useUpdate.setState({ phase: "available", newVersion: found.version, notes: found.body ?? "" });
  if (getSettings().update.autoDownload) {
    await downloadUpdate();
  }
}

/** 下载已发现的新版本。下载过程中编辑器照常使用，完成后只提示，不自动安装。 */
export async function downloadUpdate(): Promise<void> {
  const update = pending;
  if (!update || useUpdate.getState().phase !== "available") {
    return;
  }
  useUpdate.setState({ phase: "downloading", downloaded: 0, total: 0, error: "" });
  try {
    await update.download((event) => {
      if (event.event === "Started") {
        useUpdate.setState({ total: event.data.contentLength ?? 0 });
      } else if (event.event === "Progress") {
        const chunk = event.data.chunkLength;
        useUpdate.setState((state) => ({ downloaded: state.downloaded + chunk }));
      }
    });
    useUpdate.setState({ phase: "ready" });
  } catch (error) {
    useUpdate.setState({ phase: "available", error: `下载更新失败：${String(error)}` });
  }
}

/**
 * 安装已下载的更新。Windows 上安装程序会关闭本程序，因此先做两项保护：
 * docflow 任务未结束时拒绝（安装会替换 sidecar）；有未保存的页签时让用户选择。
 */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update || useUpdate.getState().phase !== "ready") {
    return;
  }
  try {
    const active = await invoke<number>("docflow_active");
    if (active > 0) {
      useUpdate.setState({ error: "有 AI 或转换任务正在运行，请等待完成后再安装更新。" });
      return;
    }
  } catch (error) {
    useUpdate.setState({ error: `无法确认后台任务状态：${String(error)}` });
    return;
  }

  const unsaved = useAppStore.getState().tabs.filter((tab) => tab.dirty);
  if (unsaved.length > 0) {
    const names = unsaved.map((tab) => `「${fileName(tab.path)}」`).join("、");
    const proceed = await ask(`${names}有未保存的修改，安装更新会关闭程序，仍要继续吗？`, {
      title: "DocumentCraft",
      kind: "warning",
      okLabel: "不保存并安装",
      cancelLabel: "返回保存",
    });
    if (!proceed) {
      return;
    }
  }

  useUpdate.setState({ phase: "installing", error: "" });
  try {
    await update.install();
  } catch (error) {
    useUpdate.setState({ phase: "ready", error: `安装更新失败：${String(error)}` });
  }
}
