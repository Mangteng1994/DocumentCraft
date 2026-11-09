/**
 * DocumentCraft 精简版性能打点。
 *
 * VMark 用它记录大文档打开耗时；DocumentCraft 暂不采集，保留同名空实现以免改动管线代码。
 */

export function perfStart(_label: string): void {}

export function perfEnd(_label: string, _details?: Record<string, unknown>): void {}

export function perfMark(_label: string, _details?: Record<string, unknown>): void {}
