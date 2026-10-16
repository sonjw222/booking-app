// @vitest-environment node
/* NICEPAY DB 어댑터가 SQL 초안의 함수명·인자명과 일치하는지(정적+가짜 rpc) 확인. DB 접속 없음. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { nicepayDbDeps } from "../../lib/payments/server/nicepay/db";

const sql = readFileSync("add_nicepay_provider_support_20261016.sql", "utf8");
describe("nicepayDbDeps ↔ add_nicepay_provider_support_20261016.sql", () => {
  it("모든 rpc 이름과 인자명이 SQL 함수 정의에 존재한다", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const admin = { rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: fn === "nicepay_claim_order" ? "claim-1" : null, error: null }; }) };
    const d = nicepayDbDeps(admin);
    await d.orderContext("o"); expect(await d.claimOrder("o")).toBe("claim-1"); await d.releaseOrder("o", "c"); await d.markReview("o", "c", "netcancel_failed"); await d.dbConfirm("o", "c", "t", 1000);
    expect(calls.map((c) => c.fn)).toEqual(["nicepay_order_context", "nicepay_claim_order", "nicepay_release_order", "nicepay_mark_review", "confirm_nicepay_payment"]);
    for (const c of calls) {
      const def = sql.slice(sql.indexOf(`function ${c.fn}(`), sql.indexOf("$$;", sql.indexOf(`function ${c.fn}(`)));
      expect(def, c.fn).not.toBe("");
      const sig = def.slice(0, def.indexOf(")"));
      for (const arg of Object.keys(c.args)) expect(sig, `${c.fn}.${arg}`).toContain(arg);
    }
  });
  it("claim이 null/빈 값이면 null(선점 실패), DB 오류는 throw, confirm 오류는 값으로 반환", async () => {
    expect(await nicepayDbDeps({ rpc: async () => ({ data: null, error: null }) }).claimOrder("o")).toBeNull();
    await expect(nicepayDbDeps({ rpc: async () => ({ data: null, error: { message: "x" } }) }).claimOrder("o")).rejects.toThrow("x");
    expect((await nicepayDbDeps({ rpc: async () => ({ data: null, error: { message: "dup" } }) }).dbConfirm("o", "c", "t", 1)).error).toEqual({ message: "dup" });
  });
  it("SQL 초안: 모든 새 RPC는 service_role에만 grant, confirm_real_payment/cancel_real_payment는 수정하지 않는다", () => {
    const code = sql.replace(/^\s*--.*$/gm, "");
    for (const f of ["nicepay_order_context", "nicepay_claim_order", "nicepay_release_order", "nicepay_mark_review", "nicepay_expire_stale_claims", "nicepay_resolve_review", "confirm_nicepay_payment"]) {
      expect(code, f).toMatch(new RegExp(`grant execute on function ${f}\\([^)]*\\) to service_role;`));
      expect(code, f).toMatch(new RegExp(`revoke all on function ${f}\\([^)]*\\) from public, anon, authenticated;`));
    }
    expect(code).not.toMatch(/function confirm_real_payment|function cancel_real_payment|function _issue_membership_and_record_payment/);
    expect(code).not.toMatch(/drop table|truncate|delete from|update orders set payment_provider/i);
  });
});
