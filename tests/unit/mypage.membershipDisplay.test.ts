/*
  릴리스 폴리시 배치 6차(2026-09-15, item 7) — 마이페이지 수강권 정렬 정책 회귀 방지.
  기존엔 DB 쿼리가 expires_at 오름차순으로만 정렬해 이미 만료된 수강권(오래된
  expires_at)이 활성 수강권보다 위에 뜨는 문제가 있었다. 활성 → 시작 예정 → 정지중
  (아직 사용 가능) → 만료/소진(항상 마지막) 순으로 재배치하는 classifyMembershipDisplay/
  sortMembershipsForDisplay를 고정한다. 새 DB 상태값은 만들지 않고 schema.sql의 기존
  enum(active/expired/paused/refunded/transferred)만 쓴다.
*/
import { describe, expect, it } from "vitest";
import { classifyMembershipDisplay, sortMembershipsForDisplay } from "../../lib/mypage";

const TODAY = "2026-09-15";

function m(overrides: Partial<{ unlimited: boolean; remainingCount: number; expiresAt: string | null; startsAt: string | null; status: string }> = {}) {
  return {
    unlimited: false,
    remainingCount: 5,
    expiresAt: "2026-12-31",
    startsAt: "2026-01-01",
    status: "active",
    ...overrides,
  };
}

describe("classifyMembershipDisplay", () => {
  it("활성(만료 전, 잔여 있음, 시작함, 정지 아님) → tier 0", () => {
    const r = classifyMembershipDisplay(m(), TODAY);
    expect(r).toEqual({ tier: 0, isExpired: false, isExhausted: false, isPending: false, isPaused: false });
  });

  it("시작 예정(startsAt이 미래) → tier 1", () => {
    const r = classifyMembershipDisplay(m({ startsAt: "2026-10-01" }), TODAY);
    expect(r.tier).toBe(1);
    expect(r.isPending).toBe(true);
  });

  it("정지중(status=paused, 아직 사용 가능) → tier 2", () => {
    const r = classifyMembershipDisplay(m({ status: "paused" }), TODAY);
    expect(r.tier).toBe(2);
    expect(r.isPaused).toBe(true);
  });

  it("만료(expiresAt < today) → tier 3(항상 마지막), 정지중이어도 만료가 우선", () => {
    const r = classifyMembershipDisplay(m({ expiresAt: "2026-01-01", status: "paused" }), TODAY);
    expect(r.tier).toBe(3);
    expect(r.isExpired).toBe(true);
  });

  it("소진(remainingCount<=0) → tier 3", () => {
    const r = classifyMembershipDisplay(m({ remainingCount: 0 }), TODAY);
    expect(r.tier).toBe(3);
    expect(r.isExhausted).toBe(true);
  });

  it("무제한(unlimited)은 만료/소진 판정에서 제외 — expiresAt/remainingCount가 뭐든 tier 0", () => {
    const r = classifyMembershipDisplay(m({ unlimited: true, remainingCount: 0, expiresAt: "2026-01-01" }), TODAY);
    expect(r.tier).toBe(0);
    expect(r.isExpired).toBe(false);
    expect(r.isExhausted).toBe(false);
  });

  it("만료일이 오늘이면(경계값) 아직 만료 아님 — expires_at은 '이날까지 사용 가능'", () => {
    const r = classifyMembershipDisplay(m({ expiresAt: TODAY }), TODAY);
    expect(r.isExpired).toBe(false);
  });
});

describe("sortMembershipsForDisplay", () => {
  it("활성 → 시작예정 → 정지중 → 만료/소진 순으로 재배치한다(수락 기준: 만료가 활성보다 위로 뜨면 안 됨)", () => {
    const active = { id: "active", ...m() };
    const pending = { id: "pending", ...m({ startsAt: "2026-10-01" }) };
    const paused = { id: "paused", ...m({ status: "paused" }) };
    const expired = { id: "expired", ...m({ expiresAt: "2026-01-01" }) };
    const exhausted = { id: "exhausted", ...m({ remainingCount: 0 }) };

    // 일부러 만료/소진을 앞쪽에 섞어 넣는다 — 원래 버그(expires_at 오름차순만 적용하면
    // 오래된 만료 수강권이 맨 앞에 옴)를 재현하는 입력 순서.
    const input = [expired, exhausted, pending, active, paused];
    const sorted = sortMembershipsForDisplay(input, TODAY);
    expect(sorted.map((x) => x.id)).toEqual(["active", "pending", "paused", "expired", "exhausted"]);
  });

  it("같은 tier 안에서는 만료 임박(expires_at 오름차순) 순서를 유지한다", () => {
    const soon = { id: "soon", ...m({ expiresAt: "2026-09-20" }) };
    const later = { id: "later", ...m({ expiresAt: "2026-11-30" }) };
    const sorted = sortMembershipsForDisplay([later, soon], TODAY);
    expect(sorted.map((x) => x.id)).toEqual(["soon", "later"]);
  });

  it("무제한(expiresAt null)은 같은 tier 안에서 맨 뒤로 간다", () => {
    const withDate = { id: "withDate", ...m({ expiresAt: "2026-12-31" }) };
    const unlimited = { id: "unlimited", ...m({ unlimited: true, expiresAt: null }) };
    const sorted = sortMembershipsForDisplay([unlimited, withDate], TODAY);
    expect(sorted.map((x) => x.id)).toEqual(["withDate", "unlimited"]);
  });
});
