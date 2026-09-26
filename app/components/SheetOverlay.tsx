"use client";

import { useEffect, useRef, useId, type HTMLAttributes } from "react";

let locks = 0;
let previousOverflow = "";
const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

/** Shared overlay contract; existing close handlers still decide whether closing is allowed. */
export default function SheetOverlay({ children, className = "sheet-overlay", ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const overlay = ref.current;
    if (!overlay) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (locks++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const title = overlay.querySelector<HTMLElement>(".sheet-title");
    if (title) { title.id ||= titleId; overlay.setAttribute("aria-labelledby", title.id); }
    const isTop = () => !document.querySelector('[role="alertdialog"]') && [...document.querySelectorAll("[data-sheet-overlay]")].at(-1) === overlay;
    const targets = () => [...overlay.querySelectorAll<HTMLElement>(focusable)].filter(el => el.getClientRects().length > 0);
    // Focus the dialog, not a field: opening a sheet must not summon the keyboard.
    overlay.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); overlay.click(); }
      if (event.key === "Tab") {
        const items = targets();
        const first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); overlay.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === overlay)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === overlay)) { event.preventDefault(); first.focus(); }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (isTop() && event.target instanceof Node && !overlay.contains(event.target)) overlay.focus({ preventScroll: true });
    };
    const viewport = window.visualViewport;
    const fit = () => {
      if (!viewport) return;
      overlay.style.top = `${viewport.offsetTop}px`;
      overlay.style.height = `${viewport.height}px`;
      overlay.style.bottom = "auto";
    };
    fit();
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
      if (--locks === 0) document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [titleId]);
  return <div {...props} ref={ref} className={className} data-sheet-overlay role="dialog" aria-modal="true" tabIndex={-1}>{children}</div>;
}
