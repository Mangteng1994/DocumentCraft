/**
 * 状态栏右侧的更新提示（DC-063）。只在有新版本时出现，点击打开「设置 → 关于与更新」，
 * 不弹窗，不打断编辑。
 */

import { useAppStore } from "../../store";
import { downloadProgressText, useUpdate } from "./updaterStore";

export function UpdateBadge() {
  const phase = useUpdate((state) => state.phase);
  const newVersion = useUpdate((state) => state.newVersion);
  const downloaded = useUpdate((state) => state.downloaded);
  const total = useUpdate((state) => state.total);
  const openSettings = useAppStore((state) => state.openSettings);

  let text = "";
  if (phase === "available") {
    text = `发现新版本 v${newVersion}`;
  } else if (phase === "downloading") {
    text = `正在下载更新 ${downloadProgressText(downloaded, total)}`;
  } else if (phase === "ready") {
    text = `新版本 v${newVersion} 已下载，点此安装`;
  }
  if (!text) {
    return null;
  }
  return (
    <button type="button" className="dc-statusbar-update" onClick={() => openSettings("update")} title="打开「关于与更新」">
      {text}
    </button>
  );
}
