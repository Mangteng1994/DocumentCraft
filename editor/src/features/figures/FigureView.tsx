/**
 * 配图渲染：把图规格排成 DOM，排版完成后测量元素位置画连线，并检查是否放得下。
 *
 * 放不下（画布横向溢出，或卡片文字被挤成过多行）时依次换用更紧的密度；最紧一档仍放不下，
 * 在报告里给出警告，由调用方决定换版式或精简内容。
 */

import {
  createContext, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject,
} from "react";
import { figureTokens } from "../../styles/tokens";
import { defaultTone, figureCss, figureVariables, monochromeTone, toneVariables } from "./figureStyle";
import { figureIcons } from "./icons";
import { clearRoute, labelAnchor, rectsOverlap, type Point, type Rect, type RoutedLink } from "./links";
import type { ArrowBlock, Block, ChainBlock, Direction, FigureSpec, Gap, LinkSpec, RowBlock } from "./spec";

export interface FigureReport {
  /** 实际使用的密度档名称。 */
  density: string;
  fits: boolean;
  warnings: string[];
  /** 不阻止出图的版面建议（如图过高、竖向元素过多），调用方可据此重排一次。 */
  advisories: string[];
  /** 成图尺寸（pt）。 */
  widthPt: number;
  heightPt: number;
}

interface FigureViewProps {
  spec: FigureSpec;
  /** 根元素引用，导出 PNG 时使用。 */
  rootRef?: RefObject<HTMLDivElement | null>;
  maxHeight?: number;
  monochrome?: boolean;
  onReport?: (report: FigureReport) => void;
}

/** 黑白模式：色调与边框改用 tokens 里的黑白调色盘。 */
const MonochromeContext = createContext(false);

function isLeaf(block: Block): boolean {
  return block.kind === "card" || block.kind === "decision";
}

/** fill 容器里的子元素均分高度。被拉成空盒的情况由 relaxStretchedCards 排版后检出并改为自然高度。 */
function fillFlex(child: Block, fill: boolean | undefined): string | undefined {
  if (!fill || child.kind === "arrow") {
    return undefined;
  }
  return "1 1 0";
}

/**
 * 一个组件横向并排的最大列数：行累加各子项，网格取列数，面板、分组、纵向容器取子项中最宽的一个。
 * 用来在没有 weights 时按内容给并列的面板分配宽度。
 */
function acrossCount(block: Block): number {
  if (block.kind === "card" || block.kind === "decision" || block.kind === "arrow") {
    return 1;
  }
  if (block.kind === "grid") {
    return block.columns;
  }
  const widths = block.children.map(acrossCount);
  const sideBySide = block.kind === "row" || (block.kind === "chain" && block.direction === "right");
  if (sideBySide) {
    const children = block.children.filter((child) => child.kind !== "arrow");
    return children.reduce((total, child) => total + acrossCount(child), 0);
  }
  return Math.max(1, ...widths);
}

/**
 * 行没有 weights 时的宽度比例：只在子项是面板或分组且各自内部列数不同时才推断，
 * 否则返回 undefined 保持等分。规格自带 weights 时始终以规格为准。
 */
function inferredWeights(block: RowBlock): number[] | undefined {
  const children = block.children.filter((child) => child.kind !== "arrow");
  const containers = children.every((child) => child.kind === "panel" || child.kind === "group");
  if (!containers) {
    return undefined;
  }
  const counts = children.map(acrossCount);
  const uniform = counts.every((count) => count === counts[0]);
  if (uniform) {
    return undefined;
  }
  return counts;
}

/** 带卡片子元素的 fill 容器，排版后可能被标成 data-spread。 */
function spreadClass(children: Block[], fill: boolean | undefined): string {
  if (fill && children.some(isLeaf)) {
    return " dcf-fillable";
  }
  return "";
}

/** 标题、说明折行超过这些行数视为挤不下。 */
const MAX_TITLE_LINES = 3;
const MAX_DETAIL_LINES = 4;
const MAX_DECISION_LINES = 3;

function px(points: number): number {
  return points * figureTokens.pxPerPt;
}

function gapClass(gap: Gap | undefined, fallback: Gap): string {
  return `dcf-gap-${gap ?? fallback}`;
}

function flexStyle(flex: string | undefined): CSSProperties | undefined {
  if (!flex) {
    return undefined;
  }
  return { flex };
}

/** 在本地坐标里按「向右」画箭头形状，再映射到实际方向。 */
function orient(points: Point[], direction: Direction, length: number): Point[] {
  return points.map(([x, y]) => {
    if (direction === "left") {
      return [length - x, y];
    }
    if (direction === "down") {
      return [y, x];
    }
    if (direction === "up") {
      return [y, length - x];
    }
    return [x, y];
  });
}

function pointList(points: Point[]): string {
  return points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

/** 箭头头部三角形：tip 为尖端，from 为来向上的一点。 */
function arrowHead(tip: Point, from: Point): Point[] {
  const length = px(figureTokens.arrowHead.length);
  const half = px(figureTokens.arrowHead.width) / 2;
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const baseX = tip[0] - length * Math.cos(angle);
  const baseY = tip[1] - length * Math.sin(angle);
  const offsetX = half * Math.sin(angle);
  const offsetY = half * Math.cos(angle);
  return [tip, [baseX + offsetX, baseY - offsetY], [baseX - offsetX, baseY + offsetY]];
}

/** 把折线末端缩回一个箭头长度的大部分，避免线头从三角形尖端露出。 */
function trimEnd(points: Point[], amount: number): Point[] {
  const result = points.slice();
  const last = result[result.length - 1];
  const previous = result[result.length - 2];
  const dx = last[0] - previous[0];
  const dy = last[1] - previous[1];
  const length = Math.hypot(dx, dy);
  if (length <= amount) {
    return result;
  }
  result[result.length - 1] = [last[0] - (dx / length) * amount, last[1] - (dy / length) * amount];
  return result;
}

function SimpleArrow({ direction, length, open = false }: { direction: Direction; length: number; open?: boolean }) {
  const head = px(open ? figureTokens.arrowHead.openWidth : figureTokens.arrowHead.width);
  const stroke = px(open ? figureTokens.stroke.primary : figureTokens.stroke.link);
  const tip: Point = [length, head / 2];
  const tail: Point = [0, head / 2];
  const shaft = orient(open ? [tail, tip] : trimEnd([tail, tip], px(figureTokens.arrowHead.length) * 0.8), direction, length);
  const triangle = orient(arrowHead(tip, [0, head / 2]), direction, length);
  const vertical = direction === "up" || direction === "down";
  const width = vertical ? head : length;
  const height = vertical ? length : head;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={pointList(shaft)} fill="none" stroke="currentColor" strokeWidth={stroke} />
      {open ? (
        <polyline points={pointList(orient([[length - head / 2, 0], tip, [length - head / 2, head]], direction, length))}
          fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinejoin="round" />
      ) : <polygon points={pointList(triangle)} fill="currentColor" />}
    </svg>
  );
}

function HollowArrow({ direction }: { direction: Direction }) {
  const length = px(figureTokens.layoutArrow.hollow);
  const thickness = length * 0.8;
  const shaft = thickness * 0.46;
  const headLength = length * 0.48;
  const top = (thickness - shaft) / 2;
  const bottom = (thickness + shaft) / 2;
  const shape: Point[] = [
    [0, top], [length - headLength, top], [length - headLength, 0], [length, thickness / 2],
    [length - headLength, thickness], [length - headLength, bottom], [0, bottom],
  ];
  const vertical = direction === "up" || direction === "down";
  const width = vertical ? thickness : length;
  const height = vertical ? length : thickness;
  const stroke = px(figureTokens.stroke.link);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polygon points={pointList(orient(shape, direction, length))} fill={figureTokens.paper}
        stroke="currentColor" strokeWidth={stroke} strokeLinejoin="round" />
    </svg>
  );
}

function ArrowView({ block }: { block: ArrowBlock }) {
  const variant = block.style ?? "solid";
  const vertical = block.direction === "up" || block.direction === "down";
  const length = px(figureTokens.layoutArrow[variant]);
  const shape = variant === "hollow"
    ? <HollowArrow direction={block.direction} />
    : <SimpleArrow direction={block.direction} length={length} open={variant === "open"} />;
  const style: CSSProperties = vertical ? { flexDirection: "row" } : {};
  return (
    <div className="dcf-arrow" data-fid={block.id} style={style}>
      {shape}
      {block.label ? <span className="dcf-arrow-label">{block.label}</span> : null}
    </div>
  );
}

/** 顺序链里两张卡片之间的小箭头。 */
function ChainStep(
  { direction, label, stretch }: { direction: "down" | "right"; label: string | null | undefined; stretch?: boolean },
) {
  const length = px(figureTokens.chainArrow);
  if (stretch && direction === "down" && !label) {
    // 撑满的纵向链：箭头杆随空隙拉长，箭头尖端始终贴着下一张卡片。
    const headWidth = px(figureTokens.arrowHead.width);
    const headLength = px(figureTokens.arrowHead.length);
    const tip: Point = [headWidth / 2, headLength];
    const from: Point = [headWidth / 2, 0];
    const head = arrowHead(tip, from);
    const viewBox = `0 0 ${headWidth} ${headLength}`;
    return (
      <div className="dcf-step is-down is-stretch" style={{ minHeight: length }}>
        <div className="dcf-shaft" />
        <svg width={headWidth} height={headLength} viewBox={viewBox}>
          <polygon points={pointList(head)} fill="currentColor" />
        </svg>
      </div>
    );
  }
  const slot = label ? px(figureTokens.chainLabelSlot) : length;
  const size: CSSProperties = direction === "down" ? { minHeight: slot } : { minWidth: slot };
  return (
    <div className={`dcf-step is-${direction}${label ? " has-label" : ""}`} style={size}>
      <SimpleArrow direction={direction} length={length} />
      {label ? <span className="dcf-step-label">{label}</span> : null}
    </div>
  );
}

function ChainView({ block, flex }: { block: ChainBlock; flex?: string }) {
  const items: ReactNode[] = [];
  const stretchSteps = block.direction === "down" && Boolean(block.fill) && block.children.every(isLeaf);
  block.children.forEach((child, index) => {
    if (index > 0) {
      const label = block.labels?.[index - 1];
      items.push(<ChainStep key={`step-${index}`} direction={block.direction} label={label} stretch={stretchSteps} />);
    }
    const childFlex: string | undefined = block.direction === "right" ? "1 1 0" : fillFlex(child, block.fill);
    items.push(<BlockView key={`item-${index}`} block={child} flex={childFlex} />);
  });
  let className = block.direction === "down" ? "dcf-col" : "dcf-row is-center";
  if (stretchSteps) {
    className += " dcf-fillable";
  }
  return (
    <div className={className} data-fid={block.id} style={flexStyle(flex)}>
      {items}
    </div>
  );
}

/** 面板、分组里的内容区：纵向排列，fill 时子元素均分高度。 */
function Body({ children, gap, fill, className }: { children: Block[]; gap?: Gap; fill?: boolean; className: string }) {
  return (
    <div className={`${className} ${gapClass(gap, "normal")}${spreadClass(children, fill)}`}>
      {children.map((child, index) => (
        <BlockView key={index} block={child} flex={fillFlex(child, fill)} />
      ))}
    </div>
  );
}

function BlockView({ block, flex }: { block: Block; flex?: string }) {
  const monochrome = useContext(MonochromeContext);
  switch (block.kind) {
    case "row": {
      const weights = block.weights ?? inferredWeights(block);
      let weightIndex = 0;
      const classes = ["dcf-row", gapClass(block.gap, "normal")];
      const style: CSSProperties = { ...flexStyle(flex) };
      if (block.stretch === false) {
        classes.push("is-center");
      }
      const stageBands = block.stretch !== false && block.children.length >= 5
        && block.children.every((child) => child.kind === "panel" && (child.header ?? "band") === "band");
      if (stageBands) {
        // 阶段共用标题行，最长标题换行时仍能对齐各栏的内容起点。
        classes.push("has-stage-bands");
        style.gridTemplateColumns = block.children.map((_, index) =>
          `minmax(0, ${weights?.[index] ?? 1}fr)`,
        ).join(" ");
      }
      return (
        <div className={classes.join(" ")} data-fid={block.id} style={style}>
          {block.children.map((child, index) => {
            if (child.kind === "arrow") {
              return <BlockView key={index} block={child} />;
            }
            const weight = weights?.[weightIndex] ?? 1;
            weightIndex += 1;
            return <BlockView key={index} block={child} flex={`${weight} 1 0`} />;
          })}
        </div>
      );
    }
    case "column": {
      return (
        <div className={`dcf-col ${gapClass(block.gap, "normal")}${spreadClass(block.children, block.fill)}`} data-fid={block.id} style={flexStyle(flex)}>
          {block.children.map((child, index) => (
            <BlockView key={index} block={child} flex={fillFlex(child, block.fill)} />
          ))}
        </div>
      );
    }
    case "grid": {
      const style: CSSProperties = {
        ...flexStyle(flex),
        gridTemplateColumns: `repeat(${block.columns}, minmax(0, 1fr))`,
      };
      return (
        <div className={`dcf-grid ${gapClass(block.gap, "normal")}`} data-fid={block.id} style={style}>
          {block.children.map((child, index) => <BlockView key={index} block={child} />)}
        </div>
      );
    }
    case "chain":
      return <ChainView block={block} flex={flex} />;
    case "panel": {
      const header = block.header ?? "band";
      const style = { ...toneVariables(block.tone, monochrome), ...flexStyle(flex) };
      const subtitle = block.subtitle ? <span className="dcf-subtitle">{block.subtitle}</span> : null;
      const body = <Body className="dcf-body" gap={block.gap} fill={block.fill}>{block.children}</Body>;
      if (header === "side") {
        return (
          <div className="dcf-panel is-side" data-fid={block.id} style={style}>
            <div className="dcf-side">{block.title}{subtitle}</div>
            {body}
          </div>
        );
      }
      let heading: ReactNode = null;
      if (header === "band") {
        heading = <div className="dcf-band">{block.title}{subtitle}</div>;
      } else if (header === "plain") {
        heading = <div className="dcf-plain">{block.title}{subtitle}</div>;
      }
      return (
        <div className="dcf-panel" data-fid={block.id} style={style}>
          {heading}
          {body}
        </div>
      );
    }
    case "group": {
      return (
        <div className={`dcf-group ${gapClass(block.gap, "normal")}${spreadClass(block.children, block.fill)}`} data-fid={block.id} style={flexStyle(flex)}>
          {block.title ? (
            <div className="dcf-group-title">
              {block.title}
              {block.subtitle ? <span className="dcf-subtitle">{block.subtitle}</span> : null}
            </div>
          ) : null}
          {block.children.map((child, index) => (
            <BlockView key={index} block={child} flex={fillFlex(child, block.fill)} />
          ))}
        </div>
      );
    }
    case "card": {
      const variant = block.variant ?? "filled";
      const Icon = block.icon ? figureIcons[block.icon] : null;
      const details = typeof block.detail === "string" ? [block.detail] : (block.detail ?? []);
      const classes = ["dcf-card", `is-${variant}`];
      if (Icon) {
        classes.push("has-icon");
      }
      if (block.tags?.length) {
        classes.push("has-tags");
      }
      const style = { ...toneVariables(block.tone, monochrome), ...flexStyle(flex) };
      const text = (
        <>
          <div className="dcf-title">{block.title}</div>
          {details.map((line, index) => <div key={index} className="dcf-detail">{line}</div>)}
        </>
      );
      return (
        <div className={classes.join(" ")} data-fid={block.id} style={style}>
          {Icon ? <Icon className="dcf-card-icon" strokeWidth={figureTokens.stroke.icon} /> : null}
          <div className="dcf-card-text">{text}</div>
          {block.tags?.length ? (
            <div className="dcf-tags">
              {block.tags.map((tag, index) => <span key={index} className="dcf-tag">{tag}</span>)}
            </div>
          ) : null}
        </div>
      );
    }
    case "decision": {
      const style = { ...toneVariables(block.tone, monochrome), ...flexStyle(flex) };
      const stroke = px(figureTokens.stroke.card);
      return (
        <div className="dcf-decision" data-fid={block.id} style={style}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <polygon points={figureTokens.decision.points} style={{ fill: "var(--t-surface)", stroke: "var(--f-border)" }}
              strokeWidth={stroke} vectorEffect="non-scaling-stroke" />
          </svg>
          <span>{block.text}</span>
        </div>
      );
    }
    case "arrow":
      return <ArrowView block={block} />;
  }
}

/** 包住 element、但不包住 other 的最外层面板或分组，没有时返回 element 本身。 */
function outermostContainer(element: HTMLElement, other: HTMLElement): HTMLElement {
  let best = element;
  let current = element.parentElement?.closest<HTMLElement>(".dcf-panel, .dcf-group") ?? null;
  while (current && !current.contains(other)) {
    best = current;
    current = current.parentElement?.closest<HTMLElement>(".dcf-panel, .dcf-group") ?? null;
  }
  return best;
}

function relativeRect(element: Element, origin: DOMRect): Rect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    right: rect.right - origin.left,
    bottom: rect.bottom - origin.top,
  };
}

function lineCount(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const lineHeight = parseFloat(style.lineHeight);
  if (!lineHeight) {
    return 1;
  }
  return Math.round(element.getBoundingClientRect().height / lineHeight);
}

/** 菱形只有中部能放字，按实测文字高度撑开判断框。每次排版前先清掉上一次的高度。 */
function fitDecisions(root: HTMLElement): void {
  for (const decision of root.querySelectorAll<HTMLElement>(".dcf-decision")) {
    decision.style.minHeight = "";
    const text = decision.querySelector<HTMLElement>(":scope > span");
    if (!text) {
      continue;
    }
    const wanted = text.offsetHeight * figureTokens.decision.heightPerText;
    decision.style.minHeight = `${wanted}px`;
  }
}

/** 卡片内容的自然高度：图标行取最高的一项，纵向排列取各项之和，再加上下内边距。 */
function naturalCardHeight(card: HTMLElement): number {
  const style = getComputedStyle(card);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const heights = Array.from(card.children, (child) => (child as HTMLElement).offsetHeight);
  const rowLayout = style.flexDirection === "row";
  let content = heights.reduce((total, height) => total + height, 0);
  if (rowLayout) {
    content = Math.max(0, ...heights);
  }
  return content + padding;
}

/** 卡片是否被撑满成空盒：高度够高，且超过自然高度的 maxStretch 倍。 */
function isStretchedCard(card: HTMLElement): boolean {
  const heightPt = card.offsetHeight / figureTokens.pxPerPt;
  if (heightPt < figureTokens.minBlankHeight) {
    return false;
  }
  const naturalHeight = naturalCardHeight(card);
  return card.offsetHeight > naturalHeight * figureTokens.maxStretch;
}

/**
 * 同栏内容少、邻栏内容多时，撑满等高会把卡片拉成大空盒。某张卡片高度超过自然高度的 maxStretch 倍时，
 * 该容器改为卡片保持自然高度、空隙均匀分配（样式见 data-spread）。其余情况保持等高。
 * 属性写在 DOM 上，每次排版前先清掉。
 */
function relaxStretchedCards(root: HTMLElement): void {
  for (const container of root.querySelectorAll<HTMLElement>(".dcf-fillable")) {
    container.removeAttribute("data-spread");
  }
  for (const container of root.querySelectorAll<HTMLElement>(".dcf-fillable")) {
    const children = Array.from(container.children) as HTMLElement[];
    const cards = children.filter((child) => child.classList.contains("dcf-card"));
    if (cards.some(isStretchedCard)) {
      container.setAttribute("data-spread", "");
    }
  }
}

/**
 * 标签一行放不下时改成逐行堆叠。折行后分隔线会落在行首，所以按实测的行位置判断。
 * 属性写在 DOM 上而不是 React 状态里，每次排版前先清掉，换密度后重新判断。
 */
function stackWrappedTags(root: HTMLElement): void {
  for (const tags of root.querySelectorAll<HTMLElement>(".dcf-tags")) {
    tags.removeAttribute("data-stacked");
    const tops = new Set(Array.from(tags.children, (tag) => Math.round((tag as HTMLElement).offsetTop)));
    if (tops.size > 1) {
      tags.setAttribute("data-stacked", "");
    }
  }
}

/**
 * 版面建议：不影响能否出图，但说明图形比例或元素分布不理想。
 * 调用方可以带着这些建议重排一次，重排失败时仍保留原图。
 */
function layoutAdvice(root: HTMLElement): string[] {
  const advice: string[] = [];
  for (const container of root.querySelectorAll(".dcf-fillable[data-spread]")) {
    advice.push(`「${container.textContent?.slice(0, 12)}」所在栏内容明显少于邻栏，请与同栏条目合并或平衡各栏条目数`);
  }
  for (const decision of root.querySelectorAll<HTMLElement>(".dcf-decision > span")) {
    const lines = lineCount(decision);
    if (lines > MAX_DECISION_LINES) {
      advice.push(`判断「${decision.textContent}」折成 ${lines} 行，菱形被撑得又高又窄，请缩短判断文字`);
    }
  }
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  if (width > 0 && height / width > figureTokens.maxTallAspect) {
    const ratio = (height / width).toFixed(2);
    advice.push(`图形偏高（高宽比 ${ratio}，参考图约 0.45–0.65）。请改成多栏并排或 2×N 网格，把长流程分到相邻栏`);
  }
  for (const column of root.querySelectorAll<HTMLElement>(".dcf-col")) {
    const stacked = Array.from(column.children).filter((child) => child.classList.contains("dcf-card")).length;
    if (stacked > figureTokens.maxStackedChain) {
      advice.push(`同一栏纵向叠了 ${stacked} 个卡片，请拆成两栏或合并相近条目`);
    }
  }
  for (const card of root.querySelectorAll<HTMLElement>(".dcf-card")) {
    const cardHeight = card.offsetHeight;
    const text = card.querySelector<HTMLElement>(".dcf-card-text");
    if (!text || cardHeight / figureTokens.pxPerPt < figureTokens.minBlankHeight) {
      continue;
    }
    if (text.offsetHeight / cardHeight < figureTokens.minTextFill) {
      advice.push(`卡片「${card.textContent?.slice(0, 12)}」留白过大，请与同栏条目合并或改用等分网格`);
    }
  }
  return [...new Set(advice)];
}

/** 连线走线需要的排版测量结果。 */
interface RoutingContext {
  endpoints: Map<string, HTMLElement>;
  shapes: HTMLElement[];
  origin: DOMRect;
  metrics: { stub: number; lane: number };
  bounds: Rect;
  clearance: number;
}

interface RoutingResult {
  routed: RoutedLink[];
  failed: LinkSpec[];
  /** 放开指定出入边后才走通的连线。 */
  relaxed: LinkSpec[];
}

/** 为一条连线找走法：原端点直走，其次提到所在面板边缘，最后沿空白走廊绕行。 */
function routeOneLink(link: LinkSpec, context: RoutingContext, routed: RoutedLink[]): Point[] | null {
  const { endpoints, shapes, origin, metrics, bounds, clearance } = context;
  const source = endpoints.get(link.from) as HTMLElement;
  const target = endpoints.get(link.to) as HTMLElement;
  const route = (from: HTMLElement, to: HTMLElement, directOnly: boolean) => {
    const obstacles = shapes.filter((item) => ![from, to].some((end) => item.contains(end) || end.contains(item)));
    const obstacleRects = obstacles.map((item) => relativeRect(item, origin));
    return clearRoute(
      link, relativeRect(from, origin), relativeRect(to, origin), metrics, bounds,
      obstacleRects, routed, clearance, directOnly,
    );
  };
  // 端点藏在面板深处时，直线常被面板标题栏挡住而绕出画布边缘。先试把端点提到所在面板的边缘，
  // 参考图里跨区箭头也是落在分区边界上；都不通再回到原端点绕行。
  const liftedSource = outermostContainer(source, target);
  const liftedTarget = outermostContainer(target, source);
  const variants: [HTMLElement, HTMLElement][] = [[source, target]];
  // 指定了出入点位置（fromAt、toAt）的连线，位置比例针对原元素，提到更大的面板后含义会变，不提升。
  const explicitPosition = link.fromAt !== undefined || link.toAt !== undefined;
  if (!explicitPosition && liftedTarget !== target) {
    variants.push([source, liftedTarget]);
  }
  if (!explicitPosition && liftedSource !== source) {
    variants.push([liftedSource, target]);
  }
  if (!explicitPosition && liftedSource !== source && liftedTarget !== target) {
    variants.push([liftedSource, liftedTarget]);
  }
  for (const [from, to] of variants) {
    const direct = route(from, to, true);
    if (direct) {
      return direct;
    }
  }
  return route(source, target, false);
}

/** 按给定次序逐条走线。后走的连线必须避开先走的，所以次序会决定谁走不通。 */
function routeInOrder(links: LinkSpec[], context: RoutingContext): RoutingResult {
  const result: RoutingResult = { routed: [], failed: [], relaxed: [] };
  for (const link of links) {
    let points = routeOneLink(link, context, result.routed);
    if (!points && (link.fromSide || link.toSide)) {
      // 指定的出入边走不通时，放开边的限制再试，方向仍是 from 到 to。
      const loose: LinkSpec = { ...link, fromSide: undefined, toSide: undefined };
      points = routeOneLink(loose, context, result.routed);
      if (points) {
        result.relaxed.push(link);
      }
    }
    if (points) {
      result.routed.push({ link, points });
    } else {
      result.failed.push(link);
    }
  }
  return result;
}

/**
 * 连线不交叉、不穿卡片。规格次序走不通时，换次序重走：先走失败的，再走反序，取失败最少的一次。
 * 仍有失败的连线交给调用方，由它带着失败信息让模型重新排列。
 */
function routeAllLinks(links: LinkSpec[], context: RoutingContext): RoutingResult {
  let best = routeInOrder(links, context);
  if (best.failed.length === 0) {
    return best;
  }
  const failedFirst = [...best.failed, ...links.filter((link) => !best.failed.includes(link))];
  const reversed = [...links].reverse();
  for (const order of [failedFirst, reversed]) {
    const attempt = routeInOrder(order, context);
    if (attempt.failed.length < best.failed.length) {
      best = attempt;
    }
    if (best.failed.length === 0) {
      break;
    }
  }
  return best;
}

/** 检查排版是否放得下，返回问题列表。 */
function fitProblems(root: HTMLElement, maxHeight: number | undefined): string[] {
  const problems: string[] = [];
  if (root.scrollWidth > root.clientWidth + 1) {
    const overflow = (root.scrollWidth - root.clientWidth) / figureTokens.pxPerPt;
    problems.push(`内容比画布宽 ${overflow.toFixed(0)}pt`);
  }
  if (maxHeight !== undefined && root.offsetHeight / figureTokens.pxPerPt > maxHeight) {
    problems.push("图高超过该页可用版心，请减少层数或合并重复内容");
  }
  for (const title of root.querySelectorAll<HTMLElement>(".dcf-title")) {
    const lines = lineCount(title);
    if (lines > MAX_TITLE_LINES) {
      problems.push(`「${title.textContent}」折成 ${lines} 行`);
    }
  }
  for (const detail of root.querySelectorAll<HTMLElement>(".dcf-detail")) {
    const lines = lineCount(detail);
    if (lines > MAX_DETAIL_LINES) {
      problems.push(`说明「${detail.textContent?.slice(0, 12)}…」折成 ${lines} 行`);
    }
  }
  for (const card of root.querySelectorAll<HTMLElement>(".dcf-card, .dcf-panel, .dcf-decision")) {
    if (card.scrollWidth > card.clientWidth + 1) {
      problems.push(`「${card.textContent?.slice(0, 22)}」超出所在区域`);
    }
    if (card.classList.contains("dcf-card") && card.offsetWidth < px(figureTokens.minCardWidth)) {
      problems.push(`卡片「${card.textContent?.slice(0, 22)}」太窄`);
    }
  }
  const origin = root.getBoundingClientRect();
  const cardCount = root.querySelectorAll(".dcf-card, .dcf-decision").length;
  if (maxHeight !== undefined && cardCount >= 4 && origin.width / origin.height > figureTokens.maxWideAspect) {
    problems.push("图形过于扁长，请把长流程拆成上下两层或多个阶段");
  }
  const shapes = Array.from(root.querySelectorAll(".dcf-card, .dcf-decision, .dcf-band, .dcf-side, .dcf-plain, .dcf-group-title"));
  const occupied = shapes.map((item) => relativeRect(item, origin));
  const labels = Array.from(root.querySelectorAll(".dcf-step-label, .dcf-arrow-label"));
  for (const label of labels) {
    if (occupied.some((box) => rectsOverlap(relativeRect(label, origin), box))) {
      problems.push(`箭头标签「${label.textContent}」遮挡其他元素`);
    }
  }
  if (occupied.some((box, index) => occupied.slice(0, index).some((other) => rectsOverlap(box, other)))) {
    problems.push("卡片或标题栏互相遮挡");
  }
  const text = root.querySelectorAll(".dcf-title, .dcf-detail, .dcf-tag, .dcf-step-label, .dcf-arrow-label, .dcf-decision > span");
  if (Array.from(text).some((item) => parseFloat(getComputedStyle(item).fontSize) < px(figureTokens.minFont) - 0.1)) {
    problems.push("图中文字低于最小印刷字号");
  }
  return [...new Set(problems)];
}

export function FigureView({ spec, rootRef, maxHeight, monochrome, onReport }: FigureViewProps) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const root = rootRef ?? ownRef;
  const [density, setDensity] = useState(0);
  const [layout, setLayout] = useState<{
    routes: RoutedLink[]; width: number; height: number; warnings: string[]; advisories: string[];
  } | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const width = spec.width ?? figureTokens.width;

  useEffect(() => {
    setDensity(0);
  }, [spec]);

  useEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => {
      if (active) {
        setFontsReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !fontsReady) {
      return;
    }
    relaxStretchedCards(element);
    fitDecisions(element);
    stackWrappedTags(element);
    const problems = fitProblems(element, maxHeight);
    const lastDensity = figureTokens.density.length - 1;
    if (problems.length > 0 && density < lastDensity) {
      setDensity(density + 1);
      return;
    }
    const origin = element.getBoundingClientRect();
    const endpoints = new Map<string, HTMLElement>();
    for (const item of element.querySelectorAll<HTMLElement>("[data-fid]")) {
      endpoints.set(item.dataset.fid as string, item);
    }
    const shapes = Array.from(element.querySelectorAll<HTMLElement>(
      ".dcf-panel, .dcf-group, .dcf-card, .dcf-decision, .dcf-band, .dcf-side, .dcf-plain, .dcf-group-title, .dcf-step, .dcf-arrow",
    ));
    const metrics = { stub: px(figureTokens.linkStub), lane: px(figureTokens.linkLane) };
    const clearance = px(figureTokens.linkClearance);
    const bounds = { left: clearance, top: clearance, right: origin.width - clearance, bottom: origin.height - clearance };
    const warnings = [...problems];
    const links = (spec.links ?? []).filter((link) => {
      const present = endpoints.has(link.from) && endpoints.has(link.to);
      if (!present) {
        warnings.push(`连线 ${link.from} → ${link.to} 的端点不存在`);
      }
      return present;
    });
    const context: RoutingContext = { endpoints, shapes, origin, metrics, bounds, clearance };
    const result = routeAllLinks(links, context);
    const routed = result.routed;
    for (const link of result.failed) {
      // 连线不得交叉或穿过卡片。几种走法和次序都试过仍找不到走线空间，属于排版失败，由调用方重新排列。
      warnings.push(`连线 ${link.from} → ${link.to} 缺少可避开其他元素的走线空间`);
    }
    const advisories = result.relaxed.map((link) => `连线 ${link.from} → ${link.to} 未按指定的边出入`);
    setLayout({
      routes: routed, width: element.offsetWidth, height: element.offsetHeight, warnings,
      advisories: [...advisories, ...layoutAdvice(element)],
    });
  }, [spec, density, fontsReady, root, maxHeight]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !layout) {
      return;
    }
    const origin = element.getBoundingClientRect();
    const shapes = element.querySelectorAll(".dcf-card, .dcf-decision, .dcf-band, .dcf-side, .dcf-plain, .dcf-group-title");
    const occupied = Array.from(shapes, (item) => relativeRect(item, origin));
    const warnings = [...layout.warnings];
    const advisories = [...layout.advisories];
    for (const label of element.querySelectorAll(".dcf-links text")) {
      const box = relativeRect(label, origin);
      if (occupied.some((other) => rectsOverlap(box, other)) || box.left < 0 || box.top < 0
        || box.right > origin.width || box.bottom > origin.height) {
        warnings.push(`连线标签「${label.textContent}」遮挡元素或超出画布`);
      }
      occupied.push(box);
    }
    onReport?.({
      density: figureTokens.density[density].name,
      fits: warnings.length === 0,
      warnings,
      advisories,
      widthPt: layout.width / figureTokens.pxPerPt,
      heightPt: layout.height / figureTokens.pxPerPt,
    });
    // onReport 由调用方传入，变化不应触发重新排版。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, root]);

  const style = { ...figureVariables(width, density, monochrome), ...(monochrome ? monochromeTone : defaultTone) };
  return (
    <MonochromeContext.Provider value={Boolean(monochrome)}>
      <div className="dcf" ref={root} style={style}>
        <style>{figureCss}</style>
        <BlockView block={spec.root} />
        {layout && <LinkLayer routes={layout.routes} width={layout.width} height={layout.height} labelPt={figureTokens.density[density].label} />}
      </div>
    </MonochromeContext.Provider>
  );
}

function LinkLayer({ routes, width, height, labelPt }: { routes: RoutedLink[]; width: number; height: number; labelPt: number }) {
  const headLength = px(figureTokens.arrowHead.length);
  const labelSize = px(labelPt);
  return (
    <svg className="dcf-links" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {routes.map(({ link, points }, index) => {
        const primary = link.style === "primary";
        const marker = link.style === "marker";
        const stroke = px(primary ? figureTokens.stroke.primary : figureTokens.stroke.link);
        const dash = link.style === "dashed" ? figureTokens.dash.map(px).join(" ") : undefined;
        let line = trimEnd(points, headLength * 0.8);
        if (link.both) {
          line = trimEnd(line.slice().reverse(), headLength * 0.8).reverse();
        }
        const tip = points[points.length - 1];
        const beforeTip = points[points.length - 2];
        const markerTip: Point = [(tip[0] * 2 + beforeTip[0]) / 3, (tip[1] * 2 + beforeTip[1]) / 3];
        const end = arrowHead(marker ? markerTip : tip, beforeTip);
        const start = link.both ? arrowHead(points[0], points[1]) : null;
        const anchor = link.label ? labelAnchor(points) : null;
        return (
          <g key={index} color={figureTokens.link}>
            {!marker && <polyline points={pointList(line)} fill="none" stroke="currentColor" strokeWidth={stroke}
              strokeDasharray={dash} strokeLinejoin="round" />}
            <polygon points={pointList(end)} fill="currentColor" />
            {start ? <polygon points={pointList(start)} fill="currentColor" /> : null}
            {anchor ? (
              <text x={anchor[0]} y={anchor[1]} dy="0.35em" textAnchor="middle" fontSize={labelSize}
                fill={figureTokens.inkMuted} stroke={figureTokens.paper} strokeWidth={labelSize * 0.35}
                paintOrder="stroke" fontFamily={figureTokens.font}>
                {link.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
