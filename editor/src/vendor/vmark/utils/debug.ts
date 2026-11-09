/**
 * DocumentCraft 精简版调试日志。
 *
 * 原 VMark 版本把 warn/error 转发到 tauri-plugin-log；DocumentCraft 不注册该插件，
 * 这里只保留 Markdown 管线实际引用的两个日志函数，输出到控制台。
 */

/** Markdown 管线在格式降级时给出的警告。 */
export function mdPipelineWarn(...args: unknown[]): void {
  console.warn("[markdown]", ...args);
}

/** 链接解析失败时的错误日志。 */
export function linkPopupError(...args: unknown[]): void {
  console.error("[link]", ...args);
}
