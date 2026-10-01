/*
  비로그인(anon) 상품 조회 권한 계약(2026-10-02, production에서 확인된 회귀):
  fetch_purchasable_products를 anon에서만 revoke하면 PostgreSQL 기본 PUBLIC EXECUTE로 anon이 계속 실행할 수 있었다.
  → 회원용 RPC는 PUBLIC과 anon을 모두 회수하고 authenticated/service_role만 허용, 공개 storefront RPC만 anon 허용.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const member = noComments(read("add_membership_visibility_and_coupons.sql"));
const pub = noComments(read("add_public_storefront_products.sql"));

describe("fetch_purchasable_products — 회원 전용(authenticated)", () => {
  it("PUBLIC과 anon을 함께 revoke한다(anon만 revoke하는 옛 형태 금지)", () => {
    expect(member).toContain("revoke all on function public.fetch_purchasable_products(uuid) from public, anon;");
    expect(member).not.toMatch(/revoke execute on function fetch_purchasable_products\(uuid\) from anon;/);
  });
  it("authenticated와 service_role에만 execute를 grant한다(anon grant 없음)", () => {
    expect(member).toContain("grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;");
    expect(member).not.toMatch(/grant execute on function (public\.)?fetch_purchasable_products\(uuid\)[^;]*\banon\b/);
  });
  it("revoke가 grant보다 먼저다", () => {
    expect(member.indexOf("revoke all on function public.fetch_purchasable_products")).toBeLessThan(
      member.indexOf("grant execute on function public.fetch_purchasable_products"));
  });
});

describe("fetch_public_storefront_products — anon 허용은 이것 하나", () => {
  it("PUBLIC revoke 후 anon, authenticated에 grant", () => {
    expect(pub).toContain("revoke all on function fetch_public_storefront_products(uuid) from public;");
    expect(pub).toContain("grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;");
  });
  it("같은 파일의 멱등 보강도 회원용 RPC를 anon에서 계속 막는다", () => {
    expect(pub).toContain("revoke all on function public.fetch_purchasable_products(uuid) from public, anon;");
    expect(pub).toContain("grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;");
    expect(pub).not.toMatch(/grant execute on function (public\.)?fetch_purchasable_products\(uuid\)[^;]*\banon\b/);
  });
  it("확인 SELECT가 두 권한을 모두 검증한다", () => {
    expect(pub).toContain("has_function_privilege('anon', 'fetch_public_storefront_products(uuid)', 'execute')");
    expect(pub).toContain("has_function_privilege('anon', 'fetch_purchasable_products(uuid)', 'execute')");
  });
  it("등급/지정 회원 전용 상품은 공개 경로에 나오지 않는다(visibility_type='all'만, 관련 컬럼/테이블 비참조)", () => {
    expect(pub).toContain("p.visibility_type = 'all'");
    expect(pub).not.toMatch(/selected_members|membership_product_members|membership_product_grades/);
  });
  it("앱 코드: 비로그인은 공개 RPC, 회원 RPC는 로그인 경로에서만 호출", () => {
    const center = read("lib/center.ts");
    expect(center).toMatch(/"fetch_public_storefront_products",/);
    expect(center).toContain('.rpc("fetch_purchasable_products", { p_center_id: centerId })');
  });
});
