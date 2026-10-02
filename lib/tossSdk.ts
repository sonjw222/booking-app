/*
  전역 window.TossPayments 타입 선언 — 한 곳에서만 선언해야 한다(같은 전역 인터페이스를
  서로 다른 타입으로 두 곳에서 선언하면 TypeScript가 컴파일 에러를 낸다). 일반 회원 결제
  (P0-1, lib/payments/TossPaymentProvider.ts의 requestPayment)와 센터 플랫폼 구독 빌링
  카드 등록(P0-8, lib/centerSubscription.ts의 requestBillingAuth)이 서로 다른 시점에
  독립적으로 만들어지며 각자 이 전역을 선언하다 충돌했다 — 실제 토스 SDK v2의
  `payment()` 객체는 두 메서드를 전부 가지고 있으므로, 그 실제 형태 그대로 한 곳에
  합쳐뒀다.
*/

export type TossRequestPaymentParams = {
  // "CARD"(카드/카카오페이/토스페이 — 후자 둘은 card.flowMode:"DIRECT"+card.easyPay로 구분)
  // "TRANSFER"(실시간 계좌이체 — 은행 선택은 토스 결제창 자체 UI가 처리, 추가 파라미터 불필요)
  method: "CARD" | "TRANSFER";
  amount: { value: number; currency: "KRW" };
  orderId: string;
  orderName: string;
  customerEmail?: string;
  successUrl: string;
  failUrl: string;
  // 카카오페이/토스페이 등 간편결제를 열 때 card.flowMode:"DIRECT" + card.easyPay:"KAKAOPAY"|"TOSSPAY" 사용
  card?: { flowMode?: "DEFAULT" | "DIRECT"; easyPay?: string };
};

export type TossRequestBillingAuthParams = {
  method: "CARD";
  successUrl: string;
  failUrl: string;
};

export type TossPaymentInstance = {
  requestPayment: (params: TossRequestPaymentParams) => Promise<void>;
  requestBillingAuth: (params: TossRequestBillingAuthParams) => Promise<void>;
};

export type TossPaymentsSdk = {
  payment: (opts: { customerKey: string }) => TossPaymentInstance;
};

declare global {
  interface Window {
    TossPayments?: (clientKey: string) => TossPaymentsSdk;
  }
}

// 토스 결제 SDK v2 로더 — 전역 <Script>(app/layout.tsx)를 제거하고 결제/카드등록 화면에서만 필요할 때 로드한다(첫 실행·일반 화면의 불필요한 외부 JS 다운로드/실행 제거).
// 이미 로드돼 있으면 즉시 resolve, 로드 중인 script가 있으면 그 load를 기다리고(중복 삽입 없음), 시간 초과/실패는 reject한다.
export const TOSS_SDK_SRC = "https://js.tosspayments.com/v2/standard";

// 우리가 삽입한 script에만 붙는 표시 — 실패/시간 초과 시 이 script만 제거해 다음 호출이 깨끗하게 재시도할 수 있게 한다.
const LOADER_ATTR = "data-mwhabit-toss-sdk";
let inFlight: Promise<void> | null = null;

export function loadTossSdk(timeoutMs = 10000): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") return Promise.reject(new Error("토스 결제 SDK를 불러오지 못했어요"));
  if (window.TossPayments) return Promise.resolve();   // 성공 후에는 다시 다운로드하지 않는다
  if (inFlight) return inFlight;                        // 동시 호출은 같은 로드를 공유(script 중복 삽입 없음)
  const p = new Promise<void>((resolve, reject) => {
    let script: HTMLScriptElement | null = null;
    let settled = false;
    const cleanupFailed = () => { try { script?.remove(); } catch { /* 무시 */ } };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok && window.TossPayments) { resolve(); return; }
      cleanupFailed();   // error/timeout/로드됐지만 전역 없음 → 우리가 만든 script만 정리
      reject(new Error("토스 결제 SDK를 불러오지 못했어요"));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // 다른 코드가 넣은(우리 표시가 없는) 같은 src script가 이미 있으면 그 load를 기다리되 제거하지 않는다.
    const existing = document.querySelector(`script[src="${TOSS_SDK_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => finish(true));
      existing.addEventListener("error", () => finish(false));
      return;
    }
    script = document.createElement("script");
    script.src = TOSS_SDK_SRC;
    script.async = true;
    script.setAttribute(LOADER_ATTR, "1");
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    document.head.appendChild(script);
  });
  inFlight = p;
  const clear = () => { if (inFlight === p) inFlight = null; };
  p.then(clear, clear);
  return p;
}
