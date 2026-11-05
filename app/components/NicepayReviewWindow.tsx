"use client";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { NICEPAY_V3_SDK_URL, openNicepayV3Window } from "../../lib/payments/nicepayV3Window";
import { validateReviewWindowParams } from "../../lib/payments/reviewWindowClient";

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
const tokenNow = async () => {
  const session = (await supabase.auth.getSession()).data.session;
  return session?.user.email?.toLowerCase() === "niceqa@mwhabit.com" ? session.access_token : null;
};
async function requestWindow(productId: string, action: "check" | "open", token: string) {
  const r = await fetch("/api/payments/nicepay/review-window", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ productId, action }), cache: "no-store" });
  if (!r.ok) return null;
  return await r.json() as { allowed?: boolean; params?: unknown };
}
export default function NicepayReviewWindow({ productId }: { productId: string }) {
  const [allowed, setAllowed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [authVersion, setAuthVersion] = useState(0);
  const generation = useRef(0), inFlight = useRef(false), windowOpen = useRef(false);
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange(() => { generation.current++; windowOpen.current = false; setAllowed(false); setBusy(false); setMessage(""); setAuthVersion(v => v + 1); });
    return () => { data.subscription.unsubscribe(); generation.current++; };
  }, []);
  useEffect(() => {
    const g = ++generation.current;
    setAllowed(false); setMessage("");
    void (async () => {
      try {
        const token = await tokenNow();
        if (!token || !productId) return;
        const result = await requestWindow(productId, "check", token);
        if (generation.current === g && await tokenNow() === token && generation.current === g) setAllowed(result?.allowed === true);
      } catch { /* Default hidden for normal users, disabled configuration, and failed checks. */ }
    })();
    return () => { generation.current++; };
  }, [productId, authVersion]);
  async function open() {
    if (!allowed || inFlight.current || windowOpen.current) return;
    const g = generation.current;
    inFlight.current = true; setBusy(true); setMessage("");
    try {
      const token = await tokenNow();
      if (!token) throw new Error("다시 로그인해 주세요");
      const result = await requestWindow(productId, "open", token);
      const params = result?.allowed === true ? validateReviewWindowParams(result.params, window.location.origin) : null;
      if (!params) throw new Error("테스트 결제창 정보를 확인할 수 없어요");
      await loadReviewSdk();
      if (generation.current !== g || await tokenNow() !== token || generation.current !== g) throw new Error("로그인 상태가 변경됐어요. 다시 확인해 주세요");
      windowOpen.current = true;
      openNicepayV3Window(params, { doc: document, win: window as unknown as Window & { goPay: (f: HTMLFormElement) => void }, onClosedBeforeSubmit: () => { if (generation.current === g) { windowOpen.current = false; setBusy(false); setMessage("테스트 결제창을 닫았습니다. 주문과 이용권을 생성하지 않았습니다."); } } });
    } catch (e) { if (generation.current === g) { windowOpen.current = false; setMessage(e instanceof Error ? e.message : "테스트 결제창을 열 수 없어요"); } }
    finally { inFlight.current = false; if (generation.current === g && !windowOpen.current) setBusy(false); }
  }
  if (!allowed) return null;
  return <section aria-label="NICEPAY 결제창 확인" className="menu-section">
    <p>심사 계정 전용 결제창 확인입니다. 카드번호나 카드 인증정보를 입력하지 마세요.</p>
    <p>결제 승인과 주문·이용권 생성은 진행하지 않습니다. 할인·포인트를 적용하지 않은 상품 기본 가격으로 확인합니다.</p>
    <button type="button" className="secondary-btn" disabled={busy} onClick={() => void open()}>{busy ? "결제창 준비 중…" : "카드 결제창 확인 (승인 없음)"}</button>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
