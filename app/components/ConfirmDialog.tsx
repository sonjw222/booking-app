"use client";

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

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "확인",
  cancelLabel = "취소",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;
  return (
    <div className="sheet-overlay confirm-overlay" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onCancel();
    }}>
      <section className="confirm-sheet" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className={`confirm-symbol ${danger ? "danger" : ""}`}>
          <UiIcon name={danger ? "alert" : "check"} size={22} />
        </div>
        <h2 id="confirm-title">{title}</h2>
        {description && <p>{description}</p>}
        <div className="confirm-actions">
          <button className="ghost-btn" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button className={danger ? "danger-confirm-btn" : "primary-btn"} disabled={busy} onClick={onConfirm}>
            {busy ? "처리 중…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
