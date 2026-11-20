/**
 * TypeScript 侧设计令牌。
 *
 * lucide 图标的尺寸、描边属于图标主题属性，需要以数字传给组件；侧栏拖动宽度的上下限需要在脚本中夹取。
 * 这两类在这里集中定义，其余设计值都在 tokens.css。
 */

export const iconSize = {
  sm: 14,
  md: 16,
} as const;

export const iconStroke = {
  regular: 1.75,
} as const;

/** 拖动调整侧栏宽度的上下限（像素）。默认宽度见 tokens.css 的 --dc-size-sidebar、--dc-size-panel。 */
export const paneWidth = {
  sidebarMin: 180,
  sidebarMax: 560,
  panelMin: 280,
  panelMax: 720,
} as const;

/**
 * 五彩文档大纲（DC-068）的默认配色：莫兰迪色系，降低饱和度、带灰调，在浅色与深色主题下都清晰可读。
 * 这些值写入设置作为默认规则，用户可在「设置 → 文件 → 五彩文档大纲」中改成任意 HEX。
 */
export const fileTypeColorDefaults = {
  word: "#7B93AC",
  excel: "#87A28A",
  pdf: "#B97C7C",
  powerpoint: "#C89A73",
} as const;

/**
 * 科研配图令牌。
 *
 * 配图会插入 Word、WPS 并打印，固定白底，不跟随界面主题。尺寸以印刷点（pt）为单位，
 * 画布默认宽度对应 A4 纵向的常见版心；导出时按 exportScale 倍 CSS 像素输出 PNG。
 * 图规格只引用这里的语义名（色调、密度、间距、连线样式），具体数值只在这里定义。
 */
export const figureTokens = {
  font: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
  paper: "#ffffff",
  ink: "#191919",
  inkMuted: "#343434",
  link: "#191919",
  border: "#515151",
  groupBorder: "#626262",
  /** 默认画布宽度（pt），约 15.9 cm。 */
  width: 450,
  /** 导出 PNG 时每 CSS 像素对应的图像像素，450pt 宽约 380 dpi。 */
  exportScale: 4,
  /** 每 pt 对应的 CSS 像素。 */
  pxPerPt: 4 / 3,
  /**
   * 字号与间距的三档密度（pt），排版放不下时依次收紧。
   * panelTitle 面板标题，cardTitle 卡片标题，detail 卡片说明与标签，label 连线文字。
   */
  density: [
    { name: "regular", panelTitle: 10.5, cardTitle: 9, detail: 8.5, label: 8.5, padding: 5, cardPadding: 3.5, lineHeight: 1.3 },
    { name: "compact", panelTitle: 10.5, cardTitle: 9, detail: 8.5, label: 8.5, padding: 4, cardPadding: 3, lineHeight: 1.28 },
    { name: "dense", panelTitle: 10.5, cardTitle: 9, detail: 8.5, label: 8.5, padding: 3, cardPadding: 2.5, lineHeight: 1.25 },
  ],
  gap: { tight: 3, normal: 5, loose: 9, wide: 16 },
  /** 顺序链里两张卡片之间留给箭头的高度或宽度（pt）。 */
  chainArrow: 7,
  chainLabelSlot: 12,
  /** 版式箭头（面板之间的大箭头）占位宽度（pt）。 */
  layoutArrow: { solid: 12, hollow: 10, open: 12 },
  /** 侧边标题栏的宽度（pt）。 */
  sideHeader: 54,
  /** 判断菱形的高度（pt）。 */
  decisionHeight: 30,
  /** 卡片图标尺寸（pt）。 */
  icon: 11,
  radius: { panel: 0, card: 0 },
  stroke: { panel: 0.75, card: 0.6, group: 0.7, link: 0.8, primary: 1.2, icon: 1.6 },
  arrowHead: { length: 4.2, width: 3.4, openWidth: 7 },
  dash: [2.6, 1.8],
  /** 连线离开元素边缘后的最短直线段与 U 形回线的外扩距离（pt）。 */
  linkStub: 6,
  linkLane: 7,
  linkClearance: 2,
  minCardWidth: 38,
  minFont: 8.5,
  maxWideAspect: 5.5,
  bold: 700,
  regular: 400,
  /**
   * 色调。surface 为面板底色，header 为标题栏底色，card 为卡片底色。
   * 用浅色填充区分职责，各分区共用深色细边和正文颜色。
   */
  tones: {
    blue: { surface: "#e9f0f5", header: "#e2eaf2", card: "#cddfec" },
    teal: { surface: "#e9f5f3", header: "#e1f1ee", card: "#ccece8" },
    green: { surface: "#eaf5e9", header: "#e5f2e3", card: "#ceebcf" },
    sand: { surface: "#f7f1e9", header: "#f3ebe2", card: "#f0ddca" },
    lilac: { surface: "#f1ebf6", header: "#ebe4f1", card: "#dfd1ed" },
    rose: { surface: "#f8eded", header: "#f3e7e8", card: "#efd3d9" },
    gray: { surface: "#f5f6f7", header: "#eceef0", card: "#e4e7ea" },
  },
} as const;

export type FigureTone = keyof typeof figureTokens.tones;
