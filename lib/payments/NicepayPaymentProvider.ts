/*
  NicepayPaymentProvider — 브라우저 쪽 어댑터(결제창 호출 + 결과 확인). 실제 승인/취소/환불은 서버 라우트(app/api/payments/nicepay/*)가 하고 이 클래스는 PG 키/서명/승인 API를 전혀 모른다.
  fail-closed: ① NICEPAY_CHECKOUT_ACTIVATED(코드 상수)가 꺼져 있으면 모든 메서드가 거부한다. ② 켜져 있어도 서버가 준비(prepare)를 거부하면(설정 불완전/게이트/소유 불일치/주문 상태) 결제창을 열지 않는다.
  성공 판단: confirmPayment는 서버가 DB 주문 상태를 done이라고 말했을 때만 "paid" — 결제창에서 돌아왔다는 사실이나 클라이언트 값으로 성공 처리하지 않는다.
  결제창: REST(v1) 계열만 구현(JS SDK AUTHNICE.requestPay, 문서 기준). v3(MID) 계열 결제창(nicepay-pgweb.js goPay)은 계약 후 키 계열이 확정되면 별도 구현 — 지금은 명시적으로 거부한다.
*/
import { supabase } from "../supabaseClient";
import { NICEPAY_CHECKOUT_ACTIVATED } from "./PaymentProviderFactory";
import { abandonNicepayOrder, fetchNicepayStatus, pollNicepayStatus, prepareNicepay } from "./nicepayClientApi";
import type { CancelPaymentResult, ConfirmPaymentResult, CreatePaymentInput, CreatePaymentResult, PaymentProvider, PaymentStatusResult } from "./types";

const NOT_ACTIVE = "NicepayPaymentProvider는 아직 활성화되지 않았어요 (가맹점 계약·MID/KEY 필요)";
const ALLOWED_SDK_URLS = ["https://pay.nicepay.co.kr/v1/js/", "https://sandbox-pay.nicepay.co.kr/v1/js/"];

type RequestPayParams = Record<string, unknown> & { fnError?: (r: { errorMsg?: string }) => void };
declare global { interface Window { AUTHNICE?: { requestPay(p: RequestPayParams): void } } }

function loadSdk(url: string): Promise<void> {
  if (!ALLOWED_SDK_URLS.includes(url)) return Promise.reject(new Error("허용되지 않은 결제창 주소예요"));
  if (window.AUTHNICE) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url; el.async = true;
    el.onload = () => resolve(); el.onerror = () => reject(new Error("결제창을 불러오지 못했어요"));
    document.head.appendChild(el);
  });
}
const bearer = async () => (await supabase.auth.getSession()).data.session?.access_token ?? null;

export class NicepayPaymentProvider implements PaymentProvider {
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!NICEPAY_CHECKOUT_ACTIVATED) throw new Error(NOT_ACTIVE);
    const token = await bearer();
    if (!token) throw new Error("로그인이 필요해요");
    const prep = await prepareNicepay({ orderId: input.orderId, orderName: input.orderName, bearer: token });
    if (!prep.ok) throw new Error(typeof prep.data.error === "string" ? prep.data.error : "결제를 시작하지 못했어요");
    if (prep.data.family !== "rest_v1") throw new Error("이 결제 방식의 결제창은 아직 준비 중이에요");
    const params = prep.data.params as Record<string, unknown>;
    // 금액·주문번호는 서버가 DB 주문으로 만든 값이다 — 호출자가 넘긴 amount와 다르면 결제창을 열지 않는다(화면 표시와 실제 청구액 불일치 방지).
    if (params.orderId !== input.orderId || params.amount !== input.amount) throw new Error("결제 금액이 주문과 일치하지 않아요. 다시 시도해주세요");
    await loadSdk(String(prep.data.sdkUrl));
    return new Promise<CreatePaymentResult>((resolve, reject) => {
      window.AUTHNICE!.requestPay({ ...params, fnError: (r) => reject(new Error(r?.errorMsg ?? "결제창에서 오류가 발생했어요")) });
      resolve({ paymentKey: input.orderId, status: "pending", redirected: true });
    });
  }

  // 인증 결과는 서버(returnUrl)가 승인까지 처리한다. 여기서는 서버가 DB 진실(done)이라고 말할 때만 paid.
  async confirmPayment(_paymentKey: string, orderId: string): Promise<ConfirmPaymentResult> {
    if (!NICEPAY_CHECKOUT_ACTIVATED) throw new Error(NOT_ACTIVE);
    const r = await pollNicepayStatus({ orderId, bearer: await bearer() });
    if (r.ok && r.state === "done") return { status: "paid" };
    if (r.ok && r.state === "cancelled") return { status: "cancelled", message: "결제가 취소됐어요" };
    if (r.ok && r.state === "review") return { status: "failed", message: "결제 확인이 필요해요. 운영자에게 문의해주세요(다시 결제하지 마세요)" };
    return { status: "failed", message: "결제가 완료되지 않았어요" };
  }

  async cancelPayment(orderId: string): Promise<CancelPaymentResult> {
    if (!NICEPAY_CHECKOUT_ACTIVATED) throw new Error(NOT_ACTIVE);
    const r = await abandonNicepayOrder({ orderId, bearer: await bearer() });
    if (!r.ok) throw new Error(typeof r.data.error === "string" ? r.data.error : "주문을 취소하지 못했어요");
    return { status: "cancelled" };
  }

  async getPaymentStatus(orderId: string): Promise<PaymentStatusResult> {
    if (!NICEPAY_CHECKOUT_ACTIVATED) throw new Error(NOT_ACTIVE);
    const r = await fetchNicepayStatus({ orderId, bearer: await bearer() });
    return { orderId, status: r.state === "done" ? "paid" : r.state === "cancelled" ? "cancelled" : r.state === "review" ? "failed" : "pending" };
  }
}
