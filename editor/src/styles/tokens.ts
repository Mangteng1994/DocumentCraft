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
