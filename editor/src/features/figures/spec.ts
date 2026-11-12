/**
 * 科研配图的图规格：组件树加跨元素连线。
 *
 * 规格只描述「画什么」：用哪些组件、怎么嵌套、谁连向谁。外观（颜色、字号、线宽、箭头）
 * 只来自 figureTokens，规格里只能引用语义名，所以 AI 写出的规格不会让风格漂移。
 */

import { figureTokens, type FigureTone } from "../../styles/tokens";

export type Gap = keyof typeof figureTokens.gap;
export type Direction = "up" | "down" | "left" | "right";
export type Side = "top" | "bottom" | "left" | "right";

/** 卡片可用的图标语义名，对应 icons.ts 里的 lucide 图标。 */
export const FIGURE_ICONS = [
  "drone", "image", "model", "location", "document", "calendar", "chart", "terrain", "grid",
  "bridge", "warning", "settings", "database", "chip", "camera", "video", "radar", "layers",
  "shield", "scan", "cloud", "users", "server", "network", "brain", "branch", "workflow",
  "search", "activity", "gauge", "worker", "construction", "water", "temperature", "checklist",
  "file-check", "route",
] as const;
export type FigureIcon = (typeof FIGURE_ICONS)[number];

interface Base {
  /** 连线引用的元素 ID，在一张图内唯一。 */
  id?: string;
}

/** 横向排列。weights 为各子元素的宽度比例，版式箭头不占比例。 */
export interface RowBlock extends Base {
  kind: "row";
  children: Block[];
  gap?: Gap;
  weights?: number[];
  /** 子元素是否等高（默认等高）。 */
  stretch?: boolean;
}

/** 纵向排列。fill 为真时子元素均分高度。 */
export interface ColumnBlock extends Base {
  kind: "column";
  children: Block[];
  gap?: Gap;
  fill?: boolean;
}

/** 等宽网格。 */
export interface GridBlock extends Base {
  kind: "grid";
  columns: number;
  children: Block[];
  gap?: Gap;
}

/** 顺序链：相邻子元素之间自动加箭头。labels[i] 是第 i 个和第 i+1 个之间箭头的文字。 */
export interface ChainBlock extends Base {
  kind: "chain";
  direction: "down" | "right";
  children: Block[];
  labels?: (string | null)[];
  /** 与相邻连接逐一对应的原文引文。内置样张可省略。 */
  evidence?: string[];
  fill?: boolean;
}

/**
 * 面板：带标题的大容器。header 为 band 时标题在顶部色带里，side 时在左侧竖栏，
 * plain 时标题是面板内的粗体文字，none 时没有标题。
 */
export interface PanelBlock extends Base {
  kind: "panel";
  title?: string;
  subtitle?: string;
  tone: FigureTone;
  header?: "band" | "side" | "plain" | "none";
  children: Block[];
  gap?: Gap;
  fill?: boolean;
}

/** 虚线分组：面板内部的子区域。 */
export interface GroupBlock extends Base {
  kind: "group";
  title?: string;
  subtitle?: string;
  children: Block[];
  gap?: Gap;
  fill?: boolean;
}

/**
 * 卡片：标题加可选说明、图标和底部标签。tone 缺省时继承所在面板的色调。
 * variant：filled 实心（默认），outline 白底描边，banner 大号标题横条，note 说明条（常规字重）。
 */
export interface CardBlock extends Base {
  kind: "card";
  title: string;
  detail?: string | string[];
  icon?: FigureIcon;
  tags?: string[];
  tone?: FigureTone;
  variant?: "filled" | "outline" | "banner" | "note";
}

/** 判断菱形，出口用连线或顺序链的箭头文字（如「是」「否」）表达。 */
export interface DecisionBlock extends Base {
  kind: "decision";
  text: string;
  tone?: FigureTone;
}

/** 版式箭头：在行或列里占一个位置，表示前后两块之间的整体流向。 */
export interface ArrowBlock extends Base {
  kind: "arrow";
  direction: Direction;
  style?: "solid" | "hollow";
  label?: string;
  evidence?: string;
}

export type Block =
  | RowBlock
  | ColumnBlock
  | GridBlock
  | ChainBlock
  | PanelBlock
  | GroupBlock
  | CardBlock
  | DecisionBlock
  | ArrowBlock;

/**
 * 跨元素连线。sides 缺省时按两元素的相对位置自动选边；两元素在连线方向上有重叠时走直线。
 * fromAt、toAt 为 0 到 1，指定出入点在边上的位置。
 */
export interface LinkSpec {
  from: string;
  to: string;
  fromSide?: Side;
  toSide?: Side;
  fromAt?: number;
  toAt?: number;
  style?: "flow" | "primary" | "dashed";
  /** 两端都有箭头。 */
  both?: boolean;
  label?: string;
  evidence?: string;
}

export interface FigureSpec {
  /** 图名，用于审核清单和 Word 图题，不画进图里。 */
  title: string;
  /** 画布宽度（pt），缺省为 figureTokens.width。 */
  width?: number;
  root: Block;
  links?: LinkSpec[];
}

/** 遍历组件树里的所有组件。 */
export function walkBlocks(block: Block, visit: (item: Block) => void): void {
  visit(block);
  if ("children" in block) {
    for (const child of block.children) {
      walkBlocks(child, visit);
    }
  }
}

/**
 * 检查规格的结构是否合法：色调、图标在词表内，ID 不重复，连线两端存在。
 * 返回问题列表，空列表表示通过。AI 生成的规格先过这一步再渲染。
 */
export function validateSpec(spec: FigureSpec): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const tones = Object.keys(figureTokens.tones);
  walkBlocks(spec.root, (block) => {
    if (block.id) {
      if (ids.has(block.id)) {
        problems.push(`ID 重复：${block.id}`);
      }
      ids.add(block.id);
    }
    const tone = "tone" in block ? block.tone : undefined;
    if (tone && !tones.includes(tone)) {
      problems.push(`未知色调：${tone}`);
    }
    if (block.kind === "card" && block.icon && !FIGURE_ICONS.includes(block.icon)) {
      problems.push(`未知图标：${block.icon}`);
    }
    if (block.kind === "row" && block.weights) {
      const weighted = block.children.filter((child) => child.kind !== "arrow");
      if (block.weights.length !== weighted.length) {
        problems.push(`行${block.id ? ` ${block.id}` : ""}的 weights 数量与非箭头子元素数量不一致`);
      }
    }
    if (block.kind === "grid" && (!Number.isInteger(block.columns) || block.columns < 1)) {
      problems.push("网格列数必须是正整数");
    }
  });
  for (const link of spec.links ?? []) {
    for (const end of [link.from, link.to]) {
      if (!ids.has(end)) {
        problems.push(`连线端点不存在：${end}`);
      }
    }
  }
  return problems;
}
