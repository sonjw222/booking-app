import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn(); const access = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("../../lib/authAccount", () => ({ fetchMyNicepayReviewAccess: () => access() }));
import { nicepayDiscoveryScope, narrowToReviewCenters, fetchNicepayViewOnlyCenter } from "../../lib/nicepayReviewScope";

const ID1 = "8965e09c-0d2b-44c6-ab26-40a85507f8b5", ID2 = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { rpc.mockReset(); access.mockReset(); });
type Call = [string, ...unknown[]];
const builder = () => { const calls: Call[] = []; const q = { eq: (...a: unknown[]) => { calls.push(["eq", ...a]); return q; }, or: (...a: unknown[]) => { calls.push(["or", ...a]); return q; } }; return { q, calls }; };

describe("nicepayDiscoveryScope — 심사관 탐색 범위", () => {
  it("심사관이 아니면 null(기존 쿼리 그대로), RPC 를 호출하지 않는다", async () => { access.mockResolvedValue(false); expect(await nicepayDiscoveryScope()).toBeNull(); expect(rpc).not.toHaveBeenCalled(); });
  it("권한 조회가 실패하면 null(기존 동작)", async () => { access.mockRejectedValue(new Error("x")); expect(await nicepayDiscoveryScope()).toBeNull(); });
  it("심사관: DB 의 허용 센터 id 만 사용(UUID 형식 검증·중복 제거)", async () => {
    access.mockResolvedValue(true); rpc.mockResolvedValue({ data: [{ center_id: ID1, can_purchase: false }, { center_id: ID1 }, { center_id: "x); drop table" }, { center_id: ID2 }], error: null });
    expect(await nicepayDiscoveryScope()).toEqual({ extraCenterIds: [ID1, ID2], viewOnlyCenterIds: [ID1, ID2] });   // can_purchase 가 true 가 아니면 조회 전용으로 본다(fail-safe)
  });
  it("RPC 가 없거나(SQL 미적용) 오류면 허용 센터 없음 = 기존 동작(심사 센터만)", async () => {
    access.mockResolvedValue(true); rpc.mockResolvedValue({ data: null, error: { code: "42883" } }); expect(await nicepayDiscoveryScope()).toEqual({ extraCenterIds: [], viewOnlyCenterIds: [] });
    rpc.mockRejectedValue(new Error("net")); expect(await nicepayDiscoveryScope()).toEqual({ extraCenterIds: [], viewOnlyCenterIds: [] });
  });
});

describe("narrowToReviewCenters — 쿼리 좁히기", () => {
  it("허용 센터가 없으면 기존과 같은 eq(is_nicepay_review) (직접·임베드 모두)", () => {
    let b = builder(); narrowToReviewCenters(b.q, { extraCenterIds: [], viewOnlyCenterIds: [] }); expect(b.calls).toEqual([["eq", "is_nicepay_review", true]]);
    b = builder(); narrowToReviewCenters(b.q, { extraCenterIds: [], viewOnlyCenterIds: [] }, "centers"); expect(b.calls).toEqual([["eq", "centers.is_nicepay_review", true]]);
  });
  it("허용 센터가 있으면 id ∈ 허용 센터만(별도 심사 센터는 탐색에서 제외 — 실제 상품으로 심사 경로 구성), 전체 해제가 아니라 허용 목록만", () => {
    let b = builder(); narrowToReviewCenters(b.q, { extraCenterIds: [ID1], viewOnlyCenterIds: [] }); expect(b.calls).toEqual([["or", `id.in.(${ID1})`]]);
    b = builder(); narrowToReviewCenters(b.q, { extraCenterIds: [ID1, ID2], viewOnlyCenterIds: [] }, "centers"); expect(b.calls).toEqual([["or", `id.in.(${ID1},${ID2})`, { referencedTable: "centers" }]]);
  });
});

describe("fetchNicepayViewOnlyCenter — 조회 전용 센터 판정(UI 안내용)", () => {
  it("조회 전용으로 허용된 센터만 true, 구매 허용·미허용·비심사관·형식 오류는 false", async () => {
    access.mockResolvedValue(true); rpc.mockResolvedValue({ data: [{ center_id: ID1, can_purchase: false }, { center_id: ID2, can_purchase: true }], error: null });
    expect(await fetchNicepayViewOnlyCenter(ID1)).toBe(true); expect(await fetchNicepayViewOnlyCenter(ID2)).toBe(false);
    expect(await fetchNicepayViewOnlyCenter("22222222-2222-4222-8222-222222222222")).toBe(false); expect(await fetchNicepayViewOnlyCenter("not-a-uuid")).toBe(false);
    access.mockResolvedValue(false); expect(await fetchNicepayViewOnlyCenter(ID1)).toBe(false);   // 일반 회원: 기존 화면
  });
  it("RPC 실패(SQL 미적용 등)는 false — 기존 화면 그대로", async () => { access.mockResolvedValue(true); rpc.mockResolvedValue({ data: null, error: { code: "42883" } }); expect(await fetchNicepayViewOnlyCenter(ID1)).toBe(false); });
});
