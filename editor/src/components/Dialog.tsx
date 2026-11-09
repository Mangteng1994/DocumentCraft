/**
 * 通用模态对话框与表单行。
 */

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { iconSize } from "../styles/tokens";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 进行中的任务不允许按 Esc 关闭，避免误以为任务已取消。 */
  busy?: boolean;
}

export function Dialog({ title, onClose, children, footer, busy = false }: DialogProps) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, busy]);

  return (
    <div className="dc-overlay" role="presentation">
      <div className="dc-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="dc-dialog-header">
          <h2 className="dc-dialog-title">{title}</h2>
          <button type="button" className="dc-icon-button" aria-label="关闭" onClick={onClose} disabled={busy}>
            <X size={iconSize.md} />
          </button>
        </header>
        <div className="dc-dialog-body">{children}</div>
        {footer && <footer className="dc-dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="dc-field">
      <span className="dc-field-label">{label}</span>
      {children}
      {hint && <span className="dc-field-hint">{hint}</span>}
    </label>
  );
}

export function StatusLine({ text, tone = "normal" }: { text: string; tone?: "normal" | "error" | "warning" }) {
  if (!text) {
    return null;
  }
  return <p className={`dc-status-line is-${tone}`}>{text}</p>;
}
