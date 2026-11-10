/**
 * 最近打开的工作区文件夹，显示在欢迎页。点击直接打开，× 只从列表移除，不动磁盘上的文件夹。
 */

import { Folder, X } from "lucide-react";
import { forgetWorkspace, openWorkspace } from "../documentActions";
import { fileName, parentDirectory } from "../paths";
import { useSettings } from "../settings/settingsStore";
import { iconSize, iconStroke } from "../styles/tokens";

export function RecentWorkspaces() {
  const recent = useSettings((state) => state.settings.history.recentWorkspaces);
  if (recent.length === 0) {
    return null;
  }
  return (
    <section className="dc-recent" aria-label="最近打开的文件夹">
      <h2 className="dc-recent-title">最近打开</h2>
      <ul className="dc-recent-list">
        {recent.map((root) => (
          <li key={root} className="dc-recent-item">
            <button type="button" className="dc-recent-open" title={root} onClick={() => void openWorkspace(root)}>
              <Folder size={iconSize.sm} strokeWidth={iconStroke.regular} />
              <span className="dc-recent-name">{fileName(root) || root}</span>
              <span className="dc-recent-path">{parentDirectory(root)}</span>
            </button>
            <button
              type="button"
              className="dc-icon-button dc-recent-remove"
              aria-label={`从最近列表移除 ${root}`}
              title="从列表移除"
              onClick={() => forgetWorkspace(root)}
            >
              <X size={iconSize.sm} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
