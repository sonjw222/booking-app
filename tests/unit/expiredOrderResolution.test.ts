import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expiredOrderUiState, type ExpiredOrderResolution } from "../../lib/orders";

const read = (p: string) => readFileSync(path.resolve(__dirname, "../..", p), "utf8");
const TODAY = "2026-10-31";
const map = { exp: { expiryMode: "date", expiryDate: "2026-10-28" }, ok: { expiryMode: "date", expiryDate: "2026-10-31" } };
const res = (resolution: ExpiredOrderResolution["resolution"]) => ({ resolution } as ExpiredOrderResolution);

describe("expiredOrderUiState", () => {
  it("만료된 고정일 상품의 pending/paid 주문만 수납 확인 필요", () => {
    expect(expiredOrderUiState({ status: "pending", productId: "exp" }, map, undefined, TODAY)).toBe("needs_confirmation");
    expect(expiredOrderUiState({ status: "paid", productId: "exp" }, map, undefined, TODAY)).toBe("needs_confirmation");
  });
  it("오늘 만료·미만료·일반·상품 정보 없음·완료/취소 주문은 일반 UI 그대로", () => {
    for (const o of [{ status: "pending", productId: "ok" }, { status: "pending", productId: "zzz" }, { status: "pending", productId: null }, { status: "done", productId: "exp" }, { status: "cancelled", productId: "exp" }])
      expect(expiredOrderUiState(o, map, undefined, TODAY)).toBe("normal");
  });
  it("환불 예정은 pending 에서 유지, 이력이 있으면 resolved", () => {
    expect(expiredOrderUiState({ status: "pending", productId: "exp" }, map, res("refund_planned"), TODAY)).toBe("refund_planned");
    expect(expiredOrderUiState({ status: "cancelled", productId: "exp" }, map, res("refund_planned"), TODAY)).toBe("resolved");
    expect(expiredOrderUiState({ status: "cancelled", productId: "exp" }, map, res("unpaid_cancelled"), TODAY)).toBe("resolved");
  });
});

describe("정적 계약", () => {
  it("NICEPAY·기존 PG 결제는 계속 꺼져 있다", () => {
    const f = read("lib/payments/PaymentProviderFactory.ts");
    expect(f).toMatch(/NICEPAY_CHECKOUT_ACTIVATED: boolean = false/);
    expect(f).toMatch(/LEGACY_PG_CHECKOUT_ACTIVATED: boolean = false/);
  });
  it("SQL: 같은 권한 키 사용, 해시 가드, 직접 상품/주문 삭제 없음", () => {
    const s = read("add_expired_order_resolution_20261031.sql");
    expect(s).toContain("b675acdd9c48bba4b4a80891cbba0a76");
    expect(s).toContain("18c4bb13b1b1f812b6dbef882f0ce068");
    expect(s).toContain("pass.payment.create");
    expect(s).toMatch(/enable row level security/i);
    expect(s).not.toMatch(/drop\s+table|truncate/i);
    expect(s).toMatch(/revoke all on function public\.manager_resolve_expired_order/);
  });
  it("화면: 처리 시트·테스트 ID가 /manager/orders 에 연결되어 있다", () => {
    const p = read("app/manager/orders/page.tsx");
    for (const id of ["expired-order-notice", "expired-order-refund-planned", "expired-order-resolve-btn", "expired-order-sheet", "expired-unpaid-cancel", "expired-paid", "expired-unknown", "expired-paid-submit"])
      expect(p).toContain(id);
    const o = read("lib/orders.ts");
    expect(o).toContain('rpc("manager_resolve_expired_order"');
  });
});
