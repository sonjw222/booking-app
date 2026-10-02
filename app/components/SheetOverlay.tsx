"use client";

import { useEffect, useRef, useId, type HTMLAttributes } from "react";
import { attachSheetDrag, type SheetDragController } from "../../lib/sheetDrag";

let locks = 0;
let previousOverflow = "";
const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

type SheetOverlayProps = HTMLAttributes<HTMLDivElement> & {
  /**
   * 모바일 bottom sheet 공통 drag-to-dismiss(상단 handle에서 시작한 아래 방향 drag). 기본 true.
   * 저장/결제 처리 중이라 닫기를 막는 sheet(`!busy && close()`), 확인/경고·파괴적 확인, 지도처럼 본문 제스처가
   * 핵심인 sheet는 false로 넘긴다(handle 자체가 나타나지 않는다). onClick(닫기 핸들러)이 없으면 항상 비활성.
   */
  swipeDismiss?: boolean;
};

/** Shared overlay contract; existing close handlers still decide whether closing is allowed. */
export default function SheetOverlay({ children, className = "sheet-overlay", swipeDismiss = true, ...props }: SheetOverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const canSwipe = swipeDismiss && !!props.onClick;
  // 공용 drag-to-dismiss — .sheet 맨 위에 drag handle을 심고(React가 관리하지 않는 노드), 그 handle에서
  // 시작한 제스처만 dismiss로 인정한다(본문 스크롤과 충돌 없음). 닫기는 배경 탭/ESC와 같은 경로(overlay.click()).
  useEffect(() => {
    const overlay = ref.current;
    if (!overlay || !canSwipe) return;
    let ctrl: SheetDragController | null = null;
    let handle: HTMLElement | null = null;
    let attachedTo: HTMLElement | null = null;
    const isTop = () => !document.querySelector('[role="alertdialog"]') && [...document.querySelectorAll("[data-sheet-overlay]")].at(-1) === overlay;
    const detach = () => { ctrl?.destroy(); ctrl = null; handle?.remove(); handle = null; attachedTo = null; };
    const ensure = () => {
      const sheet = overlay.querySelector<HTMLElement>(":scope > .sheet");
      if (sheet === attachedTo) return;
      detach();
      if (!sheet) return;
      handle = document.createElement("div");
      handle.className = "sheet-drag-handle";
      handle.setAttribute("aria-hidden", "true");
      handle.dataset.sheetDragHandle = "";
      const bar = document.createElement("span");
      bar.className = "sheet-drag-handle-bar";
      handle.appendChild(bar);
      sheet.insertBefore(handle, sheet.firstChild);
      attachedTo = sheet;
      ctrl = attachSheetDrag({ overlay, sheet, handle, isTop, onDismiss: () => overlay.click() });
    };
    ensure();
    const mo = new MutationObserver(ensure);
    mo.observe(overlay, { childList: true });
    return () => { mo.disconnect(); detach(); };
  }, [canSwipe]);
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
    // viewport resize/scroll burst를 프레임당 한 번의 DOM 쓰기로 합친다(top/height 직접 쓰기는 유지 — 키보드에 맞춘 오버레이 크기 보정)
    let fitRaf = 0;
    const scheduleFit = () => { if (!fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; fit(); }); };
    viewport?.addEventListener("resize", scheduleFit);
    viewport?.addEventListener("scroll", scheduleFit);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      if (fitRaf) cancelAnimationFrame(fitRaf);
      viewport?.removeEventListener("resize", scheduleFit);
      viewport?.removeEventListener("scroll", scheduleFit);
      if (--locks === 0) document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [titleId]);
  return <div {...props} ref={ref} className={className} data-sheet-overlay role="dialog" aria-modal="true" tabIndex={-1}>{children}</div>;
}
