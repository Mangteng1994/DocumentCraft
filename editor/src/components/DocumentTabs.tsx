/**
 * 编辑区顶部的文档页签。点击切换，× 或鼠标中键关闭，悬停显示完整路径。
 */

import { X } from "lucide-react";
import { closeTab, openDocument } from "../documentActions";
import { fileName } from "../paths";
import { useAppStore } from "../store";
import { iconSize } from "../styles/tokens";

/** 鼠标中键的 button 值。 */
const MIDDLE_BUTTON = 1;

export function DocumentTabs() {
  const tabs = useAppStore((state) => state.tabs);
  const filePath = useAppStore((state) => state.filePath);

  return (
    <div className="dc-doc-tabs" role="tablist" aria-label="打开的文档">
      {tabs.map((tab) => {
        const active = tab.path === filePath;
        return (
          <div
            key={tab.path}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={`dc-doc-tab${active ? " is-active" : ""}`}
            title={tab.path}
            onClick={() => void openDocument(tab.path)}
            onAuxClick={(event) => {
              if (event.button === MIDDLE_BUTTON) {
                event.preventDefault();
                void closeTab(tab.path);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void openDocument(tab.path);
              }
            }}
          >
            <span className="dc-doc-tab-name">{fileName(tab.path)}</span>
            {tab.dirty && <span className="dc-view-dirty" title="未保存" aria-label="未保存" />}
            <button
              type="button"
              className="dc-doc-tab-close"
              aria-label={`关闭 ${fileName(tab.path)}`}
              title="关闭（Ctrl+W）"
              onClick={(event) => {
                event.stopPropagation();
                void closeTab(tab.path);
              }}
            >
              <X size={iconSize.sm} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
