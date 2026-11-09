/**
 * TypeScript 侧设计令牌。
 *
 * lucide 图标的尺寸、描边属于图标主题属性，需要以数字传给组件，因此在这里集中定义。
 * 其余设计值都在 tokens.css。
 */

export const iconSize = {
  sm: 14,
  md: 16,
} as const;

export const iconStroke = {
  regular: 1.75,
} as const;
