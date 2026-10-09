/*
  PERF-010 / PERF-012 / PERF-013 — 회원 예약·마이페이지 조회 병렬화와 앱 복귀 재조회 판정.
  가짜 supabase 클라이언트로 "독립 요청이 서로를 기다리지 않고 함께 시작되는지"(직렬이면 gate가
  영원히 안 열려 타임아웃)와 "반환 데이터가 기존과 동일한지"를 검증한다. DB/네트워크는 쓰지 않는다.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: null | { message: string }; count?: number };

const state = {
  started: [] as string[],
  handlers: {} as Record<string, (call: number) => Promise<Result> | Result>,
  calls: {} as Record<string, number>,
  rpc: {} as Record<string, () => Promise<Result> | Result>,
  authUser: { id: "u1" } as unknown,
};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  for (const m of ["select", "eq", "in", "is", "neq", "order", "limit", "gte", "lt", "range", "single"]) b[m] = chain;
  b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => {
    const n = (state.calls[table] = (state.calls[table] ?? 0) + 1);
    state.started.push(`${table}#${n}`);
    return Promise.resolve(state.handlers[table](n)).then(res, rej);
  };
  return b;
}
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (name: string) => {
      const b: Record<string, unknown> = { range: () => b };
      b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => {
        state.started.push(`rpc:${name}`);
        return Promise.resolve(state.rpc[name]()).then(res, rej);
      };
      return b;
    },
    auth: { getUser: async () => { state.started.push("auth.getUser"); await Promise.resolve(); return { data: { user: state.authUser } }; } },
  },
}));
vi.mock("../../lib/authAccount", () => ({
  getMyAccountId: async () => { state.started.push("rpc:my_account_id"); await Promise.resolve(); return "acc1"; },
}));
vi.mock("../../lib/payments/tossPaymentApi", () => ({ refundMembershipApi: vi.fn() }));
vi.mock("../../lib/nativePush", () => ({ disableNativePush: vi.fn() }));

import { fetchMyPage } from "../../lib/mypage";
import { fetchMonthData, getMyAccountId } from "../../lib/reservations";
import { RESUME_REFRESH_MIN_HIDDEN_MS, shouldRefreshOnResume } from "../../lib/useResumeRefresh";

// started 목록에 필요한 항목이 모두 생길 때까지 기다리는 gate
function gate(...needed: string[]) {
  return new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (needed.every((n) => state.started.some((s) => s === n || s.startsWith(n + "#")))) { clearInterval(t); resolve(); }
    }, 1);
  });
}
const ok = (data: unknown, extra: Partial<Result> = {}): Result => ({ data, error: null, ...extra });

beforeEach(() => {
  state.started = []; state.handlers = {}; state.calls = {}; state.rpc = {}; state.authUser = { id: "u1" };
});

describe("shouldRefreshOnResume (PERF-013)", () => {
  it("숨겨진 적 없거나 임계값 미만이면 재조회하지 않는다", () => {
    expect(shouldRefreshOnResume(null, 1_000_000)).toBe(false);
    expect(shouldRefreshOnResume(1_000_000, 1_000_000 + RESUME_REFRESH_MIN_HIDDEN_MS - 1)).toBe(false);
  });
  it("임계값(5분) 이상 숨겨져 있었으면 재조회한다", () => {
    expect(shouldRefreshOnResume(1_000_000, 1_000_000 + RESUME_REFRESH_MIN_HIDDEN_MS)).toBe(true);
    expect(RESUME_REFRESH_MIN_HIDDEN_MS).toBe(300000);
  });
});

describe("reservations.getMyAccountId (PERF-010)", () => {
  it("auth.getUser와 my_account_id가 함께 시작되고 같은 값을 반환한다", async () => {
    const id = await getMyAccountId();
    expect(id).toBe("acc1");
    expect(state.started.slice(0, 2).sort()).toEqual(["auth.getUser", "rpc:my_account_id"]);
  });
  it("미로그인이면 로그인 필요 에러", async () => {
    state.authUser = null;
    await expect(getMyAccountId()).rejects.toThrow("로그인이 필요해요");
  });
});

describe("fetchMyPage (PERF-012)", () => {
  it("accounts / manager_centers / 대표 프로필 / 전체 프로필 조회가 모두 먼저 시작되고 결과가 동일하다", async () => {
    const all = gate("accounts", "manager_centers", "profiles#1", "profiles#2");
    state.handlers.accounts = async () => { await all; return ok({ id: "acc1", name: "홍길동", phone: "010", is_member: true, is_platform_admin: false }); };
    state.handlers.manager_centers = async () => { await all; return ok(null, { count: 1 }); };
    state.handlers.profiles = async (n) => {
      await all;
      return n === 1
        ? ok([{ id: "p1", is_primary: true, created_at: "2026-01-01" }])
        : ok([{ id: "p1", name: "홍", nickname: null, label: null, is_primary: true }]);
    };
    state.handlers.memberships = () => ok([{
      id: "m1", profile_id: "p1", bound_profile_id: null, center_id: "c1", product_id: "pr1", product_name: "10회권",
      total_count: 10, remaining_count: 4, expires_at: "2099-01-01", starts_at: null, created_at: "2026-01-01", status: "active",
      centers: { name: "센터" }, products: { product_kind: "pass", unlimited: false },
    }]);
    state.handlers.reservations = () => ok([]);

    const out = await fetchMyPage();
    expect(out.profile).toEqual({ name: "홍길동", phone: "010", isMember: true, isManager: true, isPlatformAdmin: false });
    expect(out.memberships).toHaveLength(1);
    expect(out.memberships[0]).toMatchObject({ id: "m1", remainingCount: 4, centerName: "센터", kind: "pass", profileName: "" });
  });
  it("대표 프로필이 없으면 기존과 같은 에러", async () => {
    state.handlers.accounts = () => ok({ id: "acc1", name: "n", phone: null, is_member: true });
    state.handlers.manager_centers = () => ok(null, { count: 0 });
    state.handlers.profiles = () => ok([]);
    await expect(fetchMyPage()).rejects.toThrow("프로필이 없어요");
  });
});

describe("fetchMonthData (PERF-010)", () => {
  it("색상/운영설정/휴무일 조회가 예약 집계 조회와 함께 시작되고 결과가 동일하다", async () => {
    state.handlers.profiles = () => ok([{ id: "p1", is_primary: true }]);
    state.handlers.memberships = () => ok([{ id: "m1", center_id: "c1", remaining_count: 3, expires_at: null, status: "active" }]);
    state.handlers.classes = () => ok([{
      id: "cl1", center_id: "c1", title: "요가", description: null, start_time: "2026-10-12T01:00:00.000Z", end_time: "2026-10-12T02:00:00.000Z",
      capacity: 5, allow_goods: false, allow_cancel: true, class_format: "group", room_id: null,
      centers: { id: "c1", name: "센터", categories: ["요가"] }, rooms: null,
    }]);
    const early = gate("member_center_colors", "center_holidays", "center_settings#2");
    state.handlers.center_settings = (n) => ok(n === 1 ? [] : [{ center_id: "c1", show_group_reserved_count: false, show_group_waitlist_count: true }]);
    state.handlers.class_reservation_counts = async () => { await early; return ok([{ class_id: "cl1", confirmed_count: 2, waitlisted_count: 1 }]); };
    state.handlers.reservations = () => ok([{ id: "r1", class_id: "cl1", profile_id: "p1", status: "confirmed" }]);
    state.rpc.class_trainer_names = () => ok([]);
    state.handlers.member_center_colors = () => ok([{ center_id: "c1", color: "#123456" }]);
    state.handlers.center_holidays = () => ok([]);

    const data = await fetchMonthData(2026, 10, "acc1");
    expect(data.centers).toEqual([{ id: "c1", name: "센터", categories: ["요가"], color: "#123456" }]);
    expect(data.classes).toHaveLength(1);
    expect(data.classes[0]).toMatchObject({
      id: "cl1", reserved: 2, waitlisted: 1, capacity: 5, showReservedCount: false, showWaitlistCount: true,
      myByProfile: { p1: { reservationId: "r1", status: "confirmed" } },
    });
    expect(data.holidays).toEqual([]);
  });

  it("휴무일인 날의 수업은 기존처럼 숨긴다", async () => {
    state.handlers.profiles = () => ok([{ id: "p1", is_primary: true }]);
    state.handlers.memberships = () => ok([{ id: "m1", center_id: "c1", remaining_count: 3, expires_at: null, status: "active" }]);
    state.handlers.classes = () => ok([{
      id: "cl1", center_id: "c1", title: "요가", description: null, start_time: "2026-10-12T01:00:00.000Z", end_time: "2026-10-12T02:00:00.000Z",
      capacity: 5, allow_goods: false, allow_cancel: true, class_format: "group", room_id: null,
      centers: { id: "c1", name: "센터", categories: [] }, rooms: null,
    }]);
    state.handlers.center_settings = () => ok([]);
    state.handlers.class_reservation_counts = () => ok([]);
    state.handlers.reservations = () => ok([]);
    state.rpc.class_trainer_names = () => ok([]);
    state.handlers.member_center_colors = () => ok([]);
    state.handlers.center_holidays = () => ok([{ center_id: "c1", holiday_date: "2026-10-12", reason: "휴무" }]);
    const data = await fetchMonthData(2026, 10, "acc1");
    expect(data.classes).toHaveLength(0);
    expect(data.holidays).toHaveLength(1);
  });
});
