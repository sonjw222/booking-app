/*
  환불 완료 / 결제 전 주문 취소 관리자 알림(2026-10-02) — SQL 계약 + 클라이언트 경로. 실제 PostgreSQL 동작은 tests/sql/*.test.mjs(PGlite)가 검증한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const sql = read("fix_refund_manager_notification_20261002.sql").replace(/--.*$/gm, "");

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
    expect(sql).not.toMatch(/profiles|name_snapshot|phone/i);
  });
  it("이번 migration에는 주문 취소 알림/RPC가 없다(범위 밖)", () => {
    expect(sql).not.toMatch(/member_cancel_pending_order|order_cancelled|on public\.orders|create trigger trg_order/i);
  });
  it("권한: 마커 테이블 RLS+revoke, 트리거 함수 revoke all, RPC는 anon 차단·authenticated 허용, search_path 고정", () => {
    expect(sql).toContain("revoke all on public.refund_notification_events from public, anon, authenticated;");
    expect(sql).toContain("revoke all on function public.notify_refund_completed_managers() from public, anon, authenticated;");
    expect((sql.match(/set search_path = public/g) ?? []).length).toBe(1);
  });
  it("rollback 파일과 PGlite 격리 테스트가 존재", () => {
    expect(read("rollback_fix_refund_manager_notification_20261002.sql")).toContain("drop table if exists public.refund_notification_events;");
    expect(read("tests/sql/refund-manager-notification.test.mjs")).toContain("PGlite");
  });
});

describe("push_notification 권한 감사(저장소 전체)", () => {
  it("정확한 시그니처에서 public/anon/authenticated EXECUTE만 회수(service_role/소유자는 유지)", () => {
    expect(sql).toContain("revoke all on function public.push_notification(uuid, text, text, text, uuid, text, jsonb) from public, anon, authenticated;");
    expect(sql).not.toMatch(/revoke[^;]*service_role/i);
  });
  it("클라이언트/edge function에서 push_notification을 rpc로 직접 호출하는 코드가 없다", () => {
    const { execSync } = require("node:child_process");
    const out = execSync(`grep -rnE "rpc\\([^)]*push_notification" app lib supabase --include='*.ts' --include='*.tsx' || true`, { cwd: join(__dirname, "../.."), encoding: "utf-8" });
    expect(out.trim()).toBe("");
  });
});

describe("클라이언트/알림 표시", () => {
  it("refund_completed: 이모지/아이콘/링크(?center) 처리, 매출 화면이 center 쿼리를 존중, 설정으로 끌 수 없는 kind", () => {
    expect(notiEmoji("refund_completed")).toBe("↩️");
    expect(notificationHref({ kind: "refund_completed", link: "/manager/sales?center=c1", data: null })).toBe("/manager/sales?center=c1");
    expect(read("app/manager/notifications/page.tsx")).toContain('kind.includes("refund")');
    expect(read("app/manager/sales/page.tsx")).toContain('new URLSearchParams(window.location.search).get("center")');
    expect(read("lib/notifications.ts")).toContain("default:\n      return null;");
  });
  it("주문 취소 관련 클라이언트 변경은 없다(lib/orders.ts, purchases, manager/orders는 기준과 동일)", () => {
    const { execSync } = require("node:child_process");
    const diff = execSync("git diff e6f7f4d --name-only -- lib/orders.ts app/purchases/page.tsx app/manager/orders/page.tsx", { cwd: join(__dirname, "../.."), encoding: "utf-8" });
    expect(diff.trim()).toBe("");
    expect(read("lib/notifications.ts")).not.toContain("order_cancelled");
  });
  it("OS 푸시: 별도 코드를 추가하지 않았고, 기존 send-web-push가 kind 필터 없이 pushed_at IS NULL 행을 처리하므로 refund_completed도 기존 큐의 대상이다", () => {
    const f = read("supabase/functions/send-web-push/index.ts");
    expect(f).toContain("pushed_at");
    expect(f).not.toMatch(/\.in\(\s*["']kind["']|\.eq\(\s*["']kind["']/);
    expect(sql).not.toMatch(/fcm|web_push|send-web-push/i);
  });
  it("lifecycle/환불 코드는 수정하지 않았다", () => {
    expect(read("lib/payments/server/lifecycle.ts")).toContain("portone_refund_unsupported");
  });
});
