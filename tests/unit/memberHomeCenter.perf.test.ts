/*
  PERF Batch A — 홈/센터 상세/검색 성능 정리 회귀 가드.
  supabase 클라이언트는 vi.mock으로 대체해 요청 횟수와 매핑 결과가 변하지 않았음을 확인한다.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let tables: Record<string, { data: unknown; error: unknown }> = {};

function builder(table: string) {
  calls.push(`from:${table}`);
  const result = () => tables[table] ?? { data: [], error: null };
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "gte", "order", "limit", "ilike", "overlaps", "contains"]) {
    b[m] = () => b;
  }
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
  return b;
}

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (name: string) => { calls.push(`rpc:${name}`); return Promise.resolve({ data: "acc-1", error: null }); },
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
  },
}));

import { fetchMyProfileIds, fetchNextReservation, fetchMyUpcomingClasses, searchHome } from "../../lib/home";
import { settle, unwrap } from "../../lib/center";

beforeEach(() => {
  calls.length = 0;
  tables = {};
});

describe("fetchMyProfileIds / 홈 프로필 조회 공유 (PERF-001)", () => {
  it("활성 프로필 id를 반환하고 RPC+profiles 2회만 조회한다", async () => {
    tables.profiles = { data: [{ id: "p1" }, { id: "p2" }], error: null };
    expect(await fetchMyProfileIds()).toEqual(["p1", "p2"]);
    expect(calls).toEqual(["rpc:my_account_id", "from:profiles"]);
  });

  it("같은 Promise를 두 함수에 넘기면 계정/프로필 조회는 1번만 일어난다", async () => {
    tables.profiles = { data: [{ id: "p1" }], error: null };
    tables.classes = { data: [], error: null };
    tables.memberships = { data: [], error: null };
    const shared = fetchMyProfileIds();
    const [next, upcoming] = await Promise.all([fetchNextReservation(shared), fetchMyUpcomingClasses(shared)]);
    expect(next).toBeNull();
    expect(upcoming).toEqual([]);
    expect(calls.filter((c) => c === "rpc:my_account_id")).toHaveLength(1);
    expect(calls.filter((c) => c === "from:profiles")).toHaveLength(1);
  });

  it("인자 없이 호출해도 기존처럼 동작한다(각자 조회)", async () => {
    tables.profiles = { data: [], error: null };
    expect(await fetchNextReservation()).toBeNull();
    expect(await fetchMyUpcomingClasses()).toEqual([]);
    expect(calls.filter((c) => c === "rpc:my_account_id")).toHaveLength(2);
  });

  it("다음 예약 매핑 결과가 동일하다", async () => {
    tables.profiles = { data: [{ id: "p1" }], error: null };
    tables.classes = {
      data: [{ title: "요가", start_time: "2030-01-02T10:00:00Z", centers: { name: "A센터" }, reservations: [{ status: "confirmed" }] }],
      error: null,
    };
    const r = await fetchNextReservation();
    expect(r).toMatchObject({ title: "요가", centerName: "A센터", status: "confirmed" });
  });

  it("profiles 오류: 다음 예약은 throw, 지금 예약 가능은 빈 목록(기존 동작)", async () => {
    tables.profiles = { data: null, error: new Error("boom") };
    await expect(fetchNextReservation()).rejects.toThrow("boom");
    expect(await fetchMyUpcomingClasses()).toEqual([]);
  });
});

describe("searchHome (PERF-005)", () => {
  it("이름 매칭과 종목 매칭 결과를 합치고 중복을 제거한다", async () => {
    tables.service_categories = { data: [{ label: "요가" }, { label: "필라테스" }], error: null };
    tables.centers = {
      data: [{ id: "c1", name: "요가원", categories: ["요가"], intro: null, photo_url: null, latitude: 1, longitude: 2 }],
      error: null,
    };
    const r = await searchHome("요가");
    expect(r.categories).toEqual(["요가"]);
    expect(r.centers.map((c) => c.id)).toEqual(["c1"]);
  });

  it("종목 라벨 조회 오류는 그대로 오류로 전달된다", async () => {
    tables.service_categories = { data: null, error: { message: "x" } };
    await expect(searchHome("요가")).rejects.toThrow("검색에 실패했어요");
  });
});

describe("settle / unwrap (PERF-003)", () => {
  it("성공은 값, 실패는 unwrap에서 원래 오류로 throw된다", async () => {
    expect(unwrap(await settle(Promise.resolve(3)))).toBe(3);
    const err = new Error("e");
    const r = await settle(Promise.reject(err));
    expect(r.ok).toBe(false);
    expect(() => unwrap(r)).toThrow(err);
  });
});
