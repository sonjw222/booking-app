/*
  NICEPAY v3(MID/MerchantKey 계열) 결제창 — 브라우저 쪽 모듈. 공식 문서(developers.nicepay.co.kr/docs/pg/auth/payment-window/) 기준:
    · nicepay-pgweb.js 를 불러와 form 을 만들고 goPay(form) 을 호출한다. 콜백 이름은 고정: nicepaySubmit()(인증 완료 → form 제출), nicepayClose()(결제창 종료).
    · PC: 레이어 팝업. 인증이 끝나면 nicepaySubmit() 이 불리고 인증 결과 필드가 form 에 붙은 뒤 form 이 action 으로 제출된다 → 우리 서버 ReturnURL.
    · 모바일: goPay 가 form 을 결제창으로 제출하고, 인증 응답은 form 의 ReturnURL(필수)로 돌아온다 → 같은 서버 ReturnURL.
  이 모듈이 하는 일은 "결제창 호출"뿐이다. 승인(과금)은 인증 결과를 받은 서버 ReturnURL(app/api/payments/nicepay/return)이 Signature/금액을 검증한 뒤에만 한다 — 브라우저는 승인을 요청하지 못한다.
  MerchantKey/서명 원본은 브라우저에 없다: 서버(handlePrepare)가 만든 SignData(= sha256(EdiDate+MID+Amt+MerchantKey) 의 hex)만 받는다.
  fail-closed: 서버가 준 파라미터의 주문번호·금액이 화면의 주문과 다르거나, 허용되지 않은 필드/주소가 있으면 결제창을 열지 않는다.
*/
export const NICEPAY_V3_SDK_URL = "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js";

/** 서버가 내려주는 v3 결제창 파라미터(handlePrepare 의 v3_mid 응답). 이 목록 밖의 필드는 form 에 넣지 않는다. */
export type NicepayV3Params = {
  MID: string; Moid: string; Amt: string; GoodsName: string; EdiDate: string; SignData: string; ReturnURL: string; PayMethod: string; CharSet?: string;
};
const FIELD_ORDER = ["MID", "Moid", "Amt", "GoodsName", "EdiDate", "SignData", "ReturnURL", "PayMethod", "CharSet"] as const;
const FORBIDDEN_KEY = /merchant.?key|secret|private/i;   // 서버가 실수로 비밀값을 내려도 form 에 싣지 않는다

export function validateNicepayV3Params(raw: unknown, expected: { orderId: string; amount: number }, origin: string): { ok: true; params: NicepayV3Params } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "결제 정보가 없어요" };
  const p = raw as Record<string, unknown>;
  for (const k of Object.keys(p)) if (FORBIDDEN_KEY.test(k)) return { ok: false, reason: "허용되지 않은 결제 필드가 있어요" };
  for (const k of ["MID", "Moid", "Amt", "GoodsName", "EdiDate", "SignData", "ReturnURL", "PayMethod"]) if (typeof p[k] !== "string" || !(p[k] as string).trim()) return { ok: false, reason: `결제 정보(${k})가 올바르지 않아요` };
  if (p.Moid !== expected.orderId) return { ok: false, reason: "결제 주문번호가 주문과 일치하지 않아요" };
  if (!/^\d+$/.test(p.Amt as string) || p.Amt !== String(expected.amount)) return { ok: false, reason: "결제 금액이 주문과 일치하지 않아요. 다시 시도해주세요" };
  if (!/^\d{14}$/.test(p.EdiDate as string)) return { ok: false, reason: "결제 요청 시각 형식이 올바르지 않아요" };
  if (!/^[0-9a-f]{64}$/i.test(p.SignData as string)) return { ok: false, reason: "결제 검증값 형식이 올바르지 않아요" };
  if (p.PayMethod !== "CARD") return { ok: false, reason: "지원하지 않는 결제 방식이에요" };
  let u: URL; try { u = new URL(p.ReturnURL as string); } catch { return { ok: false, reason: "복귀 주소가 올바르지 않아요" }; }
  if (u.origin !== new URL(origin).origin || u.pathname !== "/api/payments/nicepay/return" || u.protocol !== "https:" && !/^http:\/\/localhost(:\d+)?$/.test(u.origin)) return { ok: false, reason: "복귀 주소가 허용되지 않아요" };
  const params: NicepayV3Params = { MID: p.MID as string, Moid: p.Moid as string, Amt: p.Amt as string, GoodsName: p.GoodsName as string, EdiDate: p.EdiDate as string, SignData: p.SignData as string, ReturnURL: p.ReturnURL as string, PayMethod: "CARD", ...(typeof p.CharSet === "string" ? { CharSet: p.CharSet } : {}) };
  return { ok: true, params };
}

/** form 에 넣을 필드(허용 목록 순서). */
export function nicepayV3FormFields(params: NicepayV3Params): Array<[string, string]> {
  return FIELD_ORDER.filter((k) => params[k] !== undefined).map((k) => [k, String(params[k])] as [string, string]);
}

type V3Win = Window & { goPay?: (form: HTMLFormElement) => void; nicepaySubmit?: () => void; nicepayClose?: () => void };
export type OpenV3Deps = { doc: Document; win: V3Win; onClosedBeforeSubmit?: () => void; closeGraceMs?: number };

/** 결제창을 연다(goPay 호출까지). 승인은 하지 않는다. 반환: 정리 함수. goPay 가 없으면 throw(SDK 로드 실패). */
export function openNicepayV3Window(params: NicepayV3Params, d: OpenV3Deps): () => void {
  const { doc, win } = d;
  if (typeof win.goPay !== "function") throw new Error("결제창을 불러오지 못했어요");
  const form = doc.createElement("form");
  form.name = "nicepayV3Form"; form.method = "post"; form.action = params.ReturnURL; form.setAttribute("accept-charset", "euc-kr"); form.style.display = "none";
  for (const [k, v] of nicepayV3FormFields(params)) { const i = doc.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; form.appendChild(i); }
  doc.body.appendChild(form);
  let submitted = false; let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; form.remove(); delete win.nicepaySubmit; delete win.nicepayClose; };
  win.nicepaySubmit = () => { submitted = true; form.submit(); };   // 인증 결과 필드가 붙은 form 을 우리 서버 ReturnURL 로 제출 — 승인은 서버가 한다
  win.nicepayClose = () => {
    // 인증을 마치고 제출하는 중이면 닫기 이벤트가 이어서 올 수 있다 — 유예 후에도 제출이 없었을 때만 "사용자가 닫음"으로 본다.
    setTimeout(() => { if (!submitted) { cleanup(); d.onClosedBeforeSubmit?.(); } }, d.closeGraceMs ?? 1500);
  };
  win.goPay(form);
  return cleanup;
}
