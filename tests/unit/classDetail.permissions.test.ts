import { beforeEach, describe, expect, it, vi } from "vitest";

/* 수업 상세의 "허용 수강권/강사/정원" 판정: 비로그인 RLS(빈 배열)·RPC 권한 오류·조회 실패를 '모든 수강권 가능'/'강사 없음'으로 오인하지 않는다. */
type Opts = { session: boolean; mode: "all" | "selected"; allowed?: { data: unknown; error: unknown }; trainers?: { data: unknown; error: unknown }; counts?: { data: unknown; error: unknown } };
let opts: Opts;
vi.mock("../../lib/supabaseClient", () => {
  const chain = (result: () => unknown) => { const c: Record<string, unknown> = {}; for (const m of ["select", "eq", "in", "neq", "gte", "order", "limit"]) c[m] = () => c; c.maybeSingle = async () => result(); c.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res); return c; };
  return { supabase: {
    auth: { getSession: async () => ({ data: { session: opts.session ? { user: { id: "u" } } : null } }) },
    from: (t: string) => {
      if (t === "classes") return chain(() => ({ data: { id: "c1", center_id: "ce", title: "수업", description: null, class_format: "group", place: null, start_time: "2030-01-01T00:00:00Z", end_time: "2030-01-01T01:00:00Z", capacity: 10, status: "open", booking_deadline_min: null, pass_selection_mode: opts.mode, rooms: null, centers: { name: "센터", categories: [], status: "approved" } }, error: null }));
      if (t === "class_reservation_counts") return chain(() => opts.counts ?? { data: [{ class_id: "c1", confirmed_count: 3 }], error: null });
      if (t === "class_allowed_products") return chain(() => opts.allowed ?? { data: [], error: null });
      throw new Error("unexpected table " + t);
    },
    rpc: () => Promise.resolve(opts.trainers ?? { data: [], error: null }),
  } };
});
import { fetchCenterClassDetail } from "../../lib/classDetail";
const get = () => fetchCenterClassDetail("ce", "c1").then((d) => d!);
beforeEach(() => { opts = { session: true, mode: "selected" }; });

describe("허용 수강권", () => {
  it("all 모드만 '모든 수강권 가능'(all)", async () => { opts = { session: false, mode: "all" }; expect((await get()).allowedPasses).toEqual({ kind: "all" }); opts.session = true; expect((await get()).allowedPasses).toEqual({ kind: "all" }); });
  it("selected + 비로그인: 빈 배열이어도(RLS) login_required — 모두 가능으로 보지 않는다", async () => { opts = { session: false, mode: "selected", allowed: { data: [], error: null } }; expect((await get()).allowedPasses).toEqual({ kind: "login_required" }); });
  it("selected + 로그인 + 목록: list(중복 제거)", async () => { opts.allowed = { data: [{ products: { name: "A" } }, { products: [{ name: "B" }] }, { products: { name: "A" } }], error: null }; expect((await get()).allowedPasses).toEqual({ kind: "list", names: ["A", "B"] }); });
  it("selected + 로그인 + 빈 목록: unknown_empty(확인 불가), 조회 오류: unavailable", async () => {
    opts.allowed = { data: [], error: null }; expect((await get()).allowedPasses).toEqual({ kind: "unknown_empty" });
    opts.allowed = { data: null, error: { message: "boom" } }; expect((await get()).allowedPasses).toEqual({ kind: "unavailable" });
  });
});
describe("강사", () => {
  it("비로그인 RPC 권한 오류 → login_required(없음으로 단정하지 않음), 로그인 오류 → unavailable", async () => {
    opts = { session: false, mode: "all", trainers: { data: null, error: { code: "42501", message: "permission denied" } } }; expect((await get()).trainers).toEqual({ kind: "login_required" });
    opts = { session: true, mode: "all", trainers: { data: null, error: { message: "boom" } } }; expect((await get()).trainers).toEqual({ kind: "unavailable" });
  });
  it("정상 응답: 목록 / 정상 응답인데 비어 있으면 none", async () => {
    opts = { session: true, mode: "all", trainers: { data: [{ class_id: "c1", name: "김", sort_order: 1 }], error: null } }; expect((await get()).trainers).toEqual({ kind: "list", names: ["김"] });
    opts.trainers = { data: [], error: null }; expect((await get()).trainers).toEqual({ kind: "none" });
  });
});
describe("정원", () => {
  it("예약 인원 집계 실패면 reservedKnown=false(잔여 자리를 말하지 않는다)", async () => {
    expect((await get()).reservedKnown).toBe(true);
    opts.counts = { data: null, error: { message: "boom" } }; const d = await get(); expect(d.reservedKnown).toBe(false); expect(d.reserved).toBe(0);
  });
});
