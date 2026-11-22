/**
 * 界面文字的格式化小工具。
 */

const BYTE_UNITS = ["字节", "KB", "MB", "GB", "TB"];
const BYTES_PER_UNIT = 1024;

/** 大小显示为「1.2 MB（1,234,567 字节）」，不足 1 KB 时只显示字节数。 */
export function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_UNIT) {
    return `${bytes.toLocaleString()} 字节`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}（${bytes.toLocaleString()} 字节）`;
}

/** 简短体积，如「252.3 MB」，用于进度与结果摘要。 */
export function formatSizeShort(bytes: number): string {
  if (bytes < BYTES_PER_UNIT) {
    return `${bytes} 字节`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
