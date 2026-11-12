/** 编辑图内可见文字。修改后仍按原文取证范围校验。 */

import { useState } from "react";
import { walkBlocks, type FigureSpec } from "./spec";

interface TextField {
  name: string;
  text: string;
  write: (value: string) => void;
}

function fieldsOf(spec: FigureSpec): TextField[] {
  const fields: TextField[] = [];
  walkBlocks(spec.root, (block) => {
    if ("title" in block && block.title) {
      fields.push({ name: "标题", text: block.title, write: (value) => { block.title = value; } });
    }
    if ("subtitle" in block && block.subtitle) {
      fields.push({ name: "副标题", text: block.subtitle, write: (value) => { block.subtitle = value; } });
    }
    if (block.kind === "card") {
      if (typeof block.detail === "string") {
        fields.push({ name: "说明", text: block.detail, write: (value) => { block.detail = value; } });
      } else {
        const details = block.detail;
        details?.forEach((text, index) => {
          fields.push({ name: "说明", text, write: (value) => { details[index] = value; } });
        });
      }
      const tags = block.tags;
      tags?.forEach((text, index) => {
        fields.push({ name: "标签", text, write: (value) => { tags[index] = value; } });
      });
    }
    if (block.kind === "decision") {
      fields.push({ name: "判断条件", text: block.text, write: (value) => { block.text = value; } });
    }
    if (block.kind === "arrow" && block.label) {
      fields.push({ name: "箭头标签", text: block.label, write: (value) => { block.label = value; } });
    }
    if (block.kind === "chain") {
      const labels = block.labels;
      labels?.forEach((text, index) => {
        if (text) {
          fields.push({ name: "顺序标签", text, write: (value) => { labels[index] = value; } });
        }
      });
    }
  });
  for (const link of spec.links ?? []) {
    if (link.label) {
      fields.push({ name: "连线标签", text: link.label, write: (value) => { link.label = value; } });
    }
  }
  return fields;
}

export function FigureTextEditor({ spec, disabled, onApply }: {
  spec: FigureSpec;
  disabled: boolean;
  onApply: (spec: FigureSpec) => void;
}) {
  const fields = fieldsOf(spec);
  const [values, setValues] = useState(() => fields.map(({ text }) => text));
  const changed = fields.some(({ text }, index) => text !== values[index]);
  const apply = () => {
    const edited = structuredClone(spec);
    fieldsOf(edited).forEach(({ write }, index) => write(values[index].trim()));
    onApply(edited);
  };

  return (
    <details className="dc-figure-details">
      <summary>编辑图中文字</summary>
      <p className="dc-setting-note">使用取证段落中的原文短语。</p>
      {fields.map(({ name }, index) => (
        <label className="dc-figure-field" key={index}>
          <span>{name}</span>
          <input
            className="dc-input"
            value={values[index]}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              setValues((current) => current.map((text, position) => position === index ? value : text));
            }}
          />
        </label>
      ))}
      <button type="button" className="dc-button" disabled={disabled || !changed} onClick={apply}>应用文字修改</button>
    </details>
  );
}
