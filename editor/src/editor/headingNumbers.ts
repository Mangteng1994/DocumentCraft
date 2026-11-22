/**
 * 虚拟标题编号（DC-072）。
 *
 * 开启后在 H1～H4 标题文字前显示 1、1.1、1.1.1、1.1.1.1，编号与标题文字之间空一个字符。
 * 编号只是 ProseMirror widget 装饰：不进入文档内容，不写入 Markdown 文件，也不会被复制或导出；
 * H5、H6 不编号。开关保存在 settings.editor.headingNumbers。
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useSettings } from "../settings/settingsStore";

/** 参与编号的最深标题级别。 */
export const HEADING_NUMBER_MAX_LEVEL = 4;

interface NumberingState {
  enabled: boolean;
  decorations: DecorationSet;
}

const numberingKey = new PluginKey<NumberingState>("documentcraftHeadingNumbers");

/**
 * 按文档顺序为一组标题级别生成编号标签；H5、H6 等超过编号深度的级别返回 null。
 * 标题级别跳级（如 H1 后直接 H3）时，缺失的中间级别按 1 计，得到 1.1.1 而不是 1.0.1。
 * 编辑区装饰与左侧大纲共用本函数，保证两处编号一致。
 */
export function computeHeadingLabels(levels: readonly number[]): (string | null)[] {
  const counters: number[] = new Array(HEADING_NUMBER_MAX_LEVEL).fill(0);
  return levels.map((level) => {
    if (!(level >= 1 && level <= HEADING_NUMBER_MAX_LEVEL)) {
      return null;
    }
    counters[level - 1] += 1;
    for (let deeper = level; deeper < HEADING_NUMBER_MAX_LEVEL; deeper += 1) {
      counters[deeper] = 0;
    }
    const parts = counters.slice(0, level).map((value) => Math.max(value, 1));
    return parts.join(".");
  });
}

/** 按文档顺序为 H1～H4 生成编号及其标题节点位置。 */
export function computeHeadingNumbers(doc: PMNode): { pos: number; label: string }[] {
  const positions: number[] = [];
  const levels: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") {
      return true;
    }
    positions.push(pos);
    levels.push(Number(node.attrs.level));
    return false;
  });
  const labels = computeHeadingLabels(levels);
  const result: { pos: number; label: string }[] = [];
  labels.forEach((label, index) => {
    if (label !== null) {
      result.push({ pos: positions[index], label });
    }
  });
  return result;
}

function buildDecorations(doc: PMNode, enabled: boolean): DecorationSet {
  if (!enabled) {
    return DecorationSet.empty;
  }
  const decorations = computeHeadingNumbers(doc).map(({ pos, label }) =>
    Decoration.widget(
      pos + 1,
      () => {
        const element = document.createElement("span");
        element.className = "dc-heading-number";
        // 编号后紧跟一个空格字符；white-space: pre 保证这个空格不被折叠。
        element.textContent = `${label} `;
        element.contentEditable = "false";
        return element;
      },
      { side: -1, ignoreSelection: true, key: `heading-number-${label}` },
    ),
  );
  return DecorationSet.create(doc, decorations);
}

export const headingNumbersExtension = Extension.create({
  name: "documentcraftHeadingNumbers",
  addProseMirrorPlugins() {
    return [
      new Plugin<NumberingState>({
        key: numberingKey,
        state: {
          init: (_config, state) => {
            const enabled = useSettings.getState().settings.editor.headingNumbers;
            return { enabled, decorations: buildDecorations(state.doc, enabled) };
          },
          apply: (transaction, previous, _oldState, newState) => {
            const meta = transaction.getMeta(numberingKey) as boolean | undefined;
            const enabled = meta !== undefined ? meta : previous.enabled;
            if (meta === undefined && !transaction.docChanged) {
              return previous;
            }
            return { enabled, decorations: buildDecorations(newState.doc, enabled) };
          },
        },
        props: {
          decorations: (state) => numberingKey.getState(state)?.decorations,
        },
        view: (view) => {
          // 设置开关变化时给编辑器发一个仅携带开关值的事务，触发装饰重建；不改文档、不进撤销栈。
          const unsubscribe = useSettings.subscribe((state, previous) => {
            const enabled = state.settings.editor.headingNumbers;
            if (enabled === previous.settings.editor.headingNumbers) {
              return;
            }
            const transaction = view.state.tr.setMeta(numberingKey, enabled).setMeta("addToHistory", false);
            view.dispatch(transaction);
          });
          return { destroy: unsubscribe };
        },
      }),
    ];
  },
});
