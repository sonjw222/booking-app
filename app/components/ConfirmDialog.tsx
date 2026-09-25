"use client";

import { useEffect, useId, useRef } from "react";
import UiIcon from "./UiIcon";

type Props = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({ open, title, description, confirmLabel = "확인", cancelLabel = "취소", danger = false, busy = false, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (cancelRef.current && !cancelRef.current.disabled) cancelRef.current.focus();
    else sheetRef.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) onCancel();
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(sheetRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first) {
        event.preventDefault();
        sheetRef.current?.focus();
      } else if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement as HTMLButtonElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement as HTMLButtonElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);
  if (!open) return null;
  return <div className="sheet-overlay confirm-overlay" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onCancel();
  }}>
    <section ref={sheetRef} tabIndex={-1} className="confirm-sheet" role="alertdialog" aria-modal="true" aria-busy={busy} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined}>
      <div className={`confirm-symbol ${danger ? "danger" : ""}`}><UiIcon name={danger ? "alert" : "check"} size={22} /></div>
      <h2 id={`${id}-title`}>{title}</h2>
      {description && <p id={`${id}-description`}>{description}</p>}
      <div className="confirm-actions">
        <button ref={cancelRef} type="button" className="app-button app-button-secondary" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={`app-button ${danger ? "app-button-danger" : "app-button-primary"}`} disabled={busy} onClick={onConfirm}>{busy ? "처리 중…" : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
