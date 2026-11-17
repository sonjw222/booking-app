import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ rows: [] as unknown[], scope: null as null | { extraCenterIds: string[]; viewOnlyCenterIds: string[] }, rpcArgs: [] as unknown[] }));
vi.mock("../../lib/supabaseClient", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) }, rpc: vi.fn(async (name: string, args: unknown) => { h.rpcArgs.push([name, args]); return { data: name === "fetch_public_storefront_products" ? h.rows : [], error: null }; }) } }));
vi.mock("../../lib/nicepayReviewScope", () => ({ nicepayDiscoveryScope: vi.fn(async () => h.scope) }));
import { fetchPublicStorefrontProducts } from "../../lib/center";
const row = (id: string, center: string) => ({ id, center_id: center, center_name: center, name: id, price: 1000, product_kind: "pass" });
beforeEach(() => { h.rows = [row("p-review", "C-REVIEW"), row("p-real", "C-REAL"), row("p-other", "C-OTHER")]; h.scope = null; h.rpcArgs = []; });
describe("/products 전체 목록의 NICEPAY 심사 범위", () => {
  it("심사관 + 허용 센터가 있으면 허용 센터 상품만(별도 심사 센터 상품 제외)", async () => {
    h.scope = { extraCenterIds: ["C-REAL"], viewOnlyCenterIds: ["C-REAL"] };
    expect((await fetchPublicStorefrontProducts()).map((p) => p.id)).toEqual(["p-real"]);
  });
  it("일반 회원·비로그인(scope null)은 서버가 준 목록 그대로", async () => {
    expect((await fetchPublicStorefrontProducts()).map((p) => p.id)).toEqual(["p-review", "p-real", "p-other"]);
  });
  it("심사관이지만 허용 센터가 없으면(기존 동작) 서버 목록 그대로 — 서버(RLS·RPC)가 심사 센터만 준다", async () => {
    h.scope = { extraCenterIds: [], viewOnlyCenterIds: [] };
    expect((await fetchPublicStorefrontProducts()).map((p) => p.id)).toEqual(["p-review", "p-real", "p-other"]);
  });
  it("센터를 지정한 조회(센터 화면)는 범위 조회를 하지 않는다", async () => {
    h.scope = { extraCenterIds: ["C-REAL"], viewOnlyCenterIds: [] };
    expect((await fetchPublicStorefrontProducts("C-REVIEW")).length).toBe(3);
  });
});

describe("fetchPublicStorefrontProducts 행 매핑(any 제거 후에도 동일)", () => {
  it("snake_case 응답을 PublicStorefrontProduct 로 매핑하고 누락 값은 안전한 기본값", async () => {
    h.rows = [{ id: "p1", center_id: "c1", center_name: "센터", name: "수강권", price: 5000, product_kind: "goods", total_count: 3, purchase_count_selectable: true, min_purchase_count: 1, max_purchase_count: 12, min_tier_price: 4000 }, { id: "p2", center_id: "c1", center_name: "센터", name: "기본", price: 1000 }];
    const r = await fetchPublicStorefrontProducts();
    expect(r[0]).toMatchObject({ id: "p1", centerId: "c1", kind: "goods", totalCount: 3, countSelectable: true, minCount: 1, maxCount: 12, minTierPrice: 4000 });
    expect(r[1]).toMatchObject({ kind: "pass", totalCount: null, unlimited: false, unlimitedPass: false, remaining: null, countSelectable: false, groupLabel: null, description: null });
  });
});
