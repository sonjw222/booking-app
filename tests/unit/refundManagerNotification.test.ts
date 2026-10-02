/*
  환불 완료 / 결제 전 주문 취소 관리자 알림(2026-10-02) — SQL 계약 + 클라이언트 경로. 실제 PostgreSQL 동작은 tests/sql/*.test.mjs(PGlite)가 검증한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const sql = read("fix_refund_manager_notification_20261002.sql").replace(/--.*$/gm, "");

const rpc = vi.fn(); const upd = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({ update: (p: unknown) => ({ eq: () => ({ select: async () => { upd(p); return { data: [{ id: "o" }], error: null }; } }) }) }),
  },
}));
vi.mock("../../lib/authAccount", () => ({ getMyAccountId: async () => "a" }));
import { cancelMyOrderFromPurchases } from "../../lib/orders";
import { notiEmoji, notificationHref } from "../../lib/notifications";

describe("SQL 계약", () => {
  it("기존 환불/주문 함수를 재정의하지 않고 신규 객체만 추가한다", () => {
    expect(sql).not.toMatch(/create or replace function (public\.)?(_refund_membership_core|fulfill_order|refund_membership|cancel_real_payment|use_points)\(/i);
    expect(sql).toContain("begin;");
    expect(sql).toContain("commit;");
  });
  it("환불: status가 refunded로 바뀔 때만 deferred constraint trigger, 마커 PK로 중복 방지, 알림 실패는 서브트랜잭션으로 격리", () => {
    expect(sql).toContain("create constraint trigger trg_refund_completed_managers");
    expect(sql).toContain("deferrable initially deferred");
    expect(sql).toContain("when (old.status is distinct from new.status and new.status = 'refunded')");
    expect(sql).toContain("membership_id uuid primary key references public.memberships(id) on delete cascade");
    expect(sql).toContain("on conflict (membership_id) do nothing");
    expect(sql).toContain("exception when others then");
  });
  it("대상: active manager_centers만(distinct account), 해당 센터 링크, 상품/금액 포함·개인정보(회원명) 미포함", () => {
    expect(sql).toContain("where center_id = v_mem.center_id and status = 'active'");
    expect(sql).toContain("'/manager/sales?center=' || v_mem.center_id::text");
    expect(sql).toContain("'/manager/orders?center=' || v_order.center_id::text");
    expect(sql).not.toMatch(/profiles|name_snapshot|phone/i);
  });
  it("주문 취소는 상태 트리거가 아니라 회원 버튼 전용 RPC(본인 주문·행 잠금·이미 취소면 알림 없음·done 거부), 문구는 환불 아님", () => {
    expect(sql).not.toMatch(/create (constraint )?trigger trg_order_cancelled/i);
    expect(sql).toContain("profile_id in (select my_profile_ids())");
    expect(sql).toContain("for update;");
    expect(sql).toContain("'already', true");
    expect(sql).toContain("if v_order.status not in ('pending', 'paid') then");
    expect(sql).toContain("발급 전 주문 취소(환불 아님)");
    expect(sql).toContain("'결제 전 주문이 취소됐어요'");
  });
  it("권한: 마커 테이블 RLS+revoke, 트리거 함수 revoke all, RPC는 anon 차단·authenticated 허용, search_path 고정", () => {
    expect(sql).toContain("revoke all on public.refund_notification_events from public, anon, authenticated;");
    expect(sql).toContain("revoke all on function public.notify_refund_completed_managers() from public, anon, authenticated;");
    expect(sql).toContain("revoke all on function public.member_cancel_pending_order(uuid) from public, anon;");
    expect(sql).toContain("grant execute on function public.member_cancel_pending_order(uuid) to authenticated, service_role;");
    expect((sql.match(/set search_path = public/g) ?? []).length).toBe(2);
  });
  it("rollback 파일과 PGlite 격리 테스트가 존재", () => {
    expect(read("rollback_fix_refund_manager_notification_20261002.sql")).toContain("drop table if exists public.refund_notification_events;");
    expect(read("tests/sql/refund-manager-notification.test.mjs")).toContain("PGlite");
  });
});

describe("클라이언트", () => {
  beforeEach(() => { rpc.mockReset(); upd.mockReset(); });
  it("구매내역 취소 버튼은 RPC를 쓰고, RPC 미적용(PGRST202)이면 기존 직접 취소로 대체, 그 외 오류는 그대로 표시", async () => {
    rpc.mockResolvedValueOnce({ error: null });
    await cancelMyOrderFromPurchases("o1");
    expect(rpc).toHaveBeenCalledWith("member_cancel_pending_order", { p_order_id: "o1" });
    expect(upd).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({ error: { code: "PGRST202", message: "x" } });
    await cancelMyOrderFromPurchases("o1");
    expect(upd).toHaveBeenCalledWith({ status: "cancelled" });
    rpc.mockResolvedValueOnce({ error: { code: "P0001", message: "P0001: 이미 발급·처리된 주문은 취소할 수 없어요" } });
    await expect(cancelMyOrderFromPurchases("o1")).rejects.toThrow("이미 발급·처리된 주문은 취소할 수 없어요");
  });
  it("버튼 경로만 RPC, 자동 정리/보상 취소/관리자 취소는 기존 경로(알림 없음)", () => {
    expect(read("app/purchases/page.tsx")).toContain("cancelMyOrderFromPurchases(it.orderId)");
    expect(read("lib/orders.ts")).toContain('.from("orders").update({ status: "cancelled" }).eq("id", orderId).eq("status", "pending")');   // cancelMyPendingOrderQuietly
    expect(read("app/manager/orders/page.tsx")).toContain('updateOrderStatus(o.id, "cancelled")');
  });
  it("알림 kind: 아이콘/이모지/링크(?center) 처리, 관리자 주문·매출 화면이 center 쿼리를 존중", () => {
    expect(notiEmoji("order_cancelled")).toBe("❌");
    expect(notiEmoji("refund_completed")).toBe("↩️");
    expect(notificationHref({ kind: "refund_completed", link: "/manager/sales?center=c1", data: null })).toBe("/manager/sales?center=c1");
    expect(read("app/manager/notifications/page.tsx")).toContain('kind.includes("refund")');
    for (const f of ["app/manager/orders/page.tsx", "app/manager/sales/page.tsx"]) expect(read(f)).toContain('new URLSearchParams(window.location.search).get("center")');
    // 팝업은 notiPrefKeyForKind가 null인 kind를 항상 표시(설정으로 끌 수 없는 매니저 알림)
    expect(read("lib/notifications.ts")).toContain("default:\n      return null;");
  });
  it("lifecycle/환불 코드는 이번 변경에서 수정하지 않았다", () => {
    expect(read("lib/payments/server/lifecycle.ts")).toContain("portone_refund_unsupported");
  });
});
