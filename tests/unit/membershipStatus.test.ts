import { describe, expect, it } from "vitest";
import { countKind, remainingPercent, remainingText, usageState } from "../../lib/membershipStatus";

const pass = (o: object = {}) => ({ productKind: "pass", unlimitedPass: false, unlimitedGoods: false, totalCount: 5, remainingCount: 3, ...o });
const TODAY = "2026-10-22";

describe("F17 — 횟수 종류와 표시", () => {
  it("유효 무제한 수강권(unlimited_pass=true, 상품용 unlimited=false, total=NULL)은 '무제한'", () => {
    const m = pass({ unlimitedPass: true, unlimitedGoods: false, totalCount: null, remainingCount: null });
    expect(countKind(m)).toBe("unlimited"); expect(remainingText(m)).toBe("무제한"); expect(remainingPercent(m)).toBeNull();
  });
  it("일반 횟수권 / 0회권", () => {
    expect(remainingText(pass())).toBe("3회 / 5회 남음"); expect(remainingPercent(pass())).toBe(60);
    expect(remainingText(pass({ remainingCount: 0 }))).toBe("0회 / 5회 남음"); expect(remainingPercent(pass({ remainingCount: 0 }))).toBe(0);
  });
  it("일반 횟수권의 비정상 NULL 은 무제한이 아니라 '횟수 정보 없음'(NaN·'null회' 없음)", () => {
    const m = pass({ totalCount: null, remainingCount: null });
    expect(countKind(m)).toBe("unknown"); expect(remainingText(m)).toBe("횟수 정보 없음"); expect(remainingPercent(m)).toBeNull();
  });
  it("대여 상품은 상품용 unlimited 로 판정한다(수강권 플래그와 섞이지 않음)", () => {
    expect(countKind({ productKind: "goods", unlimitedGoods: true, unlimitedPass: false, totalCount: null, remainingCount: null })).toBe("unlimited");
    expect(countKind({ productKind: "goods", unlimitedGoods: false, unlimitedPass: true, totalCount: 2, remainingCount: 2 })).toBe("limited");
  });
});

describe("F15 — 이용 상태(저장 상태 + 만료일 + 잔여 + 시작일)", () => {
  const st = (o: object) => usageState({ ...pass(), status: "active", expiresAt: null, ...o } as Parameters<typeof usageState>[0], TODAY);
  it("유효", () => expect(st({})).toBe("active"));
  it("저장 상태가 active 여도 만료일이 지났으면 만료", () => expect(st({ expiresAt: "2026-10-21" })).toBe("expired"));
  it("만료 당일은 아직 이용 가능(서버 expires_at >= 오늘과 동일)", () => expect(st({ expiresAt: TODAY })).toBe("active"));
  it("잔여 0회는 소진, 무제한은 소진되지 않는다", () => {
    expect(st({ remainingCount: 0 })).toBe("exhausted");
    expect(st({ unlimitedPass: true, totalCount: null, remainingCount: null })).toBe("active");
  });
  it("만료 무제한", () => expect(st({ unlimitedPass: true, totalCount: null, remainingCount: null, expiresAt: "2026-10-01" })).toBe("expired"));
  it("연장 후(만료일이 미래로 바뀌면) 다시 이용중", () => expect(st({ expiresAt: "2026-10-31" })).toBe("active"));
  it("시작 전 / 정지 / 환불 / 양도", () => {
    expect(st({ startsAt: "2026-11-01" })).toBe("upcoming");
    expect(st({ status: "paused" })).toBe("paused");
    expect(st({ status: "refunded", expiresAt: "2026-01-01" })).toBe("refunded");
    expect(st({ status: "transferred" })).toBe("transferred");
  });
});
