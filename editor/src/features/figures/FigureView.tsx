/**
 * 配图渲染：把图规格排成 DOM，排版完成后测量元素位置画连线，并检查是否放得下。
 *
 * 放不下（画布横向溢出，或卡片文字被挤成过多行）时依次换用更紧的密度；最紧一档仍放不下，
 * 在报告里给出警告，由调用方决定换版式或精简内容。
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { figureTokens } from "../../styles/tokens";
import { defaultTone, figureCss, figureVariables, toneVariables } from "./figureStyle";
import { figureIcons } from "./icons";
import { clearRoute, labelAnchor, rectsOverlap, type Point, type Rect, type RoutedLink } from "./links";
import type { ArrowBlock, Block, ChainBlock, Direction, FigureSpec, Gap } from "./spec";

export interface FigureReport {
  /** 实际使用的密度档名称。 */
  density: string;
  fits: boolean;
  warnings: string[];
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

/** 标题、说明折行超过这些行数视为挤不下。 */
const MAX_TITLE_LINES = 3;
const MAX_DETAIL_LINES = 4;

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

function SimpleArrow({ direction, length }: { direction: Direction; length: number }) {
  const head = px(figureTokens.arrowHead.width);
  const stroke = px(figureTokens.stroke.link);
  const tip: Point = [length, head / 2];
  const shaft = orient(trimEnd([[0, head / 2], tip], px(figureTokens.arrowHead.length) * 0.8), direction, length);
  const triangle = orient(arrowHead(tip, [0, head / 2]), direction, length);
  const vertical = direction === "up" || direction === "down";
  const width = vertical ? head : length;
  const height = vertical ? length : head;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={pointList(shaft)} fill="none" stroke="currentColor" strokeWidth={stroke} />
      <polygon points={pointList(triangle)} fill="currentColor" />
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
  const hollow = block.style === "hollow";
  const vertical = block.direction === "up" || block.direction === "down";
  const length = px(hollow ? figureTokens.layoutArrow.hollow : figureTokens.layoutArrow.solid);
  const shape = hollow
    ? <HollowArrow direction={block.direction} />
    : <SimpleArrow direction={block.direction} length={length} />;
  const style: CSSProperties = vertical ? { flexDirection: "row" } : {};
  return (
    <div className="dcf-arrow" data-fid={block.id} style={style}>
      {shape}
      {block.label ? <span className="dcf-arrow-label">{block.label}</span> : null}
    </div>
  );
}

/** 顺序链里两张卡片之间的小箭头。 */
function ChainStep({ direction, label }: { direction: "down" | "right"; label: string | null | undefined }) {
  const length = px(figureTokens.chainArrow);
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
  const childFlex = block.direction === "right" || block.fill ? "1 1 0" : undefined;
  block.children.forEach((child, index) => {
    if (index > 0) {
      const label = block.labels?.[index - 1];
      items.push(<ChainStep key={`step-${index}`} direction={block.direction} label={label} />);
    }
    items.push(<BlockView key={`item-${index}`} block={child} flex={childFlex} />);
  });
  const className = block.direction === "down" ? "dcf-col" : "dcf-row is-center";
  return (
    <div className={className} data-fid={block.id} style={flexStyle(flex)}>
      {items}
    </div>
  );
}

/** 面板、分组里的内容区：纵向排列，fill 时子元素均分高度。 */
function Body({ children, gap, fill, className }: { children: Block[]; gap?: Gap; fill?: boolean; className: string }) {
  const childFlex = fill ? "1 1 0" : undefined;
  return (
    <div className={`${className} ${gapClass(gap, "normal")}`}>
      {children.map((child, index) => (
        <BlockView key={index} block={child} flex={child.kind === "arrow" ? undefined : childFlex} />
      ))}
    </div>
  );
}

function BlockView({ block, flex }: { block: Block; flex?: string }) {
  switch (block.kind) {
    case "row": {
      let weightIndex = 0;
      const className = block.stretch === false ? "dcf-row is-center" : "dcf-row";
      return (
        <div className={`${className} ${gapClass(block.gap, "normal")}`} data-fid={block.id} style={flexStyle(flex)}>
          {block.children.map((child, index) => {
            if (child.kind === "arrow") {
              return <BlockView key={index} block={child} />;
            }
            const weight = block.weights?.[weightIndex] ?? 1;
            weightIndex += 1;
            return <BlockView key={index} block={child} flex={`${weight} 1 0`} />;
          })}
        </div>
      );
    }
    case "column": {
      const childFlex = block.fill ? "1 1 0" : undefined;
      return (
        <div className={`dcf-col ${gapClass(block.gap, "normal")}`} data-fid={block.id} style={flexStyle(flex)}>
          {block.children.map((child, index) => (
            <BlockView key={index} block={child} flex={child.kind === "arrow" ? undefined : childFlex} />
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
      const style = { ...toneVariables(block.tone), ...flexStyle(flex) };
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
      const childFlex = block.fill ? "1 1 0" : undefined;
      return (
        <div className={`dcf-group ${gapClass(block.gap, "normal")}`} data-fid={block.id} style={flexStyle(flex)}>
          {block.title ? (
            <div className="dcf-group-title">
              {block.title}
              {block.subtitle ? <span className="dcf-subtitle">{block.subtitle}</span> : null}
            </div>
          ) : null}
          {block.children.map((child, index) => (
            <BlockView key={index} block={child} flex={child.kind === "arrow" ? undefined : childFlex} />
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
      const style = { ...toneVariables(block.tone), ...flexStyle(flex) };
      const text = (
        <>
          <div className="dcf-title">{block.title}</div>
          {details.map((line, index) => <div key={index} className="dcf-detail">{line}</div>)}
        </>
      );
      return (
        <div className={classes.join(" ")} data-fid={block.id} style={style}>
          {Icon ? <Icon className="dcf-card-icon" strokeWidth={figureTokens.stroke.icon} /> : null}
          {Icon ? <div className="dcf-card-text">{text}</div> : text}
          {block.tags?.length ? (
            <div className="dcf-tags">
              {block.tags.map((tag, index) => <span key={index} className="dcf-tag">{tag}</span>)}
            </div>
          ) : null}
        </div>
      );
    }
    case "decision": {
      const style = { ...toneVariables(block.tone), ...flexStyle(flex) };
      const stroke = px(figureTokens.stroke.card);
      return (
        <div className="dcf-decision" data-fid={block.id} style={style}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <polygon points="50,0 100,50 50,100 0,50" style={{ fill: "var(--t-card)", stroke: "var(--t-border)" }}
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
  const [layout, setLayout] = useState<{ routes: RoutedLink[]; width: number; height: number; warnings: string[] } | null>(null);
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
    const routed: RoutedLink[] = [];
    const warnings = [...problems];
    for (const link of spec.links ?? []) {
      const source = endpoints.get(link.from);
      const target = endpoints.get(link.to);
      if (!source || !target) {
        warnings.push(`连线 ${link.from} → ${link.to} 的端点不存在`);
        continue;
      }
      const obstacles = shapes.filter((item) => ![source, target].some((end) => item.contains(end) || end.contains(item)));
      const points = clearRoute(
        link, relativeRect(source, origin), relativeRect(target, origin), metrics, bounds,
        obstacles.map((item) => relativeRect(item, origin)), routed, clearance,
      );
      if (points) {
        routed.push({ link, points });
      } else {
        warnings.push(`连线 ${link.from} → ${link.to} 缺少可避开其他元素的走线空间`);
      }
    }
    setLayout({ routes: routed, width: element.offsetWidth, height: element.offsetHeight, warnings });
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
      widthPt: layout.width / figureTokens.pxPerPt,
      heightPt: layout.height / figureTokens.pxPerPt,
    });
    // onReport 由调用方传入，变化不应触发重新排版。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, root]);

  const style = { ...figureVariables(width, density), ...defaultTone, filter: monochrome ? "grayscale(1)" : undefined };
  return (
    <div className="dcf" ref={root} style={style}>
      <style>{figureCss}</style>
      <BlockView block={spec.root} />
      {layout && <LinkLayer routes={layout.routes} width={layout.width} height={layout.height} labelPt={figureTokens.density[density].label} />}
    </div>
  );
}

function LinkLayer({ routes, width, height, labelPt }: { routes: RoutedLink[]; width: number; height: number; labelPt: number }) {
  const headLength = px(figureTokens.arrowHead.length);
  const labelSize = px(labelPt);
  return (
    <svg className="dcf-links" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {routes.map(({ link, points }, index) => {
        const primary = link.style === "primary";
        const stroke = px(primary ? figureTokens.stroke.primary : figureTokens.stroke.link);
        const dash = link.style === "dashed" ? figureTokens.dash.map(px).join(" ") : undefined;
        let line = trimEnd(points, headLength * 0.8);
        if (link.both) {
          line = trimEnd(line.slice().reverse(), headLength * 0.8).reverse();
        }
        const end = arrowHead(points[points.length - 1], points[points.length - 2]);
        const start = link.both ? arrowHead(points[0], points[1]) : null;
        const anchor = link.label ? labelAnchor(points) : null;
        return (
          <g key={index} color={figureTokens.link}>
            <polyline points={pointList(line)} fill="none" stroke="currentColor" strokeWidth={stroke}
              strokeDasharray={dash} strokeLinejoin="round" />
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
