/**
 * 插入表格：在网格上悬停选择行列数，或直接输入数值。首行为表头。
 */

import { useState } from "react";
import { Dialog, Field } from "../components/Dialog";
import { useAppStore } from "../store";
import { insertTable } from "./editorCommands";

const GRID_ROWS = 8;
const GRID_COLS = 8;
const MAX_SIZE = 50;
const DEFAULT_SIZE = 3;

function clampSize(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SIZE;
  }
  return Math.min(Math.max(Math.round(value), 1), MAX_SIZE);
}

export function InsertTablePicker() {
  const setOverlay = useAppStore((state) => state.setOverlay);
  const [rows, setRows] = useState(DEFAULT_SIZE);
  const [cols, setCols] = useState(DEFAULT_SIZE);

  const confirm = (rowCount: number, colCount: number) => {
    setOverlay(null);
    insertTable(clampSize(rowCount), clampSize(colCount));
  };

  const footer = (
    <>
      <button type="button" className="dc-button" onClick={() => setOverlay(null)}>
        取消
      </button>
      <button type="button" className="dc-button is-primary" onClick={() => confirm(rows, cols)}>
        插入
      </button>
    </>
  );

  return (
    <Dialog title="插入表格" onClose={() => setOverlay(null)} footer={footer}>
      <div className="dc-table-grid" role="grid" aria-label="选择表格大小">
        {Array.from({ length: GRID_ROWS }, (_, row) => (
          <div key={row} className="dc-table-grid-row" role="row">
            {Array.from({ length: GRID_COLS }, (_, col) => {
              const active = row < rows && col < cols;
              return (
                <button
                  key={col}
                  type="button"
                  role="gridcell"
                  aria-label={`${row + 1} 行 ${col + 1} 列`}
                  className={`dc-table-grid-cell${active ? " is-active" : ""}`}
                  onMouseEnter={() => {
                    setRows(row + 1);
                    setCols(col + 1);
                  }}
                  onClick={() => confirm(row + 1, col + 1)}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="dc-dialog-text">
        {rows} 行 × {cols} 列（含表头行）
      </p>
      <div className="dc-path-row">
        <Field label="行数">
          <input className="dc-input" type="number" min={1} max={MAX_SIZE} value={rows} onChange={(event) => setRows(clampSize(Number(event.target.value)))} />
        </Field>
        <Field label="列数">
          <input
            className="dc-input"
            type="number"
            min={1}
            max={MAX_SIZE}
            value={cols}
            onChange={(event) => setCols(clampSize(Number(event.target.value)))}
            onKeyDown={(event) => event.key === "Enter" && confirm(rows, cols)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
