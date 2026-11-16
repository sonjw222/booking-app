"use client";

import { useEffect, useRef, useId, type HTMLAttributes } from "react";
import { attachSheetDrag, type SheetDragController } from "../../lib/sheetDrag";
import { acquireNoVerticalBounce } from "../../lib/nativeBounce";

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
  /**
   * (opt-in, 수강권 안내창) 본문에서 시작한 아래 드래그로도 닫기 + 시트 밖/스크롤 끝단 터치로 배경(WebView 문서)이 당겨져 흰 빈 영역이 생기는 것을 차단 +
   * iOS 왼쪽 가장자리 스와이프(네이티브 → window.__mwhabitBack)로 이 시트가 닫히거나 뒤 화면이 이동하지 않게 한다. 기본 false — 다른 시트는 변경 없음.
   */
  contentDrag?: boolean;
};

/** Shared overlay contract; existing close handlers still decide whether closing is allowed. */
export default function SheetOverlay({ children, className = "sheet-overlay", swipeDismiss = true, contentDrag = false, ...props }: SheetOverlayProps) {
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
      ctrl = attachSheetDrag({ overlay, sheet, handle, isTop, onDismiss: () => overlay.click(), contentDrag });
    };
    ensure();
    const mo = new MutationObserver(ensure);
    mo.observe(overlay, { childList: true });
    return () => { mo.disconnect(); detach(); };
  }, [canSwipe, contentDrag]);
  // (opt-in) 수강권 안내창이 열린 동안만 iOS WebView 문서 세로 바운스를 끄고(네이티브 NavigationPolicy.setVerticalBounceEnabled), 닫히면/언마운트되면 복원한다.
  useEffect(() => {
    if (!contentDrag) return;
    const release = acquireNoVerticalBounce();
    document.documentElement.classList.add("sheet-no-bounce");
    return () => { release(); if (!document.querySelector("[data-sheet-overlay][data-edge-swipe-block]")) document.documentElement.classList.remove("sheet-no-bounce"); };
  }, [contentDrag]);
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
      // body로 포털된 팝오버(DatePicker 등, data-overlay-portal)는 시트의 일부로 보고 포커스를 되돌리지 않는다.
      if (event.target instanceof Element && event.target.closest("[data-overlay-portal]")) return;
      if (isTop() && event.target instanceof Node && !overlay.contains(event.target)) overlay.focus({ preventScroll: true });
    };
    const viewport = window.visualViewport;
    const fit = () => {
      if (!viewport) return;
      // contentDrag 시트: 키보드가 올라온 경우(보이는 영역이 확연히 줄었을 때)만 보정한다 — 바운스·주소창 변화로 visualViewport 가 잠깐 흔들려도 오버레이가 화면 아래에서 떨어져 흰 영역이 생기지 않게.
      if (contentDrag && viewport.height >= window.innerHeight - 100) { overlay.style.top = ""; overlay.style.height = ""; overlay.style.bottom = ""; return; }
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
  }, [titleId, contentDrag]);
  return <div {...props} ref={ref} className={className} data-sheet-overlay {...(contentDrag ? { "data-edge-swipe-block": "" } : {})} role="dialog" aria-modal="true" tabIndex={-1}>{children}</div>;
}
