import { describe, it, expect, vi } from "vitest";
vi.mock("../../lib/supabaseClient", () => ({ supabase: {} }));
vi.mock("../../lib/authAccount", () => ({ getMyAccountId: async () => null }));
import { classifyPassStatus, decideClassAction, BLOCKED_COPY, type ViewerState } from "../../lib/classViewer";
import { emptyDayReason } from "../../lib/reservationCenter";
import { computeSearchView } from "../../lib/searchView";
import { checkoutCopy } from "../../lib/checkoutCopy";
import { classifyOrigin, originsFromPayments } from "../../lib/membershipOrigin";
import { formatCancelPolicy } from "../../lib/classDetail";

const today = "2026-10-18";
const pass = (o: Partial<{ status: string; remaining_count: number | null; expires_at: string | null; kind: "pass" | "goods" }> = {}) => ({ status: "active", remaining_count: 3, expires_at: null, kind: "pass" as const, ...o });

describe("classifyPassStatus (UX-03/04)", () => {
  it("서버가 사용 가능이라 한 수강권이 있으면 usable", () => expect(classifyPassStatus(1, [], today)).toBe("usable"));
  it("센터 수강권이 전혀 없으면 none", () => expect(classifyPassStatus(0, [], today)).toBe("none"));
  it("goods만 있으면 none(대여품은 수강권이 아니다)", () => expect(classifyPassStatus(0, [pass({ kind: "goods" })], today)).toBe("none"));
  it("유효한 수강권이 있지만 이 수업엔 못 쓰면 mismatch", () => expect(classifyPassStatus(0, [pass()], today)).toBe("mismatch"));
  it("만료·소진·환불뿐이면 expired_or_used", () => {
    expect(classifyPassStatus(0, [pass({ expires_at: "2026-10-01" })], today)).toBe("expired_or_used");
    expect(classifyPassStatus(0, [pass({ remaining_count: 0 })], today)).toBe("expired_or_used");
    expect(classifyPassStatus(0, [pass({ status: "expired" })], today)).toBe("expired_or_used");
  });
  it("환불된 수강권은 없는 것으로 본다", () => expect(classifyPassStatus(0, [pass({ status: "refunded" })], today)).toBe("none"));
});

const member = (statuses: ("usable" | "none" | "mismatch")[]): ViewerState => ({
  kind: "member",
  profiles: statuses.map((status, i) => ({ profile: { id: `p${i}`, name: `프로필${i}`, label: null, isPrimary: i === 0 }, usable: status === "usable" ? [{ membershipId: "m", productName: "10회권", remainingCount: 3, expiresAt: null, ownerProfile: "", isMine: true }] : [], status })),
});
describe("decideClassAction", () => {
  it("취소·지난·마감 수업은 closed", () => { for (const b of ["closed", "cancelled", "past"] as const) expect(decideClassAction(b, member(["usable"]), "p0")).toEqual({ kind: "closed" }); });
  it("비로그인은 로그인하고 예약", () => expect(decideClassAction("open", { kind: "anon" }, null)).toEqual({ kind: "login" }));
  it("수강권 현황을 못 읽으면 막지 않고 예약 단계(서버 판정)로", () => { expect(decideClassAction("open", { kind: "error" }, null)).toEqual({ kind: "check_at_reserve" }); expect(decideClassAction("open", null, null)).toEqual({ kind: "check_at_reserve" }); });
  it("선택한 프로필 기준으로 판정(프로필 전환 시 다시 계산)", () => {
    const v = member(["none", "usable"]);
    expect(decideClassAction("open", v, "p0")).toEqual({ kind: "blocked", reason: "none" });
    expect(decideClassAction("open", v, "p1")).toEqual({ kind: "reserve" });
  });
  it("조건 불일치는 이유가 mismatch", () => expect(decideClassAction("open", member(["mismatch"]), "p0")).toEqual({ kind: "blocked", reason: "mismatch" }));
  it("차단 안내문은 이유별로 다르다", () => { expect(new Set(Object.values(BLOCKED_COPY).map((c) => c.title)).size).toBe(3); });
});

describe("emptyDayReason (UX-15)", () => {
  const base = { holiday: false, centerUnavailable: false, monthClassesInScope: 5, dayClassesInScope: 0 };
  it("휴무일 우선", () => expect(emptyDayReason({ ...base, holiday: true })).toBe("holiday"));
  it("읽을 수 없는 센터는 이용 불가", () => expect(emptyDayReason({ ...base, centerUnavailable: true })).toBe("center_unavailable"));
  it("이 달에 그 센터 수업이 없으면 center_no_classes(선택한 날이 비어서가 아니다)", () => expect(emptyDayReason({ ...base, monthClassesInScope: 0 })).toBe("center_no_classes"));
  it("날짜에는 있는데 시간대·마감 필터가 가리면 filtered", () => expect(emptyDayReason({ ...base, dayClassesInScope: 2 })).toBe("filtered"));
  it("이 달엔 있지만 그날은 없으면 no_class_that_day", () => expect(emptyDayReason(base)).toBe("no_class_that_day"));
});

describe("computeSearchView (UX-08)", () => {
  const dist = (a: number, b: number, c: number, d: number) => Math.hypot(a - c, b - d) * 111;
  const input = (o: object) => ({ classes: [{ date: "2026-10-19", latitude: 37.5, longitude: 127 }], centers: [{ latitude: 37.5, longitude: 127 }], categories: [] as string[], scope: "all" as const, todayOnly: false, nearOnly: false, today: "2026-10-18", position: { lat: 37.5, lng: 127 }, radiusKm: 20, distanceKm: dist, ...o });
  it("결과가 있으면 none", () => expect(computeSearchView(input({})).empty).toBe("none"));
  it("검색어 자체의 결과가 없으면 no_match", () => expect(computeSearchView(input({ classes: [], centers: [] })).empty).toBe("no_match"));
  it("오늘 필터만 0건을 만들면 today_filter(필터를 풀면 결과가 돌아온다)", () => expect(computeSearchView(input({ todayOnly: true, scope: "classes" })).empty).toBe("today_filter"));
  it("주변 필터만 0건을 만들면 near_filter", () => expect(computeSearchView(input({ nearOnly: true, position: { lat: 35, lng: 129 } })).empty).toBe("near_filter"));
  it("센터 범위에서는 오늘 필터가 영향 없다", () => expect(computeSearchView(input({ todayOnly: true, scope: "centers" })).empty).toBe("none"));
});

describe("checkoutCopy (UX-11)", () => {
  it("센터 직접결제는 주문 접수 — '결제하기'라 부르지 않는다", () => {
    const c = checkoutCopy("direct", "160,000원");
    expect(c.mode).toBe("order_request");
    expect(c.button).toContain("주문 접수");
    expect(c.button).not.toContain("결제하기");
    expect(c.totalLabel).toBe("센터에서 결제할 금액");
    expect(c.consent).toBe("주문 접수 시");
  });
  it("온라인 결제는 결제하기", () => {
    const c = checkoutCopy("card", "160,000원");
    expect(c).toMatchObject({ mode: "online_pay", button: "160,000원 결제하기", totalLabel: "총 결제 금액" });
  });
});

describe("membershipOrigin (UX-16)", () => {
  it("service 결제(0원)만 있으면 무료 지급", () => expect(classifyOrigin([{ sale_type: "service", total_amount: 0 }])).toBe("free_grant"));
  it("금액이 있는 결제가 있으면 유료", () => expect(classifyOrigin([{ sale_type: "new", total_amount: 160000 }])).toBe("paid"));
  it("결제 기록이 없으면 무료라고 추정하지 않는다(unknown)", () => expect(classifyOrigin([])).toBe("unknown"));
  it("0원이지만 service가 아니면 unknown", () => expect(classifyOrigin([{ sale_type: "new", total_amount: 0 }])).toBe("unknown"));
  it("환불 행은 판정에서 제외", () => expect(classifyOrigin([{ sale_type: "service", total_amount: 0 }, { sale_type: "refund", total_amount: -1000 }])).toBe("free_grant"));
  it("수강권별로 묶어 판정", () => expect(originsFromPayments(["a", "b", "c"], [{ membership_id: "a", sale_type: "service", total_amount: 0 }, { membership_id: "b", sale_type: "new", total_amount: 1000 }])).toEqual({ a: "free_grant", b: "paid", c: "unknown" }));
});

describe("formatCancelPolicy", () => {
  it("취소 불가 수업", () => expect(formatCancelPolicy({ allowCancel: false, cancelDeadlineMin: 0 })).toContain("취소할 수 없는"));
  it("마감 분이 있으면 취소 가능 시한", () => expect(formatCancelPolicy({ allowCancel: true, cancelDeadlineMin: 120 })).toBe("수업 시작 2시간 전까지 취소 가능"));
  it("값이 없으면 지어내지 않는다", () => expect(formatCancelPolicy({ allowCancel: true, cancelDeadlineMin: 0 })).toBeNull());
});
