/*
  앱 전체 "뒤로가기" 단일 정책 (2026-11-09, UX 내비게이션 4-5).
  화면의 ‹ 버튼, iOS 왼쪽 가장자리 스와이프(네이티브가 window.__mwhabitBack 호출), Android 시스템 back 이
  모두 같은 판정(decideBack)과 같은 실행(runBack)을 쓴다 → 세 경로의 도착 화면이 항상 같다.
    1. 열린 시트/모달이 있으면 배경 화면 이동 없이 그 오버레이만 닫는다(확인 대화상자는 닫지 않고 무시).
    2. root 화면(탭)이면 아무것도 하지 않는다(iOS 스와이프는 네이티브가 이미 꺼짐, Android 는 앱 종료 관례).
    3. 앱 안에서 온 이전 화면이 있으면 그 화면으로(router.back), 딥링크 첫 진입이면 안전한 fallback 으로.
*/
import { hasInAppBackTarget, noteReplaceNavigation } from "./appHistory";
import { rootNavState } from "./navState";

export type BackDecision = "close-overlay" | "blocked-by-dialog" | "none" | "history-back" | "fallback";

export function decideBack(s: { overlayOpen: boolean; dialogOpen: boolean; isRoot: boolean; hasBackTarget: boolean; preferFallback?: boolean }): BackDecision {
  if (s.dialogOpen) return "blocked-by-dialog";
  if (s.overlayOpen) return "close-overlay";
  if (s.isRoot) return "none";
  if (s.hasBackTarget && !s.preferFallback) return "history-back";
  return "fallback";
}

/** 핸들러가 따로 등록되지 않은 화면의 안전한 기본 도착지(모드 홈). */
export function defaultBackFallback(pathname: string): string {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "/admin";
  if (pathname === "/manager" || pathname.startsWith("/manager/")) return "/manager";
  return "/";
}

export type BackRouter = { back: () => void; push: (href: string) => void; replace?: (href: string) => void };

export function hasKnownBackTarget(): boolean {
  if (typeof window === "undefined") return false;
  return hasInAppBackTarget() || (
    document.referrer.startsWith(window.location.origin) && window.history.length > 1);
}

function topOverlay(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return [...document.querySelectorAll<HTMLElement>("[data-sheet-overlay]")].at(-1) ?? null;
}

export function readBackState(): { overlayOpen: boolean; dialogOpen: boolean; isRoot: boolean; hasBackTarget: boolean } {
  return {
    overlayOpen: !!topOverlay(),
    dialogOpen: typeof document !== "undefined" && !!document.querySelector('[role="alertdialog"]'),
    isRoot: rootNavState.isRoot,
    hasBackTarget: hasKnownBackTarget(),
  };
}

/** 화면별 이동(‹ 버튼이 하는 일). 오버레이/root 판정은 호출 전에 끝났다. */
export function navigateBack(router: BackRouter, opts: { fallbackHref: string; preferFallback?: boolean }) {
  if (!opts.preferFallback && hasKnownBackTarget()) { router.back(); return; }
  if (opts.preferFallback || !router.replace) { router.push(opts.fallbackHref); return; }   // 예약 복귀처럼 "정해진 곳"으로 가는 경우는 기존 이동 유지
  // 되돌아갈 앱 안 화면이 없는 첫 진입(딥링크 등): 폴백으로 **대체**한다. push 하면 [첫 화면, 폴백] 두 entry 가 생겨 폴백의 ‹ 가 다시 첫 화면으로 돌아가는 왕복이 생긴다.
  noteReplaceNavigation();
  router.replace(opts.fallbackHref);
}

type BackHandler = () => void | Promise<void>;
let screenHandler: BackHandler | null = null;

/** 현재 화면의 ‹ 버튼 동작을 등록한다(스와이프/Android back 이 같은 동작을 쓰도록). 해제 함수를 돌려준다. */
export function registerScreenBack(handler: BackHandler): () => void {
  screenHandler = handler;
  return () => { if (screenHandler === handler) screenHandler = null; };
}

/** 헤더의 ‹ 컨트롤(고정 href 링크/버튼) — 스와이프·Android back 이 이 컨트롤을 누른 것과 똑같이 동작하게 한다. */
export function findBackControl(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const cands = document.querySelectorAll<HTMLElement>(".back-header a.side, .back-header button.side, .app-back-btn");
  for (const el of cands) {
    if (el.textContent?.trim() === "‹" && el.getClientRects().length > 0) return el;
  }
  return null;
}

/** 모든 back 입력의 단일 진입점. 실행한 판정을 돌려준다(Android 는 "none" 일 때 앱 종료). */
export function runBack(router: BackRouter, pathname: string): BackDecision {
  const state = readBackState();
  const decision = decideBack(state);
  if (decision === "close-overlay") topOverlay()?.click();
  else if (decision === "history-back" || decision === "fallback") {
    const control = screenHandler ? null : findBackControl();
    if (screenHandler) void screenHandler();
    else if (control) control.click();
    else navigateBack(router, { fallbackHref: defaultBackFallback(pathname) });
  }
  return decision;
}

declare global { interface Window { __mwhabitBack?: () => BackDecision } }

export function installBackBridge(router: BackRouter, getPathname: () => string): () => void {
  const fn = () => runBack(router, getPathname());
  window.__mwhabitBack = fn;
  return () => { if (window.__mwhabitBack === fn) delete window.__mwhabitBack; };
}
