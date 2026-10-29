import { afterEach, describe, expect, it } from "vitest";
import { nicepayGate } from "../../lib/payments/server/nicepay/runtime";
import type { SupabaseClient } from "@supabase/supabase-js";

/* 앱 쪽 선검사(nicepayGate): DB 게이트 모드 + 노출 정책. 가짜 admin 클라이언트만 쓴다(네트워크 없음). */
type Opts = { rpcError?: boolean; override?: boolean; tossOverride?: boolean; target?: "ok" | "notReviewCenter" | "internal" | "notApproved" | "offSale" | "inactive" | "otherCenterProduct" | "lookupError" };
const admin = (mode: unknown, opts: Opts = {}) => {
  const t = opts.target ?? "ok";
  const rows: Record<string, unknown> = {
    orders: { center_id: "c1", product_id: "p1", profiles: { accounts: { nicepay_review_access: !!opts.override, pg_checkout_override: !!opts.tossOverride } } },
    centers: { is_nicepay_review: t !== "notReviewCenter", status: t === "notApproved" ? "pending" : "approved", is_internal: t === "internal" },
    products: { center_id: t === "otherCenterProduct" ? "c2" : "c1", is_active: t !== "inactive", is_on_sale: t !== "offSale" },
  };
  return {
    rpc: async () => (opts.rpcError ? { data: null, error: { message: "function does not exist" } } : { data: mode, error: null }),
    from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (t === "lookupError" && table !== "orders" ? { data: null, error: { message: "boom" } } : { data: rows[table], error: null }) }) }) }),
  } as unknown as SupabaseClient;
};

const ENV = process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED;
afterEach(() => { if (ENV === undefined) delete process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED; else process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = ENV; });

describe("nicepayGate — DB 모드와 노출 정책의 일치", () => {
  it("off / 알 수 없는 값 / RPC 오류(게이트 미설치)는 항상 거부(fail-closed) — 심사 계정이어도, 공개 플래그가 켜져 있어도", async () => {
    process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = "true";
    for (const a of [admin("off", { override: true }), admin("weird", { override: true }), admin(null, { override: true }), admin(undefined, { rpcError: true, override: true })]) expect(await nicepayGate(a)("o1")).toBe(false);
  });
  it("reviewer: 심사 계정만 통과(공개 플래그가 켜져 있어도 일반 회원은 거부)", async () => {
    process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = "true";
    expect(await nicepayGate(admin("reviewer", { override: true }))("o1")).toBe(true);
    expect(await nicepayGate(admin("reviewer", { override: false }))("o1")).toBe(false);
  });
  it("B안: 토스 심사 계정(pg_checkout_override 만 true)은 NICEPAY 게이트를 통과하지 못한다 — reviewer·public(공개 플래그 꺼짐) 모두", async () => {
    process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = "false";
    expect(await nicepayGate(admin("reviewer", { override: false, tossOverride: true }))("o1")).toBe(false);
    expect(await nicepayGate(admin("public", { override: false, tossOverride: true }))("o1")).toBe(false);
    expect(await nicepayGate(admin("reviewer", { override: true, tossOverride: false }))("o1")).toBe(true);
  });
  it("public: 공개 플래그가 켜져 있으면 일반 회원 통과, 꺼져 있으면 심사 계정만", async () => {
    process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = "true";
    expect(await nicepayGate(admin("public", { override: false }))("o1")).toBe(true);
    process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = "false";
    expect(await nicepayGate(admin("public", { override: false }))("o1")).toBe(false);
    expect(await nicepayGate(admin("public", { override: true }))("o1")).toBe(true);
  });
  it("심사관이어도 주문의 센터·상품이 심사 대상(승인·공개 심사 센터의 판매 중 상품)이 아니면 거부 — 비심사 센터·내부·비승인·판매 중지·비활성·다른 센터 상품·조회 오류 모두, reviewer 모드와 public(공개 플래그 꺼짐) 모두", async () => {
    for (const flag of ["false", "true"]) {
      process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = flag;
      for (const target of ["notReviewCenter", "internal", "notApproved", "offSale", "inactive", "otherCenterProduct", "lookupError"] as const)
        expect(await nicepayGate(admin("reviewer", { override: true, target }))("o1"), `reviewer/${flag}/${target}`).toBe(false);
      expect(await nicepayGate(admin("reviewer", { override: true, target: "ok" }))("o1")).toBe(true);
    }
    process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = "false";
    expect(await nicepayGate(admin("public", { override: true, target: "offSale" }))("o1")).toBe(false);
    process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED = "true";
    expect(await nicepayGate(admin("public", { override: false, target: "offSale" }))("o1")).toBe(true);   // 공개 모드는 대상 제한 없음(기존 동작) — 일반 회원 공개는 별도 승인 사항
  });
});
