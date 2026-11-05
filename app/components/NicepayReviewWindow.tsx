"use client";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { NICEPAY_V3_SDK_URL, openNicepayV3Window } from "../../lib/payments/nicepayV3Window";
import { validateReviewWindowParams } from "../../lib/payments/reviewWindowClient";
import AppButton from "./AppButton";

const REVIEW_ACCOUNT_EMAIL = "niceqa@mwhabit.com";
type SdkWindow = Window & { goPay?: (form: HTMLFormElement) => void };
async function loadReviewSdk() {
  if (typeof (window as SdkWindow).goPay === "function") return;
  await new Promise<void>((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(`script[src="${NICEPAY_V3_SDK_URL}"]`);
    const created = !script;
    if (!script) { script = document.createElement("script"); script.src = NICEPAY_V3_SDK_URL; script.async = true; }
    const s = script;
    const clean = () => { clearTimeout(timer); s.removeEventListener("load", loaded); s.removeEventListener("error", failed); };
    const loaded = () => { clean(); typeof (window as SdkWindow).goPay === "function" ? resolve() : reject(new Error("결제창을 불러오지 못했어요")); };
    const failed = () => { clean(); if (created) s.remove(); reject(new Error("결제창을 불러오지 못했어요")); };
    const timer = window.setTimeout(failed, 15000);
    s.addEventListener("load", loaded); s.addEventListener("error", failed);
    if (created) document.head.appendChild(s);
  });
}
export type ReviewWindowStatus = "hidden" | "checking" | "allowed" | "denied";
type Phase = "idle" | "preparing" | "opened" | "closed" | "returned" | "error";
const sessionNow = async () => (await supabase.auth.getSession()).data.session;
const tokenNow = async () => {
  const session = (await supabase.auth.getSession()).data.session;
  return session?.user.email?.toLowerCase() === REVIEW_ACCOUNT_EMAIL ? session.access_token : null;
};
async function requestWindow(productId: string, action: "check" | "open", token: string) {
  const r = await fetch("/api/payments/nicepay/review-window", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ productId, action }), cache: "no-store" });
  if (!r.ok) return null;
  return await r.json() as { allowed?: boolean; params?: unknown };
}
/* 지정 심사 계정(niceqa) 전용 "카드 결제창 확인" 카드. 승인·주문·이용권 생성은 하지 않는다.
   onStatusChange: 결제 화면이 실제 결제 버튼을 잠그는 데 쓴다 — 지정 계정이면 권한 확인 중·허용·확인 실패 모두 실제 결제 경로로 fallback 하지 않는다.
   창 상태: 준비 중(서명 발급·SDK 로드) / 열림(goPay 호출 후, 닫기 콜백 없이도 앱 복귀·화면 복귀 때 복구) / 닫음 / 복귀 / 오류(재시도). 타이머로 성공 처리하지 않는다. */
export default function NicepayReviewWindow({ productId, onStatusChange }: { productId: string; onStatusChange?: (s: ReviewWindowStatus) => void }) {
  const [status, setStatusState] = useState<ReviewWindowStatus>("hidden"), [phase, setPhase] = useState<Phase>("idle"), [message, setMessage] = useState("");
  const [authVersion, setAuthVersion] = useState(0);
  const generation = useRef(0), inFlight = useRef(false), windowOpen = useRef(false), hiddenSinceOpen = useRef(false), cleanupRef = useRef<null | (() => void)>(null);
  const notify = useRef(onStatusChange); notify.current = onStatusChange;
  const setStatus = (s: ReviewWindowStatus) => { setStatusState(s); notify.current?.(s); };
  const resetWindow = () => { windowOpen.current = false; hiddenSinceOpen.current = false; cleanupRef.current?.(); cleanupRef.current = null; };
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => { generation.current++; resetWindow(); setStatus("hidden"); setPhase("idle"); setMessage(""); setAuthVersion(v => v + 1); });
    return () => { data.subscription.unsubscribe(); generation.current++; resetWindow(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const g = ++generation.current;
    setStatus("hidden"); setPhase("idle"); setMessage("");
    void (async () => {
      try {
        const session = await sessionNow();
        if (session?.user.email?.toLowerCase() !== REVIEW_ACCOUNT_EMAIL || !productId) return;   // 지정 계정이 아니면 아무것도 보이지 않고 요청도 하지 않는다
        if (generation.current === g) setStatus("checking");
        const token = session.access_token;
        const result = await requestWindow(productId, "check", token);
        if (generation.current === g && await tokenNow() === token && generation.current === g) setStatus(result?.allowed === true ? "allowed" : "denied");
      } catch { if (generation.current === g) setStatus("denied"); }   // 확인 실패 = 지정 계정은 실제 결제로 넘어가지 않는다
    })();
    return () => { generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, authVersion]);
  // 열림 상태 복구: 앱/탭이 백그라운드로 갔다가 돌아오거나(visibility) bfcache 로 복귀(pageshow)하면 "열림"에 머물지 않는다. 성공으로 간주하지 않는다.
  useEffect(() => {
    const back = () => { if (!windowOpen.current) return; resetWindow(); setPhase("returned"); setMessage("결제창에서 돌아왔어요. 주문과 이용권은 생성되지 않았습니다."); };
    const onVisibility = () => { if (document.visibilityState === "hidden") { if (windowOpen.current) hiddenSinceOpen.current = true; } else if (hiddenSinceOpen.current) back(); };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) back(); };
    document.addEventListener("visibilitychange", onVisibility); window.addEventListener("pageshow", onShow);
    return () => { document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pageshow", onShow); };
  }, []);
  async function open() {
    if (status !== "allowed" || inFlight.current || windowOpen.current) return;
    const g = generation.current;
    inFlight.current = true; setPhase("preparing"); setMessage("");
    let failed = false;
    try {
      const token = await tokenNow();
      if (!token) throw new Error("다시 로그인해 주세요");
      const result = await requestWindow(productId, "open", token);
      const params = result?.allowed === true ? validateReviewWindowParams(result.params, window.location.origin) : null;
      if (!params) throw new Error("테스트 결제창 정보를 확인할 수 없어요. 잠시 후 다시 시도해 주세요");
      await loadReviewSdk();
      if (generation.current !== g || await tokenNow() !== token || generation.current !== g) throw new Error("로그인 상태가 변경됐어요. 다시 확인해 주세요");
      windowOpen.current = true; hiddenSinceOpen.current = false;
      cleanupRef.current = openNicepayV3Window(params, { doc: document, win: window as unknown as Window & { goPay: (f: HTMLFormElement) => void }, onClosedBeforeSubmit: () => { if (generation.current === g) { resetWindow(); setPhase("closed"); setMessage("테스트 결제창을 닫았습니다. 주문과 이용권을 생성하지 않았습니다."); } } });
      if (generation.current === g && windowOpen.current) setPhase("opened");
    } catch (e) { failed = true; if (generation.current === g) { resetWindow(); setPhase("error"); setMessage(e instanceof Error ? e.message : "테스트 결제창을 열 수 없어요"); } }
    finally { inFlight.current = false; if (!failed && generation.current !== g) resetWindow(); }
  }
  if (status === "hidden") return null;
  if (status === "checking") return <section aria-label="카드 결제창 확인" className="review-window-card" aria-busy="true"><p className="review-window-title">카드 결제창 확인</p><p className="review-window-sub" role="status">심사 계정 권한을 확인하는 중이에요. 확인되기 전에는 결제할 수 없어요.</p></section>;
  if (status === "denied") return <section aria-label="카드 결제창 확인" className="review-window-card is-error"><p className="review-window-title">카드 결제창 확인을 사용할 수 없어요</p><p className="review-window-sub" role="alert">이 상품은 테스트 결제창 대상이 아니거나 권한을 확인하지 못했어요. 실제 결제는 진행되지 않아요.</p></section>;
  const busy = phase === "preparing" || phase === "opened";
  const label = phase === "preparing" ? "결제창 준비 중…" : phase === "opened" ? "결제창이 열려 있어요" : phase === "error" ? "다시 시도" : "카드 결제창 확인 (승인 없음)";
  return <section aria-label="카드 결제창 확인" className="review-window-card">
    <p className="review-window-title">카드 결제창 확인 <span className="review-window-badge">심사 계정 전용 · 승인 없음</span></p>
    <ul className="review-window-sub review-window-list">
      <li>카드번호나 카드 인증정보를 입력하지 마세요.</li>
      <li>결제 승인과 주문·이용권 생성은 하지 않아요.</li>
      <li>할인·포인트 없이 상품 기본 가격으로 확인해요.</li>
    </ul>
    <AppButton variant="secondary" className="review-window-btn" disabled={busy} onClick={() => void open()}>{label}</AppButton>
    {phase === "opened" && <AppButton variant="tertiary" className="review-window-btn" onClick={() => { resetWindow(); setPhase("idle"); setMessage("결제창 상태를 초기화했어요. 주문과 이용권은 생성되지 않았습니다."); }}>창이 안 보이면 상태 초기화</AppButton>}
    <p role={phase === "error" ? "alert" : "status"} aria-live="polite" className={`review-window-msg${phase === "error" ? " is-error" : ""}`}>{message}</p>
  </section>;
}
