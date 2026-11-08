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
/* resolving: 계정 판별 중(세션 확인 전) — 지정 계정일 수 있으므로 결제 화면은 실제 카드 결제를 잠근다. hidden: 지정 계정이 아님이 "확정"된 일반 회원. */
export type ReviewWindowStatus = "resolving" | "hidden" | "checking" | "allowed" | "denied";
type Phase = "idle" | "preparing" | "opened" | "closed" | "returned" | "error";
const sessionNow = async () => (await supabase.auth.getSession()).data.session;
const tokenNow = async () => {
  const session = (await supabase.auth.getSession()).data.session;
  return session?.user.email?.toLowerCase() === REVIEW_ACCOUNT_EMAIL ? session.access_token : null;
};
export const REVIEW_REQUEST_TIMEOUT_MS = 12000;
/* review-window 요청 — 제한 시간(기본 12초) 안에 응답이 없거나 호출자가 abort 하면 중단한다(AbortError). */
async function requestWindow(productId: string, action: "check" | "open", token: string, signal?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REVIEW_REQUEST_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener("abort", onAbort);
  try {
    const r = await fetch("/api/payments/nicepay/review-window", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ productId, action }), cache: "no-store", signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json() as { allowed?: boolean; params?: unknown };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}
/* 지정 심사 계정(niceqa) 전용 "카드 결제창 확인" 카드. 승인·주문·이용권 생성은 하지 않는다.
   onStatusChange: 결제 화면이 실제 결제 버튼을 잠그는 데 쓴다 — 지정 계정이면 권한 확인 중·허용·확인 실패 모두 실제 결제 경로로 fallback 하지 않는다.
   창 상태: 준비 중(서명 발급·SDK 로드) / 열림(goPay 호출 후, 닫기 콜백 없이도 앱 복귀·화면 복귀 때 복구) / 닫음 / 복귀 / 오류(재시도). 타이머로 성공 처리하지 않는다. */
export default function NicepayReviewWindow({ productId, onStatusChange }: { productId: string; onStatusChange?: (s: ReviewWindowStatus) => void }) {
  const [status, setStatusState] = useState<ReviewWindowStatus>("resolving"), [phase, setPhase] = useState<Phase>("idle"), [message, setMessage] = useState("");
  const [authVersion, setAuthVersion] = useState(0);
  const generation = useRef(0), windowOpen = useRef(false), hiddenSinceOpen = useRef(false), cleanupRef = useRef<null | (() => void)>(null);
  // 열기 시도별 식별자 + 취소 — 초기화·재시도·취소 뒤에 늦게 도착한 이전 응답이 goPay 를 부르거나 새 상태를 덮어쓰지 않게 한다.
  const attemptSeq = useRef(0), attempt = useRef<{ id: number; ctrl: AbortController } | null>(null), openedId = useRef(0);
  const notify = useRef(onStatusChange);
  useEffect(() => { notify.current = onStatusChange; });   // 렌더 중 ref 를 바꾸지 않고, 커밋 뒤에 최신 콜백을 보관한다
  const setStatus = (s: ReviewWindowStatus) => { setStatusState(s); notify.current?.(s); };
  useEffect(() => { notify.current?.("resolving"); }, []);   // 마운트 즉시 "판별 중"을 알린다(부모 초기값과 같음) — 세션 확인 전에도 실제 카드 결제가 열리지 않는다
  const cancelAttempt = () => { const a = attempt.current; attempt.current = null; a?.ctrl.abort(); };
  const resetWindow = () => { cancelAttempt(); openedId.current = 0; windowOpen.current = false; hiddenSinceOpen.current = false; cleanupRef.current?.(); cleanupRef.current = null; };
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => { generation.current++; resetWindow(); setStatus("resolving"); setPhase("idle"); setMessage(""); setAuthVersion(v => v + 1); });
    return () => { data.subscription.unsubscribe(); generation.current++; resetWindow(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const g = ++generation.current, ctrl = new AbortController();
    // 초기 상태(resolving·idle)는 마운트 때 이미 그 값이고, 로그인 변경 시에는 아래 onAuthStateChange 처리기가 먼저 같은 값으로 되돌린다 — effect 본문에서 동기 setState 를 하지 않는다.
    //(productId 가 바뀌면 부모가 key 로 다시 마운트한다)
    void (async () => {
      try {
        const session = await sessionNow();
        if (generation.current !== g) return;
        if (session?.user.email?.toLowerCase() !== REVIEW_ACCOUNT_EMAIL || !productId) { setStatus("hidden"); return; }   // 지정 계정이 아님이 확정된 뒤에만 hidden — 요청도 하지 않는다
        setStatus("checking");
        const token = session.access_token;
        const result = await requestWindow(productId, "check", token, ctrl.signal);
        if (generation.current === g && await tokenNow() === token && generation.current === g) setStatus(result?.allowed === true ? "allowed" : "denied");
      } catch { if (generation.current === g) setStatus("denied"); }   // 세션 조회 실패·확인 시간 초과·오류 = 실제 결제로 넘어가지 않는다
    })();
    return () => { generation.current++; ctrl.abort(); };
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
    if (status !== "allowed" || attempt.current || windowOpen.current) return;
    const g = generation.current, id = ++attemptSeq.current, ctrl = new AbortController();
    attempt.current = { id, ctrl };
    const current = () => generation.current === g && attempt.current?.id === id;   // 이 시도가 아직 유효한가(초기화·취소·재시도·로그인 변경이 없었는가)
    setPhase("preparing"); setMessage("");
    try {
      const token = await tokenNow();
      if (!current()) return;
      if (!token) throw new Error("다시 로그인해 주세요");
      const result = await requestWindow(productId, "open", token, ctrl.signal);
      if (!current()) return;
      const params = result?.allowed === true ? validateReviewWindowParams(result.params, window.location.origin) : null;
      if (!params) throw new Error("테스트 결제창 정보를 확인할 수 없어요. 잠시 후 다시 시도해 주세요");
      await loadReviewSdk();
      if (!current()) return;
      if (await tokenNow() !== token || !current()) { if (current()) throw new Error("로그인 상태가 변경됐어요. 다시 확인해 주세요"); return; }
      windowOpen.current = true; hiddenSinceOpen.current = false;
      cleanupRef.current = openNicepayV3Window(params, { doc: document, win: window as unknown as Window & { goPay: (f: HTMLFormElement) => void }, onClosedBeforeSubmit: () => { if (generation.current === g && openedId.current === id) { resetWindow(); setPhase("closed"); setMessage("테스트 결제창을 닫았습니다. 주문과 이용권을 생성하지 않았습니다."); } } });
      if (current() && windowOpen.current) { attempt.current = null; openedId.current = id; setPhase("opened"); }   // 열림 이후는 창 이벤트가 상태를 정한다(요청 취소는 더 필요 없다)
    } catch (e) {
      if (!current()) return;   // 취소·교체된 시도의 늦은 오류는 새 상태를 덮어쓰지 않는다
      const timedOut = ctrl.signal.aborted || (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError");   // 제한 시간 초과(요청 내부 abort). resetWindow 가 abort 하기 전에 읽는다
      resetWindow(); setPhase("error");
      setMessage(timedOut ? "응답이 너무 늦어요. 네트워크를 확인하고 다시 시도해 주세요" : e instanceof Error ? e.message : "테스트 결제창을 열 수 없어요");
    }
  }
  // 준비 중 취소 — 진행 중 요청을 끊고 처음 상태로. 이후 도착하는 응답은 시도 식별자가 달라 무시된다.
  const cancelPreparing = () => { resetWindow(); setPhase("idle"); setMessage("결제창 준비를 취소했어요. 주문과 이용권은 생성되지 않았습니다."); };
  if (status === "hidden" || status === "resolving") return null;
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
    {phase === "preparing" && <AppButton variant="tertiary" className="review-window-btn" onClick={cancelPreparing}>준비 취소</AppButton>}
    {phase === "opened" && <AppButton variant="tertiary" className="review-window-btn" onClick={() => { resetWindow(); setPhase("idle"); setMessage("결제창 상태를 초기화했어요. 주문과 이용권은 생성되지 않았습니다."); }}>창이 안 보이면 상태 초기화</AppButton>}
    <p role={phase === "error" ? "alert" : "status"} aria-live="polite" className={`review-window-msg${phase === "error" ? " is-error" : ""}`}>{message}</p>
  </section>;
}
