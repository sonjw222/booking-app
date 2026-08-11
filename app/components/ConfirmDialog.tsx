"use client";

import { useEffect, useRef } from "react";
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
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);
  if (!open) return null;
  return <div className="sheet-overlay confirm-overlay" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onCancel();
  }}>
    <section className="confirm-sheet" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={description ? "confirm-description" : undefined}>
      <div className={`confirm-symbol ${danger ? "danger" : ""}`}><UiIcon name={danger ? "alert" : "check"} size={22} /></div>
      <h2 id="confirm-title">{title}</h2>
      {description && <p id="confirm-description">{description}</p>}
      <div className="confirm-actions">
        <button ref={cancelRef} type="button" className="app-button app-button-secondary" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={`app-button ${danger ? "app-button-danger" : "app-button-primary"}`} disabled={busy} onClick={onConfirm}>{busy ? "처리 중…" : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
