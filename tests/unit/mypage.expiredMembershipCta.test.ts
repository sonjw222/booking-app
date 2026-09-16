/*
  릴리스 폴리시 배치 6차(2026-09-15, item 8) — 만료/소진된 수강권 카드의 CTA 정책 회귀
  방지. 이 프로젝트엔 컴포넌트 렌더링 테스트 도구가 없어(tests/unit/
  loginPage.appleButtonVisibility.test.ts와 동일 사유) 소스 구조 확인 방식을 쓴다.

  정책: 만료/소진된 수강권은 "이 수강권으로 예약하기"를 절대 보여주지 않는다(서버가
  거부하지만, UI에 될 것처럼 보이는 CTA 자체가 혼란을 줌). 우선순위 1) 같은 상품이
  아직 판매 중이면 "다시 구매하기" 2) 상품은 없어졌지만 센터는 살아있으면 "센터
  문의하기"(기존 1:1 문의 화면 재사용) 3) 둘 다 없으면 CTA 없이 상태 텍스트만.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/mypage/page.tsx"), "utf-8");

describe("app/mypage/page.tsx — 만료/소진 수강권 CTA 정책", () => {
  it("'이 수강권으로 예약하기'는 !ended 조건이 있어야 렌더링된다(만료/소진이면 절대 안 뜸)", () => {
    const idx = source.indexOf("이 수강권으로 예약하기 ›"); // 화살표(›)까지 포함해 설명 주석과 구분
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 120), idx);
    expect(before).toContain("!isGoods && !pending && !ended &&");
  });

  it("1순위 '다시 구매하기'는 avail?.productPurchasable일 때만 뜨고 정확한 상품 결제 URL로 이동한다", () => {
    const idx = source.indexOf("다시 구매하기 ›");
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 300), idx);
    expect(before).toContain("ended && avail?.productPurchasable");
    expect(before).toContain("/checkout?center=");
    // 상품이 사라진 경우엔 깨진 상품 ID 대신 센터 상세(구매 가능 목록)로 폴백한다.
    expect(before).toContain("/center/");
  });

  it("2순위 '센터 문의하기'는 상품은 없지만 센터가 살아있을 때만 뜨고, 기존 1:1 문의 화면을 재사용한다(새 시스템 없음)", () => {
    const idx = source.indexOf("센터 문의하기 ›");
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 150), idx);
    expect(before).toContain("ended && !avail?.productPurchasable && avail?.centerActive");
    expect(before).toContain('href="/inquiries"');
  });

  it("만료/소진 카드는 전체 카드 클릭이 예약 화면으로 가지 않는다(CardTag가 div로 바뀜)", () => {
    expect(source).toContain('const CardTag = ended ? "div" : "a";');
    expect(source).toContain("{...(ended ? {} : { href: `/reservation?center=${m.centerId}` })}");
  });

  it("만료/소진 카드의 progress bar는 100%로 '다 씀'을 시각적으로 보여준다(횟수가 남아 있어도 기간 만료면 착시 방지)", () => {
    expect(source).toContain("const pct = ended ? 100 :");
  });

  it("classifyMembershipDisplay(재사용 — 새 판정 로직 중복 없음)로 ended를 계산한다", () => {
    expect(source).toContain("const { isExpired, isExhausted, isPending: pending } = classifyMembershipDisplay(m);");
    expect(source).toContain("const ended = !isGoods && (isExpired || isExhausted);");
  });
});
