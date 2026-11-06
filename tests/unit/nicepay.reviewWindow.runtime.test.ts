import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reviewReadPort } from "../../lib/payments/server/nicepay/reviewWindowRuntime";
import { REVIEW_CENTER, REVIEW_EMAIL, REVIEW_UID } from "../../lib/payments/server/nicepay/reviewWindow";
const PRODUCT="33333333-3333-4333-8333-333333333333";
function fixture(){
 const user={id:REVIEW_UID,email:REVIEW_EMAIL,email_confirmed_at:"2026-10-30"};
 const rows:Record<string,Record<string,unknown>|null>={accounts:{nicepay_review_access:true,is_member:true,deactivated_at:null,merged_into:null},centers:{is_nicepay_review:true,is_internal:false,status:"approved"},products:{id:PRODUCT,center_id:REVIEW_CENTER,name:"상품",price:1000,is_active:true,is_on_sale:true}};
 const filters:unknown[]=[];
 const admin={auth:{getUser:vi.fn(async()=>({data:{user},error:null})),admin:{getUserById:vi.fn(async()=>({data:{user},error:null}))}},from:vi.fn((table:string)=>({select:vi.fn(()=>({eq:vi.fn((key:string,value:string)=>{filters.push([table,key,value]);return {maybeSingle:vi.fn(async()=>({data:rows[table],error:null}))}})}))}))};
 return {user,rows,filters,admin,port:reviewReadPort(admin as unknown as SupabaseClient)};
}
describe("review scope read adapter",()=>{
 it("allows only the confirmed pinned email/UID and pins all table filters",async()=>{
  const f=fixture();expect(await f.port.authenticatedUid("jwt")).toBe(REVIEW_UID);expect(await f.port.target(REVIEW_UID,PRODUCT)).toEqual({productId:PRODUCT,name:"상품",amount:1000});
  expect(f.filters).toEqual([["accounts","auth_id",REVIEW_UID],["centers","id",REVIEW_CENTER],["products","id",PRODUCT]]);
  expect(await f.port.target("other",PRODUCT)).toBeNull();
  f.user.email="other@test.invalid";expect(await f.port.authenticatedUid("jwt")).toBeNull();expect(await f.port.target(REVIEW_UID,PRODUCT)).toBeNull();
 });
 it.each([
  ["accounts","nicepay_review_access",false],["accounts","is_member",false],["accounts","deactivated_at","now"],["accounts","merged_into","other"],
  ["centers","is_nicepay_review",false],["centers","is_internal",true],["centers","status","pending"],
  ["products","center_id","other"],["products","id","other"],["products","is_active",false],["products","is_on_sale",false],["products","price",0],
 ])("rejects %s.%s=%s",async(table,key,value)=>{const f=fixture();f.rows[String(table)]![String(key)]=value;expect(await f.port.target(REVIEW_UID,PRODUCT)).toBeNull();});
 it("fails closed on missing rows and unconfirmed users",async()=>{const f=fixture();f.rows.accounts=null;expect(await f.port.target(REVIEW_UID,PRODUCT)).toBeNull();f.user.email_confirmed_at="";expect(await f.port.authenticatedUid("jwt")).toBeNull();});
});

// ── 심사관에게 허용된 실제 센터(nicepay_review_center_grants) 상품의 인증창 확인 대상 판정 ──
const REAL_CENTER = "8965e09c-0d2b-44c6-ab26-40a85507f8b5", REAL_PRODUCT = "44444444-4444-4444-8444-444444444444", ACC_ID = "55555555-5555-4555-8555-555555555555";
function realFixture(over: Record<string, Record<string, unknown> | null | "throw"> = {}) {
  const user = { id: REVIEW_UID, email: REVIEW_EMAIL, email_confirmed_at: "2026-10-30" };
  const rows: Record<string, Record<string, unknown> | null | "throw"> = {
    accounts: { id: ACC_ID, nicepay_review_access: true, is_member: true, deactivated_at: null, merged_into: null },
    centers_review: { is_nicepay_review: true, is_internal: false, status: "approved" },
    centers_real: { is_nicepay_review: false, is_internal: false, status: "approved" },
    products: { id: REAL_PRODUCT, center_id: REAL_CENTER, name: "11월 수강권", price: 80000, is_active: true, is_on_sale: true, expiry_mode: "date", expiry_date: "2099-11-28" },
    nicepay_review_center_grants: { center_id: REAL_CENTER },
    ...over,
  };
  const eqLog: unknown[] = [];
  const admin = {
    auth: { admin: { getUserById: vi.fn(async () => ({ data: { user }, error: null })) }, getUser: vi.fn(async () => ({ data: { user }, error: null })) },
    from: vi.fn((table: string) => ({ select: vi.fn(() => { const f: Record<string, unknown> = {};
      const chain = { eq: vi.fn((k: string, v: unknown) => { f[k] = v; eqLog.push([table, k, v]); return chain; }),
        maybeSingle: vi.fn(async () => {
          const key = table === "centers" ? (f.id === REVIEW_CENTER ? "centers_review" : "centers_real") : table;
          const row = rows[key];
          if (row === "throw") throw new Error("relation does not exist");
          if (table === "nicepay_review_center_grants" && row && (f.account_id !== ACC_ID || f.center_id !== (row as { center_id: string }).center_id)) return { data: null, error: null };
          return { data: row ?? null, error: null };
        }) };
      return chain; }) })),
  };
  return { rows, eqLog, port: reviewReadPort(admin as unknown as SupabaseClient) };
}
describe("허용된 실제 센터 상품 — 인증창 확인 대상", () => {
  it("허용 행·승인된 비내부 센터·판매 중 상품이면 대상이다(센터 id 포함, 허용 조회는 계정 id + 센터 id 로 한정)", async () => {
    const f = realFixture();
    expect(await f.port.target(REVIEW_UID, REAL_PRODUCT)).toEqual({ productId: REAL_PRODUCT, name: "11월 수강권", amount: 80000, centerId: REAL_CENTER });
    expect(f.eqLog).toContainEqual(["nicepay_review_center_grants", "account_id", ACC_ID]); expect(f.eqLog).toContainEqual(["nicepay_review_center_grants", "center_id", REAL_CENTER]);
  });
  it("허용 행이 없거나 허용 테이블이 없으면(SQL 적용 전) 거부 — 기존 심사 센터 동작만 유지", async () => {
    expect(await realFixture({ nicepay_review_center_grants: null }).port.target(REVIEW_UID, REAL_PRODUCT)).toBeNull();
    expect(await realFixture({ nicepay_review_center_grants: "throw" }).port.target(REVIEW_UID, REAL_PRODUCT)).toBeNull();
  });
  it.each([
    ["centers_real", "status", "pending"], ["centers_real", "is_internal", true], ["centers_real", "is_nicepay_review", true],
    ["products", "is_active", false], ["products", "is_on_sale", false], ["products", "price", 0], ["products", "expiry_date", "2020-01-01"],
    ["accounts", "nicepay_review_access", false], ["accounts", "deactivated_at", "now"],
  ])("거부: %s.%s=%s", async (table, key, value) => {
    const f = realFixture(); (f.rows[table] as Record<string, unknown>)[key] = value;
    expect(await f.port.target(REVIEW_UID, REAL_PRODUCT)).toBeNull();
  });
  it("다른 센터의 상품(허용되지 않은 센터)은 거부", async () => {
    const f = realFixture(); (f.rows.products as Record<string, unknown>).center_id = "66666666-6666-4666-8666-666666666666";
    expect(await f.port.target(REVIEW_UID, REAL_PRODUCT)).toBeNull();
  });
  it("지정 UID 가 아니면 거부", async () => { expect(await realFixture().port.target("77777777-7777-4777-8777-777777777777", REAL_PRODUCT)).toBeNull(); });
});
