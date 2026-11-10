/**
 * 侧栏边缘的拖动条。拖动时直接改写工作台上的宽度变量以保证流畅，松开后写入设置；双击恢复默认宽度。
 */

import type { MouseEvent, PointerEvent } from "react";
import { useSettings } from "../settings/settingsStore";
import { paneWidth } from "../styles/tokens";

type Pane = "sidebar" | "panel";

/** 每个侧栏对应的 CSS 变量、设置字段和宽度上下限。 */
const PANES: Record<Pane, { variable: string; field: "sidebarWidth" | "panelWidth"; min: number; max: number; label: string }> = {
  sidebar: { variable: "--dc-sidebar-width", field: "sidebarWidth", min: paneWidth.sidebarMin, max: paneWidth.sidebarMax, label: "调整左侧栏宽度" },
  panel: { variable: "--dc-panel-width", field: "panelWidth", min: paneWidth.panelMin, max: paneWidth.panelMax, label: "调整右侧栏宽度" },
};

export function clampPaneWidth(pane: Pane, width: number): number {
  const config = PANES[pane];
  return Math.round(Math.min(config.max, Math.max(config.min, width)));
}

/** 设置中的宽度转成内联样式变量；0 表示沿用 tokens.css 的默认宽度。 */
export function paneWidthStyle(sidebarWidth: number, panelWidth: number): Record<string, string> {
  const style: Record<string, string> = {};
  if (sidebarWidth > 0) {
    style[PANES.sidebar.variable] = `${clampPaneWidth("sidebar", sidebarWidth)}px`;
  }
  if (panelWidth > 0) {
    style[PANES.panel.variable] = `${clampPaneWidth("panel", panelWidth)}px`;
  }
  return style;
}

export function PaneResizer({ pane }: { pane: Pane }) {
  const update = useSettings((state) => state.update);
  const config = PANES[pane];

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const container = handle.parentElement;
    const workbench = handle.closest<HTMLElement>(".dc-workbench");
    if (!container || !workbench) {
      return;
    }
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = container.getBoundingClientRect().width;
    // 左侧栏向右拖变宽，右侧栏向左拖变宽。
    const direction = pane === "sidebar" ? 1 : -1;
    let width = startWidth;
    document.body.classList.add("is-resizing");

    const handleMove = (move: globalThis.PointerEvent) => {
      width = clampPaneWidth(pane, startWidth + (move.clientX - startX) * direction);
      workbench.style.setProperty(config.variable, `${width}px`);
    };
    const handleUp = () => {
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleUp);
      handle.removeEventListener("pointercancel", handleUp);
      document.body.classList.remove("is-resizing");
      update("layout", { [config.field]: width });
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleUp);
    handle.addEventListener("pointercancel", handleUp);
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const workbench = event.currentTarget.closest<HTMLElement>(".dc-workbench");
    workbench?.style.removeProperty(config.variable);
    update("layout", { [config.field]: 0 });
  };

  return (
    <div
      className={`dc-pane-resizer is-${pane}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={config.label}
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    />
  );
}

