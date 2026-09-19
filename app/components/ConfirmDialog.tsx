"use client";

import { useEffect, useRef, useId } from "react";
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
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const actionsRef = useRef({ busy, onCancel });
  actionsRef.current = { busy, onCancel };
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !actionsRef.current.busy) { event.preventDefault(); actionsRef.current.onCancel(); }
      if (event.key !== "Tab") return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]') ?? []);
      if (!items.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  if (!open) return null;
  return <div className="sheet-overlay confirm-overlay" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onCancel();
  }}>
    <section ref={dialogRef} tabIndex={-1} className="confirm-sheet" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
      <div className={`confirm-symbol ${danger ? "danger" : ""}`}><UiIcon name={danger ? "alert" : "check"} size={22} /></div>
      <h2 id={titleId}>{title}</h2>
      {description && <p id={descriptionId}>{description}</p>}
      <div className="confirm-actions">
        <button ref={cancelRef} type="button" className="app-button app-button-secondary" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={`app-button ${danger ? "app-button-danger" : "app-button-primary"}`} disabled={busy} onClick={onConfirm}>{busy ? "처리 중…" : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
