/**
 * 配图样式。
 *
 * 样式表以字符串形式放进图的根元素里，导出 PNG 时随 DOM 一起序列化进 SVG foreignObject，
 * 所以不能依赖应用的全局样式表。这里只写结构，所有设计值通过 CSS 变量取自 figureTokens
 * （见 figureVariables），变量直接写在根元素和各面板、卡片的行内样式上。
 */

import type { CSSProperties } from "react";
import { figureMonochrome, figureTokens, type FigureTone } from "../../styles/tokens";

type Variables = CSSProperties & Record<`--${string}`, string>;

function pt(value: number): string {
  return `${value}pt`;
}

/** 根元素上的变量：字体、颜色、当前密度的字号与间距，以及线宽、圆角等。 */
export function figureVariables(width: number, densityIndex: number, monochrome = false): Variables {
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
    "--f-border": monochrome ? figureMonochrome.border : figureTokens.border,
    "--f-group-border": monochrome ? figureMonochrome.groupBorder : figureTokens.groupBorder,
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
    "--f-stroke-link": pt(stroke.link),
    "--f-decision-inset": `${figureTokens.decision.inset}%`,
  };
}

/** 色调变量，写在面板、卡片或判断上，子元素继承。 */
export function toneVariables(tone: FigureTone | undefined, monochrome = false): Variables {
  if (!tone) {
    return {};
  }
  const colors = monochrome ? figureMonochrome.tone : figureTokens.tones[tone];
  return {
    "--t-surface": colors.surface,
    "--t-header": colors.header,
    "--t-card": colors.card,
  };
}

/** 根元素默认色调（灰），保证没有面板包裹的卡片也有颜色。 */
export const defaultTone = toneVariables("gray");
/** 黑白模式的根元素默认色调。 */
export const monochromeTone = toneVariables("gray", true);

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
  border: var(--f-stroke-panel) solid var(--f-border); border-radius: var(--f-radius-panel); overflow: hidden; }
.dcf-panel.is-side { flex-direction: row; }
.dcf-panel.is-bare { border-style: none; background: transparent; }
.dcf-band { flex: none; background: var(--t-header); border-bottom: var(--f-stroke-panel) solid var(--f-border);
  color: var(--f-ink); font-weight: var(--f-bold); font-size: var(--f-panel-title); text-align: center;
  padding: calc(var(--f-pad) * 0.7) var(--f-pad); }
.dcf-row.has-stage-bands { display: grid; grid-template-rows: auto 1fr; row-gap: 0; }
.dcf-row.has-stage-bands > .dcf-panel { display: grid; grid-row: 1 / 3; grid-template-rows: subgrid; }
.dcf-row.has-stage-bands > .dcf-panel > .dcf-band { display: flex; flex-direction: column; justify-content: center; }
.dcf-side { flex: none; width: var(--f-side-header); background: var(--t-header);
  border-right: var(--f-stroke-panel) solid var(--f-border); color: var(--f-ink); font-weight: var(--f-bold);
  font-size: var(--f-panel-title); display: flex; flex-direction: column; align-items: center;
  justify-content: center; text-align: center; padding: var(--f-pad); }
.dcf-plain { flex: none; color: var(--f-ink); font-weight: var(--f-bold); font-size: var(--f-panel-title);
  text-align: center; padding: var(--f-pad) var(--f-pad) 0; }
.dcf-subtitle { display: block; font-weight: var(--f-regular); font-size: var(--f-detail); color: var(--f-muted); }
.dcf-body { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; padding: var(--f-pad); }
.dcf-group { display: flex; flex-direction: column; min-width: 0; padding: var(--f-pad);
  border: var(--f-stroke-group) dashed var(--f-group-border); border-radius: var(--f-radius-panel); }
.dcf-group-title { flex: none; text-align: center; font-weight: var(--f-bold); font-size: var(--f-card-title);
  color: var(--f-ink); padding-bottom: calc(var(--f-pad) * 0.6); }
.dcf-card { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0;
  text-align: center; background: var(--t-card); border: var(--f-stroke-card) solid var(--f-border);
  border-radius: var(--f-radius-card); padding: var(--f-card-pad) calc(var(--f-card-pad) * 1.4); }
.dcf-card.is-outline { background: var(--f-paper); }
.dcf-card.is-note { background: var(--t-header); }
.dcf-card.has-icon { flex-direction: row; justify-content: flex-start; text-align: left; gap: calc(var(--f-card-pad) * 1.6); }
.dcf-card-text { display: flex; flex-direction: column; min-width: 0; }
.dcf-card.has-icon .dcf-card-text { flex: 1 1 auto; }
.dcf-card-icon { flex: none; width: var(--f-icon); height: var(--f-icon); color: var(--f-ink); }
.dcf-title { font-weight: var(--f-bold); font-size: var(--f-card-title); color: var(--f-ink); }
.dcf-card.is-banner { background: var(--t-surface); }
.dcf-card.is-banner .dcf-title { font-size: var(--f-panel-title); }
.dcf-card.is-label .dcf-title { font-weight: var(--f-regular); }
.dcf-card.is-note .dcf-title { font-weight: var(--f-regular); font-size: var(--f-detail); color: var(--f-ink); }
.dcf-detail { font-size: var(--f-detail); color: var(--f-muted); }
.dcf-card.has-tags:not(.has-icon) { padding: 0; }
.dcf-card.has-tags:not(.has-icon) .dcf-card-text { flex: 1 1 auto; justify-content: center; padding: var(--f-card-pad); }
.dcf-tags { align-self: stretch; display: flex; flex-wrap: wrap; justify-content: center;
  padding: var(--f-card-pad); border-top: var(--f-stroke-card) solid var(--f-border);
  font-size: var(--f-detail); color: var(--f-muted); }
.dcf-tag + .dcf-tag::before { content: "|"; padding: 0 calc(var(--f-card-pad) * 1.2); color: var(--f-border); }
/* 标签一行放不下时改为逐行堆叠，避免分隔线落在行首（由 FigureView 排版后按实测折行设置）。 */
.dcf-tags[data-stacked] { flex-direction: column; align-items: center; }
.dcf-tags[data-stacked] .dcf-tag + .dcf-tag::before { content: none; }
.dcf-decision { position: relative; flex: none; min-height: var(--f-decision); padding: var(--f-card-pad) 0; display: flex; align-items: center;
  justify-content: center; text-align: center; font-size: var(--f-card-title); }
.dcf-decision > svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; }
.dcf-decision > span { position: relative; padding: 0 var(--f-decision-inset); }
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
/* 排版后由 FigureView 给被拉成空盒的 fill 容器加 data-spread：卡片保持自然高度，空隙均匀分配。 */
.dcf-fillable[data-spread] { justify-content: space-evenly; }
/* 卡片的 flex 值写在行内样式上（fill 容器均分高度），只有 !important 才能在 data-spread 时覆盖它。 */
.dcf-fillable[data-spread] > .dcf-card { flex: 0 0 auto !important; }
.dcf-step.is-down.is-stretch { flex: none; flex-direction: column; align-items: center; justify-content: flex-start; }
.dcf-fillable[data-spread] > .dcf-step.is-stretch { flex: 1 1 auto; }
.dcf-shaft { flex: 1 1 auto; width: var(--f-stroke-link); background: currentColor; color: var(--f-link); }
.dcf-step.is-down.is-stretch > svg { flex: none; margin-top: calc(var(--f-stroke-link) * -1); color: var(--f-link); }
.dcf-links { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
`;
