/**
 * 连线走线：在排版完成后，按元素的实际位置计算直角折线。
 *
 * 规则从参考图归纳：两元素在连线方向上有重叠时走直线，并对准较窄一方的中心；
 * 没有重叠时在两者之间的空白走廊里折一次；同向出入（如右边连到右边）在外侧绕 U 形。
 * 首选路径被阻挡时，沿实测元素边界寻找空白走廊，并避开已绘制的连线。
 */

import { figureTokens } from "../../styles/tokens";
import type { LinkSpec, Side } from "./spec";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Point = [number, number];

export interface RoutedLink {
  points: Point[];
  link: LinkSpec;
}

/** 走线用到的长度（CSS 像素）。 */
export interface RouteMetrics {
  stub: number;
  lane: number;
  /** 带折点的连线，最后一段（箭头头部所在的直线段）至少要有这么长，否则箭头头部压在拐角上。 */
  tail: number;
}

type Segment = [Point, Point];

function segments(points: Point[]): Segment[] {
  return points.slice(1).map((point, index) => [points[index], point]);
}

/** 判断两块排版区域的内部是否相交，允许边缘贴合。 */
export function rectsOverlap(first: Rect, second: Rect): boolean {
  return first.left < second.right && second.left < first.right
    && first.top < second.bottom && second.top < first.bottom;
}

function segmentHits([a, b]: Segment, rect: Rect): boolean {
  if (a[0] === b[0]) {
    return a[0] > rect.left && a[0] < rect.right
      && Math.min(a[1], b[1]) < rect.bottom && Math.max(a[1], b[1]) > rect.top;
  }
  return a[1] > rect.top && a[1] < rect.bottom
    && Math.min(a[0], b[0]) < rect.right && Math.max(a[0], b[0]) > rect.left;
}

function crosses([a, b]: Segment, [c, d]: Segment): boolean {
  const horizontal = a[1] === b[1];
  const otherHorizontal = c[1] === d[1];
  if (horizontal === otherHorizontal) {
    const axis = horizontal ? 0 : 1;
    const fixed = 1 - axis;
    return a[fixed] === c[fixed]
      && Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]))
        < Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]));
  }
  if (!horizontal) {
    return crosses([c, d], [a, b]);
  }
  const meets = Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0])
    && Math.min(c[1], d[1]) <= a[1] && a[1] <= Math.max(c[1], d[1]);
  const sharedEndpoint = [a, b].some(([x, y]) => [c, d].some((point) => point[0] === x && point[1] === y));
  return meets && !sharedEndpoint;
}

/** 折线中间段短于这个长度（CSS 像素）会呈现为难以辨认的小钩，走线时视为不可用。 */
const MIN_JOG = figureTokens.minJog * figureTokens.pxPerPt;

/**
 * 优先选无阻挡且无交叉的短折线，找不到时交给版式修订。
 * directOnly 为真时只尝试首选折线，不绕行；用于先试「把端点提到所在面板边缘」这类更干净的画法。
 * 连线不允许与已画出的连线交叉，也不允许穿过卡片；找不到这样的走法就返回 null，由调用方重新排列。
 */
export function clearRoute(
  link: LinkSpec, source: Rect, target: Rect, metrics: RouteMetrics, bounds: Rect,
  obstacles: Rect[], previous: RoutedLink[], clearance: number, directOnly = false,
): Point[] | null {
  const earlier = previous.flatMap(({ points }) => segments(points));
  const blockers = [source, target, ...obstacles];
  const candidates: Point[][] = [];
  const [autoFrom, autoTo] = autoSides(source, target);
  const sides = ["left", "right", "top", "bottom"] as const;
  const fromSides = link.fromSide ? [link.fromSide] : [autoFrom, ...sides.filter((side) => side !== autoFrom)];
  const toSides = link.toSide ? [link.toSide] : [autoTo, ...sides.filter((side) => side !== autoTo)];
  const xLanes = [bounds.left, bounds.right, ...obstacles.flatMap((rect) => [rect.left - clearance, rect.right + clearance])];
  const yLanes = [bounds.top, bounds.bottom, ...obstacles.flatMap((rect) => [rect.top - clearance, rect.bottom + clearance])];
  const preferred = routeLink(link, source, target, metrics);

  function clean(points: Point[]): Point[] {
    const cleaned: Point[] = [];
    for (const point of points) {
      const previous = cleaned.at(-1);
      if (previous && previous[0] === point[0] && previous[1] === point[1]) {
        continue;
      }
      const earlier = cleaned.at(-2);
      if (previous && earlier) {
        const vertical = earlier[0] === previous[0] && previous[0] === point[0]
          && (previous[1] - earlier[1]) * (point[1] - previous[1]) > 0;
        const horizontal = earlier[1] === previous[1] && previous[1] === point[1]
          && (previous[0] - earlier[0]) * (point[0] - previous[0]) > 0;
        if (vertical || horizontal) {
          cleaned.pop();
        }
      }
      cleaned.push(point);
    }
    return cleaned;
  }

  function usable(points: Point[]): boolean {
    if (points.length < 2 || points.some(([x, y]) => x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)) {
      return false;
    }
    const edges = segments(points);
    const lastEdge = edges[edges.length - 1];
    const lastLength = Math.abs(lastEdge[0][0] - lastEdge[1][0]) + Math.abs(lastEdge[0][1] - lastEdge[1][1]);
    if (edges.length > 1 && lastLength < metrics.tail) {
      return false;
    }
    const interiorTooShort = edges.slice(1, -1).some(([a, b]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < MIN_JOG);
    if (interiorTooShort) {
      return false;
    }
    return edges.every((segment) => {
      const blocked = blockers.some((rect) => segmentHits(segment, rect));
      const crossing = earlier.some((edge) => crosses(segment, edge));
      return !blocked && !crossing;
    });
  }

  const direct = clean(preferred);
  if (usable(direct)) {
    return direct;
  }
  if (directOnly) {
    return null;
  }

  function stub(point: Point, side: Side): Point {
    const delta = side === "right" || side === "bottom" ? clearance : -clearance;
    return isHorizontal(side) ? [point[0] + delta, point[1]] : [point[0], point[1] + delta];
  }

  for (const fromSide of fromSides) {
    for (const toSide of toSides) {
      const start = sidePoint(source, fromSide, link.fromAt);
      const end = sidePoint(target, toSide, link.toAt);
      const a = stub(start, fromSide);
      const b = stub(end, toSide);
      candidates.push(
        routeLink({ ...link, fromSide, toSide }, source, target, metrics),
        [start, a, [a[0], b[1]], b, end],
        [start, a, [b[0], a[1]], b, end],
      );
      for (const x of xLanes) {
        candidates.push([start, a, [x, a[1]], [x, b[1]], b, end]);
      }
      for (const y of yLanes) {
        candidates.push([start, a, [a[0], y], [b[0], y], b, end]);
      }
    }
  }
  let best: Point[] | null = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const points = clean(candidate);
    const score = points.length * metrics.stub + segments(points).reduce((length, [a, b]) =>
      length + Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]), 0);
    if (score < bestScore && usable(points)) {
      best = points;
      bestScore = score;
    }
  }
  return best;
}

const HORIZONTAL: Side[] = ["left", "right"];
const EDGE_MARGIN = 2;

function isHorizontal(side: Side): boolean {
  return HORIZONTAL.includes(side);
}

function opposite(side: Side): Side {
  const pairs: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };
  return pairs[side];
}

/** 按相对位置选出入边：目标在右侧就从右出、从左入，依此类推。 */
function autoSides(source: Rect, target: Rect): [Side, Side] {
  const tolerance = 1;
  if (target.left >= source.right - tolerance) {
    return ["right", "left"];
  }
  if (target.right <= source.left + tolerance) {
    return ["left", "right"];
  }
  if (target.top >= source.bottom - tolerance) {
    return ["bottom", "top"];
  }
  if (target.bottom <= source.top + tolerance) {
    return ["top", "bottom"];
  }
  const sourceCenter = (source.top + source.bottom) / 2;
  const targetCenter = (target.top + target.bottom) / 2;
  if (targetCenter >= sourceCenter) {
    return ["bottom", "top"];
  }
  return ["top", "bottom"];
}

/** 边上的点。at 为 0 到 1 的位置，缺省取中点。 */
function sidePoint(rect: Rect, side: Side, at: number | undefined): Point {
  const ratio = at ?? 0.5;
  if (side === "left" || side === "right") {
    const x = side === "left" ? rect.left : rect.right;
    const y = rect.top + (rect.bottom - rect.top) * ratio;
    return [x, y];
  }
  const y = side === "top" ? rect.top : rect.bottom;
  const x = rect.left + (rect.right - rect.left) * ratio;
  return [x, y];
}

/**
 * 两元素在垂直于连线方向上的重叠区间里取一条直线位置：对准较窄一方的中心，
 * 再夹进重叠区间。没有足够重叠时返回 null。
 */
function sharedCoordinate(source: Rect, target: Rect, horizontal: boolean): number | null {
  const low = horizontal ? Math.max(source.top, target.top) : Math.max(source.left, target.left);
  const high = horizontal ? Math.min(source.bottom, target.bottom) : Math.min(source.right, target.right);
  if (high - low < EDGE_MARGIN * 4) {
    return null;
  }
  const sourceSpan = horizontal ? source.bottom - source.top : source.right - source.left;
  const targetSpan = horizontal ? target.bottom - target.top : target.right - target.left;
  const narrower = sourceSpan <= targetSpan ? source : target;
  const center = horizontal ? (narrower.top + narrower.bottom) / 2 : (narrower.left + narrower.right) / 2;
  const clampedLow = low + EDGE_MARGIN;
  const clampedHigh = high - EDGE_MARGIN;
  return Math.min(Math.max(center, clampedLow), clampedHigh);
}

/** 相对的两条边之间的空隙（CSS 像素），重叠或方向不符时为负数。 */
function facingGap(source: Rect, target: Rect, fromSide: Side): number {
  if (fromSide === "right") {
    return target.left - source.right;
  }
  if (fromSide === "left") {
    return source.left - target.right;
  }
  if (fromSide === "bottom") {
    return target.top - source.bottom;
  }
  return source.top - target.bottom;
}

/** 计算一条连线的折线点。 */
export function routeLink(link: LinkSpec, source: Rect, target: Rect, metrics: RouteMetrics): Point[] {
  const [autoFrom, autoTo] = autoSides(source, target);
  const fromSide = link.fromSide ?? autoFrom;
  const toSide = link.toSide ?? autoTo;
  const facing = toSide === opposite(fromSide);
  const explicitPosition = link.fromAt !== undefined || link.toAt !== undefined;

  // 相对的两条边且有重叠：直线。两条边之间放不下一次折线时，即使指定了出入点位置也走直线：
  // 为了对齐位置硬折一下，箭头头部只能压在拐角上，成为难以辨认的小钩。
  const roomForJog = facingGap(source, target, fromSide) >= metrics.stub * 2;
  if (facing && (!explicitPosition || !roomForJog)) {
    const horizontal = isHorizontal(fromSide);
    const shared = sharedCoordinate(source, target, horizontal);
    if (shared !== null) {
      const start = sidePoint(source, fromSide, undefined);
      const end = sidePoint(target, toSide, undefined);
      if (horizontal) {
        return [[start[0], shared], [end[0], shared]];
      }
      return [[shared, start[1]], [shared, end[1]]];
    }
  }

  const start = sidePoint(source, fromSide, link.fromAt);
  const end = sidePoint(target, toSide, link.toAt);

  if (facing) {
    const horizontal = isHorizontal(fromSide);
    if (horizontal) {
      const forward = fromSide === "right" ? end[0] - start[0] : start[0] - end[0];
      if (forward > 0 && start[1] === end[1]) {
        return [start, end];
      }
      if (forward > 0 && Math.abs(start[1] - end[1]) < MIN_JOG) {
        // 两端高度只差几像素时，折一下看起来像绘制错误，改画成一条直线（指定了出入点位置也一样）。
        const level = (start[1] + end[1]) / 2;
        return [[start[0], level], [end[0], level]];
      }
      if (forward >= metrics.stub * 2) {
        const middle = (start[0] + end[0]) / 2;
        return [start, [middle, start[1]], [middle, end[1]], end];
      }
      const outward = fromSide === "right" ? metrics.stub : -metrics.stub;
      const middleY = (start[1] + end[1]) / 2;
      return [
        start, [start[0] + outward, start[1]], [start[0] + outward, middleY],
        [end[0] - outward, middleY], [end[0] - outward, end[1]], end,
      ];
    }
    const forward = fromSide === "bottom" ? end[1] - start[1] : start[1] - end[1];
    if (forward > 0 && start[0] === end[0]) {
      return [start, end];
    }
    if (forward > 0 && Math.abs(start[0] - end[0]) < MIN_JOG) {
      const level = (start[0] + end[0]) / 2;
      return [[level, start[1]], [level, end[1]]];
    }
    if (forward >= metrics.stub * 2) {
      const middle = (start[1] + end[1]) / 2;
      return [start, [start[0], middle], [end[0], middle], end];
    }
    const outward = fromSide === "bottom" ? metrics.stub : -metrics.stub;
    const middleX = (start[0] + end[0]) / 2;
    return [
      start, [start[0], start[1] + outward], [middleX, start[1] + outward],
      [middleX, end[1] - outward], [end[0], end[1] - outward], end,
    ];
  }

  // 同向出入：在外侧绕 U 形。
  if (fromSide === toSide) {
    if (fromSide === "right") {
      const lane = Math.max(start[0], end[0]) + metrics.lane;
      return [start, [lane, start[1]], [lane, end[1]], end];
    }
    if (fromSide === "left") {
      const lane = Math.min(start[0], end[0]) - metrics.lane;
      return [start, [lane, start[1]], [lane, end[1]], end];
    }
    if (fromSide === "bottom") {
      const lane = Math.max(start[1], end[1]) + metrics.lane;
      return [start, [start[0], lane], [end[0], lane], end];
    }
    const lane = Math.min(start[1], end[1]) - metrics.lane;
    return [start, [start[0], lane], [end[0], lane], end];
  }

  // 一横一竖：折一次。
  if (isHorizontal(fromSide)) {
    return [start, [end[0], start[1]], end];
  }
  return [start, [start[0], end[1]], end];
}

/** 折线上最长一段的中点，用于放连线文字。 */
export function labelAnchor(points: Point[]): Point {
  let best: Point = points[0];
  let bestLength = -1;
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1];
    const [x2, y2] = points[index];
    const length = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    if (length > bestLength) {
      bestLength = length;
      best = [(x1 + x2) / 2, (y1 + y2) / 2];
    }
  }
  return best;
}
