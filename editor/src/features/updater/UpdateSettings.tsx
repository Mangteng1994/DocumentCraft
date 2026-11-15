/**
 * 设置 → 关于与更新（DC-063）：当前版本、手动检查、自动检查与自动下载开关、新版本说明和安装。
 */

import { useSettings } from "../../settings/settingsStore";
import { SettingItem, Toggle } from "../settings/SettingsModal";
import { checkForUpdate, downloadProgressText, downloadUpdate, installUpdate, useUpdate } from "./updaterStore";

function formatCheckedAt(timestamp: number): string {
  if (timestamp <= 0) {
    return "尚未检查";
  }
  return new Date(timestamp).toLocaleString("zh-CN");
}

export function UpdateSettings() {
  const phase = useUpdate((state) => state.phase);
  const currentVersion = useUpdate((state) => state.currentVersion);
  const newVersion = useUpdate((state) => state.newVersion);
  const notes = useUpdate((state) => state.notes);
  const downloaded = useUpdate((state) => state.downloaded);
  const total = useUpdate((state) => state.total);
  const notice = useUpdate((state) => state.notice);
  const error = useUpdate((state) => state.error);
  const autoCheck = useSettings((state) => state.settings.update.autoCheck);
  const autoDownload = useSettings((state) => state.settings.update.autoDownload);
  const lastCheckedAt = useSettings((state) => state.settings.update.lastCheckedAt);
  const update = useSettings((state) => state.update);

  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const hasNewVersion = phase === "available" || phase === "downloading" || phase === "ready" || phase === "installing";

  return (
    <>
      <SettingItem
        name="当前版本"
        description={`上次检查：${formatCheckedAt(lastCheckedAt)}。更新来自 GitHub 上的最新正式版本，安装包经签名校验后才会安装。`}
      >
        <span>{currentVersion ? `v${currentVersion}` : "—"}</span>
        <button type="button" className="dc-button" disabled={busy || phase === "ready"} onClick={() => void checkForUpdate()}>
          {phase === "checking" ? "正在检查…" : "检查更新"}
        </button>
      </SettingItem>

      {notice && <p className="dc-status-line">{notice}</p>}
      {error && <p className="dc-status-line is-error">{error}</p>}

      {hasNewVersion && (
        <SettingItem
          name={`新版本 v${newVersion}`}
          description={
            <>
              {phase === "available" && "已发现新版本，尚未下载。"}
              {phase === "downloading" && `正在下载：${downloadProgressText(downloaded, total)}`}
              {phase === "ready" && "已下载。安装时程序会关闭并自动重启，请先保存正在编辑的文档。"}
              {phase === "installing" && "正在交给安装程序，程序即将关闭。"}
              {notes && <span className="dc-update-notes">{notes}</span>}
            </>
          }
        >
          {phase === "available" && (
            <button type="button" className="dc-button is-primary" onClick={() => void downloadUpdate()}>
              下载更新
            </button>
          )}
          {phase === "ready" && (
            <button type="button" className="dc-button is-primary" onClick={() => void installUpdate()}>
              重启并安装
            </button>
          )}
        </SettingItem>
      )}

      <SettingItem name="自动检查更新" description="启动时检查一次，之后每 6 小时检查一次。关闭后只能手动检查。">
        <Toggle label="自动检查更新" checked={autoCheck} onChange={(value) => update("update", { autoCheck: value })} />
      </SettingItem>
      <SettingItem
        name="自动下载更新"
        description="发现新版本后在后台下载，下载完成只在状态栏提示，由你决定何时安装。安装包较大，按流量计费的网络下可以关闭。"
      >
        <Toggle label="自动下载更新" checked={autoDownload} onChange={(value) => update("update", { autoDownload: value })} />
      </SettingItem>
    </>
  );
}
