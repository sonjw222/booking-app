"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { SUBSCRIPTION_REVIEW_CENTER, SUBSCRIPTION_REVIEW_PAGE, SUBSCRIPTION_REVIEW_PATH, validateRegistrationParams } from "../../lib/payments/nicepaySubscriptionReviewProtocol";
import { loadRegistrationSdk, openRegistrationWindow, type RegistrationWindow } from "../../lib/payments/nicepaySubscriptionReviewWindow";

type Capability = { allowed?: boolean; hostedAvailable?: boolean; params?: unknown };
async function requestReview(centerId: string, action: "check" | "open", signal: AbortSignal): Promise<{ data: Capability; token: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return { data: {}, token: "" };
  const response = await fetch(SUBSCRIPTION_REVIEW_PATH, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ centerId, action }), signal, cache: "no-store" });
  if (!response.ok) return { data: {}, token: "" };
  return { data: await response.json() as Capability, token: session.access_token };
}
export default function NicepaySubscriptionReview({ centerId = SUBSCRIPTION_REVIEW_CENTER, entry = false }: { centerId?: string | null; entry?: boolean }) {
  const [capability, setCapability] = useState<{ center: string; allowed: boolean; hosted: boolean } | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "opened">("idle");
  const [message, setMessage] = useState("");
  const active = useRef<{ controller: AbortController; dispose?: () => void } | null>(null);
  const allowed = centerId === capability?.center && capability.allowed;
  useEffect(() => {
    if (centerId !== SUBSCRIPTION_REVIEW_CENTER) return;
    let controller = new AbortController();
    let mounted = true;
    const check = async () => {
      controller.abort();
      const current = new AbortController(); controller = current;
      const timer = setTimeout(() => current.abort(), 12000);
      try {
        const { data } = await requestReview(centerId, "check", current.signal);
        if (mounted && !current.signal.aborted) setCapability({ center: centerId, allowed: data.allowed === true, hosted: data.hostedAvailable === true });
      } catch { if (mounted && !current.signal.aborted) setCapability({ center: centerId, allowed: false, hosted: false }); }
      finally { clearTimeout(timer); }
    };
    void check();
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "INITIAL_SESSION") return;
      setCapability(null); active.current?.controller.abort(); active.current?.dispose?.(); active.current = null; setPhase("idle");
      // Schedule outside the auth callback to avoid waiting on the Supabase auth lock.
      queueMicrotask(() => { if (mounted) void check(); });
    });
    const returned = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // Mobile goPay leaves this document. Back may restore the old React state from BFCache.
      // Discard its pending form/callback, recheck permission, and require a fresh user click.
      active.current?.controller.abort(); active.current?.dispose?.(); active.current = null;
      setPhase("idle"); setCapability(null); setMessage("확인 화면으로 돌아왔습니다. 카드등록과 청구는 진행하지 않았습니다.");
      void check();
    };
    window.addEventListener("pageshow", returned);
    return () => { mounted = false; controller.abort(); active.current?.controller.abort(); active.current?.dispose?.(); active.current = null; listener.subscription.unsubscribe(); window.removeEventListener("pageshow", returned); };
  }, [centerId]);
  async function open() {
    if (!allowed || !capability?.hosted || active.current) return;
    const attempt = { controller: new AbortController(), dispose: undefined as (() => void) | undefined };
    active.current = attempt; setPhase("preparing"); setMessage("");
    const timer = setTimeout(() => attempt.controller.abort(), 12000);
    const current = () => active.current === attempt && !attempt.controller.signal.aborted;
    try {
      const { data, token } = await requestReview(SUBSCRIPTION_REVIEW_CENTER, "open", attempt.controller.signal);
      if (!current()) return;
      const params = data.allowed === true && data.hostedAvailable === true ? validateRegistrationParams(data.params, window.location.origin) : null;
      if (!params) throw new Error("현재는 확인창을 열 수 없어요");
      await loadRegistrationSdk(document, window as RegistrationWindow);
      if (!current()) return;
      const { data: { session } } = await supabase.auth.getSession();
      if (!current() || session?.access_token !== token) throw new Error("로그인 상태를 다시 확인해 주세요");
      clearTimeout(timer);
      setPhase("opened");
      attempt.dispose = openRegistrationWindow(params, document, window as RegistrationWindow, () => {
        if (active.current !== attempt) return;
        active.current = null; setPhase("idle"); setMessage("심사용 확인창을 닫았습니다. 카드등록과 청구는 진행하지 않았습니다.");
      });
    } catch {
      if (active.current === attempt) { attempt.dispose?.(); active.current = null; setPhase("idle"); setMessage("심사용 확인창을 열 수 없어요. 잠시 후 다시 확인해 주세요."); }
    } finally {
      clearTimeout(timer);
      if (active.current === attempt && attempt.controller.signal.aborted) { attempt.dispose?.(); active.current = null; setPhase("idle"); setMessage("확인 시간이 초과됐어요. 다시 확인해 주세요."); }
    }
  }
  if (entry) return allowed ? <div className="set-row col"><Link className="ghost-btn" href={SUBSCRIPTION_REVIEW_PAGE} prefetch={false}>카드 등록 심사용 확인</Link></div> : null;
  const cancelPreparing = () => { active.current?.controller.abort(); active.current?.dispose?.(); active.current = null; setPhase("idle"); setMessage("심사용 확인 준비를 취소했습니다. 청구는 진행하지 않았습니다."); };
  return <section className="review-window-card" aria-label="카드 등록 심사용 확인">
    <h1 className="review-window-title">카드 등록 심사용 확인</h1>
    <p className="review-window-sub">센터 운영자 월 39,000원 정기구독 · NICEPAY</p>
    <p className="review-window-sub">카드번호와 카드 인증정보를 입력하지 마세요. 카드등록·빌링키 발급·최초 결제·정기 청구는 진행하지 않습니다.</p>
    <p role="status" className="review-window-sub">{!allowed ? "심사 계정의 센터 오너 권한과 서버 준비 상태가 확인되어야 이용할 수 있어요." : capability?.hosted ? "호스팅 화면 확인만 가능합니다. 빌링키 발급과 청구는 차단되어 있어요." : "호스팅 화면 확인은 현재 잠겨 있어요. 빌링키 발급과 청구도 차단되어 있어요."}</p>
    <button className="ghost-btn" disabled={!allowed || !capability?.hosted || phase !== "idle"} onClick={() => void open()}>{phase === "preparing" ? "심사용 확인창 준비 중…" : phase === "opened" ? "심사용 확인창이 열려 있어요" : "카드 등록 심사용 확인"}</button>
    {phase === "preparing" && <><button type="button" hidden data-sheet-overlay aria-label="준비 취소" onClick={cancelPreparing} /><button className="ghost-btn" onClick={cancelPreparing}>준비 취소</button></>}
    <p role="status" aria-live="polite" className="review-window-msg">{message}</p>
  </section>;
}
