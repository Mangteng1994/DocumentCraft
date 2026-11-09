/**
 * 快捷键的规范写法、录制与匹配。
 *
 * 写法形如 "Ctrl+Shift+K"：修饰键按 Ctrl、Alt、Shift 排序，主键用 KeyboardEvent.code 推导，
 * 这样 Shift+1 记为 "Shift+1" 而不是 "!"，与键盘布局无关。
 */

import { ACTIONS, type ActionId, type Hotkeys } from "./schema";

const CODE_NAMES: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

function mainKey(event: KeyboardEvent): string | null {
  const { code } = event;
  if (MODIFIER_CODES.has(code)) {
    return null;
  }
  if (code.startsWith("Key")) {
    return code.slice(3);
  }
  if (code.startsWith("Digit")) {
    return code.slice(5);
  }
  if (code.startsWith("Numpad") && /\d$/.test(code)) {
    return code.slice(6);
  }
  if (/^F\d{1,2}$/.test(code)) {
    return code;
  }
  return CODE_NAMES[code] ?? null;
}

/** 把按键事件转成规范写法；只按了修饰键时返回 null。 */
export function eventToHotkey(event: KeyboardEvent): string | null {
  const key = mainKey(event);
  if (!key) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push("Ctrl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  parts.push(key);
  return parts.join("+");
}

/** 录制快捷键时的校验：需带 Ctrl 或 Alt，功能键 F1–F12 可单独使用。 */
export function isAssignable(hotkey: string): boolean {
  const parts = hotkey.split("+");
  const key = parts[parts.length - 1];
  const hasModifier = parts.includes("Ctrl") || parts.includes("Alt");
  return hasModifier || /^F\d{1,2}$/.test(key);
}

/** 查找与给定快捷键冲突的其他操作。 */
export function findConflict(hotkeys: Hotkeys, actionId: ActionId, hotkey: string): ActionId | null {
  if (!hotkey) {
    return null;
  }
  for (const action of ACTIONS) {
    if (action.id !== actionId && hotkeys[action.id] === hotkey) {
      return action.id;
    }
  }
  return null;
}

export function matchAction(hotkeys: Hotkeys, event: KeyboardEvent): ActionId | null {
  const pressed = eventToHotkey(event);
  if (!pressed) {
    return null;
  }
  for (const action of ACTIONS) {
    if (hotkeys[action.id] === pressed) {
      return action.id;
    }
  }
  return null;
}

export function actionLabel(id: ActionId): string {
  return ACTIONS.find((action) => action.id === id)?.label ?? id;
}
