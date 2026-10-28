import { afterEach, describe, expect, it } from "vitest";
import { nicepayGate } from "../../lib/payments/server/nicepay/runtime";
import type { SupabaseClient } from "@supabase/supabase-js";

/* 앱 쪽 선검사(nicepayGate): DB 게이트 모드 + 노출 정책. 가짜 admin 클라이언트만 쓴다(네트워크 없음). */
const admin = (mode: unknown, opts: { rpcError?: boolean; override?: boolean; tossOverride?: boolean } = {}) => ({
  rpc: async () => (opts.rpcError ? { data: null, error: { message: "function does not exist" } } : { data: mode, error: null }),
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { profiles: { accounts: { nicepay_review_access: !!opts.override, pg_checkout_override: !!opts.tossOverride } } } }) }) }) }),
}) as unknown as SupabaseClient;

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
});
