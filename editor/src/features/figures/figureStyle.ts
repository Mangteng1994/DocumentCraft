/**
 * 配图样式。
 *
 * 样式表以字符串形式放进图的根元素里，导出 PNG 时随 DOM 一起序列化进 SVG foreignObject，
 * 所以不能依赖应用的全局样式表。这里只写结构，所有设计值通过 CSS 变量取自 figureTokens
 * （见 figureVariables），变量直接写在根元素和各面板、卡片的行内样式上。
 */

import type { CSSProperties } from "react";
import { figureTokens, type FigureTone } from "../../styles/tokens";

type Variables = CSSProperties & Record<`--${string}`, string>;

function pt(value: number): string {
  return `${value}pt`;
}

/** 根元素上的变量：字体、颜色、当前密度的字号与间距，以及线宽、圆角等。 */
export function figureVariables(width: number, densityIndex: number): Variables {
  const density = figureTokens.density[densityIndex];
  const gap = figureTokens.gap;
  const stroke = figureTokens.stroke;
  return {
    width: pt(width),
    "--f-font": figureTokens.font,
    "--f-paper": figureTokens.paper,
    "--f-ink": figureTokens.ink,
    "--f-muted": figureTokens.inkMuted,
    "--f-link": figureTokens.link,
    "--f-group-border": figureTokens.groupBorder,
    "--f-panel-title": pt(density.panelTitle),
    "--f-card-title": pt(density.cardTitle),
    "--f-detail": pt(density.detail),
    "--f-label": pt(density.label),
    "--f-pad": pt(density.padding),
    "--f-card-pad": pt(density.cardPadding),
    "--f-lh": String(density.lineHeight),
    "--f-bold": String(figureTokens.bold),
    "--f-regular": String(figureTokens.regular),
    "--f-gap-tight": pt(gap.tight),
    "--f-gap-normal": pt(gap.normal),
    "--f-gap-loose": pt(gap.loose),
    "--f-gap-wide": pt(gap.wide),
    "--f-chain-arrow": pt(figureTokens.chainArrow),
    "--f-arrow-solid": pt(figureTokens.layoutArrow.solid),
    "--f-arrow-hollow": pt(figureTokens.layoutArrow.hollow),
    "--f-side-header": pt(figureTokens.sideHeader),
    "--f-decision": pt(figureTokens.decisionHeight),
    "--f-icon": pt(figureTokens.icon),
    "--f-radius-panel": pt(figureTokens.radius.panel),
    "--f-radius-card": pt(figureTokens.radius.card),
    "--f-stroke-panel": pt(stroke.panel),
    "--f-stroke-card": pt(stroke.card),
    "--f-stroke-group": pt(stroke.group),
  };
}

/** 色调变量，写在面板、卡片或判断上，子元素继承。 */
export function toneVariables(tone: FigureTone | undefined): Variables {
  if (!tone) {
    return {};
  }
  const colors = figureTokens.tones[tone];
  return {
    "--t-surface": colors.surface,
    "--t-header": colors.header,
    "--t-card": colors.card,
    "--t-border": colors.border,
    "--t-heading": colors.heading,
  };
}

/** 根元素默认色调（灰），保证没有面板包裹的卡片也有颜色。 */
export const defaultTone = toneVariables("gray");

export const figureCss = `
.dcf { position: relative; box-sizing: border-box; padding: var(--f-gap-normal); background: var(--f-paper);
  font-family: var(--f-font); color: var(--f-ink); line-height: var(--f-lh); font-size: var(--f-card-title);
  overflow-wrap: anywhere; display: flex; flex-direction: column; }
.dcf *, .dcf *::before, .dcf *::after { box-sizing: border-box; margin: 0; padding: 0; }
.dcf-row { display: flex; flex-direction: row; align-items: stretch; min-width: 0; }
.dcf-row.is-center { align-items: center; }
.dcf-col { display: flex; flex-direction: column; min-width: 0; }
.dcf-grid { display: grid; min-width: 0; grid-auto-rows: 1fr; }
.dcf-gap-tight { gap: var(--f-gap-tight); }
.dcf-gap-normal { gap: var(--f-gap-normal); }
.dcf-gap-loose { gap: var(--f-gap-loose); }
.dcf-gap-wide { gap: var(--f-gap-wide); }
.dcf-panel { display: flex; flex-direction: column; min-width: 0; background: var(--t-surface);
  border: var(--f-stroke-panel) solid var(--t-border); border-radius: var(--f-radius-panel); overflow: hidden; }
.dcf-panel.is-side { flex-direction: row; }
.dcf-panel.is-bare { border-style: none; background: transparent; }
.dcf-band { flex: none; background: var(--t-header); border-bottom: var(--f-stroke-panel) solid var(--t-border);
  color: var(--t-heading); font-weight: var(--f-bold); font-size: var(--f-panel-title); text-align: center;
  padding: calc(var(--f-pad) * 0.7) var(--f-pad); }
.dcf-side { flex: none; width: var(--f-side-header); background: var(--t-header);
  border-right: var(--f-stroke-panel) solid var(--t-border); color: var(--t-heading); font-weight: var(--f-bold);
  font-size: var(--f-panel-title); display: flex; flex-direction: column; align-items: center;
  justify-content: center; text-align: center; padding: var(--f-pad); }
.dcf-plain { flex: none; color: var(--t-heading); font-weight: var(--f-bold); font-size: var(--f-panel-title);
  text-align: center; padding: var(--f-pad) var(--f-pad) 0; }
.dcf-subtitle { display: block; font-weight: var(--f-regular); font-size: var(--f-detail); color: var(--f-muted); }
.dcf-body { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; padding: var(--f-pad); }
.dcf-group { display: flex; flex-direction: column; min-width: 0; padding: var(--f-pad);
  border: var(--f-stroke-group) dashed var(--f-group-border); border-radius: var(--f-radius-panel); }
.dcf-group-title { flex: none; text-align: center; font-weight: var(--f-bold); font-size: var(--f-card-title);
  color: var(--f-ink); padding-bottom: calc(var(--f-pad) * 0.6); }
.dcf-card { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0;
  text-align: center; background: var(--t-card); border: var(--f-stroke-card) solid var(--t-border);
  border-radius: var(--f-radius-card); padding: var(--f-card-pad) calc(var(--f-card-pad) * 1.4); }
.dcf-card.is-outline { background: var(--f-paper); }
.dcf-card.is-note { background: var(--t-header); }
.dcf-card.has-icon { flex-direction: row; justify-content: flex-start; text-align: left; gap: calc(var(--f-card-pad) * 1.6); }
.dcf-card-text { display: flex; flex-direction: column; min-width: 0; }
.dcf-card.has-icon .dcf-card-text { flex: 1 1 auto; }
.dcf-card-icon { flex: none; width: var(--f-icon); height: var(--f-icon); color: var(--t-heading); }
.dcf-title { font-weight: var(--f-bold); font-size: var(--f-card-title); color: var(--f-ink); }
.dcf-card.is-banner .dcf-title { font-size: var(--f-panel-title); color: var(--t-heading); }
.dcf-card.is-note .dcf-title { font-weight: var(--f-regular); font-size: var(--f-detail); color: var(--f-ink); }
.dcf-detail { font-size: var(--f-detail); color: var(--f-muted); }
.dcf-tags { align-self: stretch; display: flex; flex-wrap: wrap; justify-content: center;
  margin-top: var(--f-card-pad); padding-top: var(--f-card-pad); border-top: var(--f-stroke-card) solid var(--t-border);
  font-size: var(--f-detail); color: var(--f-muted); }
.dcf-tag + .dcf-tag::before { content: "|"; padding: 0 calc(var(--f-card-pad) * 1.2); color: var(--t-border); }
.dcf-decision { position: relative; flex: none; min-height: var(--f-decision); display: flex; align-items: center;
  justify-content: center; text-align: center; font-size: var(--f-card-title); }
.dcf-decision > svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; }
.dcf-decision > span { position: relative; padding: 0 24%; }
.dcf-arrow { flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--f-gap-tight); color: var(--f-link); }
.dcf-arrow > svg { flex: none; overflow: visible; }
.dcf-arrow-label { font-size: var(--f-label); color: var(--f-muted); text-align: center; }
.dcf-step { position: relative; flex: none; display: flex; align-items: center; justify-content: center; }
.dcf-step > svg { overflow: visible; }
.dcf-step-label { font-size: var(--f-label); color: var(--f-muted); }
.dcf-step.has-label { display: grid; justify-items: center; align-items: center; }
.dcf-step.is-down.has-label { grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); }
.dcf-step.is-down.has-label > svg { grid-area: 1 / 2; }
.dcf-step.is-down .dcf-step-label { grid-area: 1 / 3; justify-self: stretch; padding-inline-start: var(--f-gap-tight); }
.dcf-step.is-right.has-label { grid-template-rows: 1fr auto 1fr; }
.dcf-step.is-right.has-label > svg { grid-area: 2 / 1; }
.dcf-step.is-right .dcf-step-label { grid-area: 1 / 1; white-space: nowrap; padding-inline: var(--f-gap-tight); }
.dcf-links { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
`;
