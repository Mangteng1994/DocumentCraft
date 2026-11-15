/**
 * 自动检查更新的定时器（DC-063）：启动后立即检查一次，之后每 6 小时一次。
 *
 * 以设置里的 lastCheckedAt 计算下一次检查的时间，所以重启程序或电脑休眠后不会重复请求，
 * 距上次检查不足 6 小时就等到满 6 小时再查。开发模式不自动检查，避免 `tauri dev` 反复访问 GitHub。
 */

import { useEffect } from "react";
import { UPDATE_CHECK_INTERVAL_MS } from "../../settings/schema";
import { getSettings, useSettings } from "../../settings/settingsStore";
import { checkForUpdate, loadCurrentVersion } from "./updaterStore";

export function useAutoUpdate(): void {
  const loaded = useSettings((state) => state.loaded);
  const autoCheck = useSettings((state) => state.settings.update.autoCheck);

  useEffect(() => {
    void loadCurrentVersion();
  }, []);

  useEffect(() => {
    if (!loaded || !autoCheck || import.meta.env.DEV) {
      return;
    }
    let timer: number | undefined;
    let cancelled = false;

    const schedule = () => {
      const last = getSettings().update.lastCheckedAt;
      const wait = Math.max(0, last + UPDATE_CHECK_INTERVAL_MS - Date.now());
      timer = window.setTimeout(async () => {
        await checkForUpdate();
        // 已有更新在下载或待安装时 checkForUpdate 会直接返回而不记录时间；这里补记，
        // 否则等待时间恒为 0，定时器会连续空转。
        if (getSettings().update.lastCheckedAt <= last) {
          useSettings.getState().update("update", { lastCheckedAt: Date.now() });
        }
        if (!cancelled) {
          schedule();
        }
      }, wait);
    };

    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loaded, autoCheck]);
}
