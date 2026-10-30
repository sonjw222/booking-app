import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PAYMENT_GATEWAY_NAMES } from "../../lib/paymentGatewayNotice";

// 법적 고지(약관·환불·처리방침·사업자 정보)의 PG 서술이 실제 구현과 맞는지 고정한다.
//  · 신규 PG = NICEPAY(lib/payments/*), 과거 토스페이먼츠 거래의 조회·취소·환불은 서버 라우트가 계속 지원(신규 Toss 결제 어댑터는 삭제됨).
//  · 계약·위탁 범위가 확인되지 않은 사항(정식 상호·소재지·보유기간 등)은 단정하지 않는다.
const root = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(root, p), "utf8");
const pages = { terms: rd("app/legal/terms/page.tsx"), refund: rd("app/legal/refund/page.tsx"), privacy: rd("app/legal/privacy/page.tsx"), business: rd("app/legal/business/page.tsx") };

describe("법적 고지 — PG 표기(단일 출처)", () => {
  it("현재 PG=NICEPAY, 과거 거래=토스페이먼츠 — 상수로만 쓰고 페이지에 하드코딩하지 않는다", () => {
    expect(PAYMENT_GATEWAY_NAMES).toEqual({ current: "NICEPAY", legacy: "토스페이먼츠" });
    for (const [name, src] of Object.entries(pages)) {
      expect(src, name).toContain("PAYMENT_GATEWAY_NAMES");
      expect(src, name).not.toMatch(/토스페이먼츠|NICEPAY/);   // 이름은 lib/paymentGatewayNotice.ts 한 곳
    }
  });
  it("실제 구현에 없는 결제수단(카카오페이·토스페이)을 현재 제공 수단으로 단정하지 않는다", () => {
    for (const [name, src] of Object.entries(pages)) expect(src, name).not.toMatch(/카카오페이|토스페이(?!먼츠)/);
  });
  it("제4조의 결제대금 수납 책임은 결제 조항 제9조를 참조한다", () => {
    expect(pages.terms).toContain("대금 수납을 직접 처리하며(제9조)");
    expect(pages.terms).not.toContain("대금 수납을 직접 처리하며(제12조)");
    expect(pages.terms).toContain("제9조 (결제)");
    expect(pages.terms).toContain("제12조 (분쟁해결 및 준거법)");
  });
  it("약관 제9조: 온라인 결제는 현재 PG 로 수납·구매 화면의 수단만·과거 거래의 취소·환불은 계속 처리, 정산 구조는 유지", () => {
    expect(pages.terms).toContain("결제대행사({PAYMENT_GATEWAY_NAMES.current})");
    expect(pages.terms).toContain("구매\n          화면에 표시되는");
    expect(pages.terms).toContain("{PAYMENT_GATEWAY_NAMES.legacy}를");
    expect(pages.terms).toContain("별도의 정산 절차를 통해 해당 대금을 센터에 지급합니다");
    expect(pages.terms).toContain("센터 현장\n          결제만 회사를 거치지 않고 회원이 센터에 직접 지급합니다");
  });
  it("환불 정책 4항: 결제 당시 PG(현재/과거)를 통해 승인 취소 — 환불 기간·조건 문장은 그대로", () => {
    expect(pages.refund).toContain("{PAYMENT_GATEWAY_NAMES.current}");
    expect(pages.refund).toContain("{PAYMENT_GATEWAY_NAMES.legacy}");
    expect(pages.refund).toContain("승인 취소되고, 계좌이체로 결제한 건은 등록하신");
    expect(pages.refund).toContain("영업일 기준 며칠 소요될 수 있습니다");
  });
  it("처리위탁 표: NICEPAY(활성화 시)와 토스페이먼츠(과거 거래) 두 행, 정식 상호·보유기간은 단정하지 않는다", () => {
    expect(pages.privacy).toMatch(/<th>\{PAYMENT_GATEWAY_NAMES\.current\}<\/th><td>[^<]*활성화 시[^<]*<\/td>/);
    expect(pages.privacy).toMatch(/<th>\{PAYMENT_GATEWAY_NAMES\.legacy\}<\/th><td>[^<]*과거[^<]*<\/td>/);
    expect(pages.privacy).not.toMatch(/주식회사|\(주\)|나이스페이먼츠|보유\s*기간[^<]*\d+\s*년/);   // 확인되지 않은 법인명·보유기간 금지
  });
  it("사업자 정보: 온라인 결제는 서비스 준비 상황에 따라 제공(결제 OFF 현실과 일치), 사업장 주소 표시는 기존 방식 유지", () => {
    expect(pages.business).toContain("온라인 결제 수단은 서비스 준비 상황에 따라 제공되고");
    expect(pages.business).toContain("{BUSINESS_ADDRESS}");
  });
  it("개인정보처리방침: 현재 일반 회원 온라인 PG 결제는 비활성이라는 서술 유지 + 카드 원문 미수집", () => {
    expect(pages.privacy).toContain("현재 일반 회원용 온라인 PG 결제는 비활성화되어");
    expect(pages.privacy).toContain("카드 원문 번호를 입력받거나 저장하지 않습니다");
  });
  it("사전 공지 후 정책 시행일은 2026-11-09이고 개인정보 공지일은 2026-10-30이다(PR #256 선배포)", () => {
    expect(pages.terms).toContain("시행일: 2026년 11월 9일");
    expect(pages.terms).toContain("이 약관은 2026년 11월 9일부터 시행합니다.");
    expect(pages.refund).toContain("시행일: 2026년 11월 9일");
    expect(pages.privacy).toContain("공지일: 2026년 10월 30일");
    expect(pages.privacy).toContain("시행일: 2026년 11월 9일");
  });
  // 소스 문자열이 아니라 "렌더된 문장"을 본다 — JSX 줄바꿈 때문에 표현식 옆 공백이 사라지는 문제("(현재NICEPAY")를 막는다.
  it("렌더된 문장: 표현식 주변 공백·조사가 자연스럽다(공백 누락 없음)", async () => {
    const text = async (mod: string) => { const m = await import(mod); return renderToStaticMarkup(createElement(m.default)).replace(/<[^>]+>/g, " ").replace(/&#x27;|&quot;/g, "").replace(/\s+/g, " "); };
    const [terms, refund, privacy, business] = await Promise.all(["../../app/legal/terms/page", "../../app/legal/refund/page", "../../app/legal/privacy/page", "../../app/legal/business/page"].map(text));
    expect(terms).toContain("회사가 결제대행사(NICEPAY)를 통해 직접 수납하며");
    expect(terms).toContain("과거 토스페이먼츠를 통해 결제된 거래의 취소·환불은 해당 결제대행사를 통해 계속 처리합니다");
    expect(refund).toContain("결제 당시의 결제대행사 (현재 NICEPAY, 과거 토스페이먼츠로 결제된 건은 토스페이먼츠)를 통해 승인 취소되고");
    expect(privacy).toContain("결제대행사(NICEPAY)로 전달되고");
    expect(privacy).toMatch(/NICEPAY 온라인 PG\(신용카드\) 결제 기능 활성화 시 결제 승인·취소 처리/);
    expect(privacy).toMatch(/토스페이먼츠 과거 토스페이먼츠로 결제된 거래의 조회·취소·환불 처리/);
    expect(business).toContain("결제대행사(NICEPAY)를 통해 직접 처리하며");
    expect(business).toContain("과거 토스페이먼츠로 결제된 건의 취소·환불은 해당 결제대행사를 통해 처리");
    for (const [n, t] of Object.entries({ terms, refund, privacy, business })) expect(t, n).not.toMatch(/현재NICEPAY|NICEPAY토스|토스페이먼츠결제|\)를통해/);
  });
});
