/*
  주문 포인트 생명주기(2026-10-02, fix_order_point_lifecycle.sql) — SQL 소스 계약 + 클라이언트 정리 경로 + QA 시나리오 격리.
  DB 없이 주석 제거한 소스 텍스트로 확인한다(프로젝트 관례). 실제 DB 동작은 npm run qa:production:points(별도 승인)로 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const raw = read("fix_order_point_lifecycle.sql");
const sql = noComments(raw);
const rollback = noComments(read("rollback_fix_order_point_lifecycle.sql"));

// create or replace function <name>( ... 다음 "$$;" 또는 "$function$;" 까지
function fn(text: string, name: string): string {
  const start = text.search(new RegExp(`create or replace function (public\\.)?${name}\\(`, "i"));
  expect(start, `${name} 정의`).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const m = rest.match(/\$function\$;|\n\$\$;/);
  return rest.slice(0, (m?.index ?? rest.length) + (m?.[0].length ?? 0));
}

describe("원장 스키마 — append-only + 정확히 1회", () => {
  it("point_transactions에 nullable reverses_id만 추가(기존 컬럼/행 변경 없음)", () => {
    expect(sql).toContain("alter table point_transactions add column if not exists reverses_id uuid references point_transactions(id);");
    expect(sql).not.toMatch(/reverses_id uuid not null/);
    expect(sql).not.toMatch(/(update|delete from)\s+point_transactions/i);
    expect(sql).not.toMatch(/drop (table|column)/i);
  });
  it("복원 idempotency: 차감 행 1개당 복원 행 1개를 DB unique 인덱스가 최종 방어", () => {
    expect(sql).toContain("create unique index if not exists uq_point_tx_reverses_id");
    expect(sql).toContain("on point_transactions (reverses_id) where reverses_id is not null;");
  });
  it("차감 idempotency: 주문당 '결제 시 사용' 차감 1행 unique + use_points 사전 확인", () => {
    expect(sql).toContain("on point_transactions (order_id) where order_id is not null and reason = '결제 시 사용' and amount < 0;");
  });
});

describe("_restore_order_points 헬퍼", () => {
  const h = fn(sql, "_restore_order_points");
  it("주문 행 잠금 + 실제 원장(차감 행)을 읽어 같은 금액을 양수로 새 행 추가(orders.points_used 불신)", () => {
    expect(h).toContain("perform 1 from orders where id = p_order_id for update");
    expect(h).toContain("from point_transactions");
    expect(h).toContain("reason = '결제 시 사용'");
    expect(h).toContain("amount < 0");
    expect(h).toContain("-v_row.amount");
    expect(h).not.toContain("points_used");
  });
  it("복원은 INSERT only + ON CONFLICT(reverses_id) DO NOTHING — 기존 차감 행 UPDATE/DELETE 없음, 이미 복원됐으면 0 반환", () => {
    expect(h).toContain("insert into point_transactions (profile_id, center_id, amount, reason, order_id, reverses_id)");
    expect(h).toContain("on conflict (reverses_id) where reverses_id is not null do nothing");
    expect(h).not.toMatch(/\bupdate\s+point_transactions|\bdelete\s+from/i);
    expect(h).toContain("if v_inserted > 0 then");
  });
  it("행 단위로 자기 주문(order_id)만 처리 — 다른 주문 포인트를 건드리지 않는다", () => {
    expect(h).toContain("where order_id = p_order_id");
    expect(h).toContain("v_row.profile_id, v_row.center_id");
  });
  it("SECURITY DEFINER + search_path 고정, PUBLIC/anon/authenticated 실행 차단(내부 헬퍼)", () => {
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = public");
    expect(sql).toContain("revoke all on function _restore_order_points(uuid, text) from public, anon, authenticated;");
    expect(sql).not.toMatch(/grant execute on function _restore_order_points/);
  });
});

describe("취소 경로 — 어느 진입점이든 같은 트랜잭션에서 복원", () => {
  it("orders.status가 cancelled로 바뀌는 순간 트리거가 헬퍼 호출(회원 UPDATE/관리자 UPDATE/cancel_real_payment 공통)", () => {
    const t = fn(sql, "orders_restore_points_on_cancel");
    expect(t).toContain("new.status = 'cancelled' and old.status is distinct from 'cancelled'");
    expect(t).toContain("perform _restore_order_points(new.id, '주문 취소 포인트 복원');");
    expect(sql).toContain("after update of status on orders");
    expect(sql).toContain("revoke all on function orders_restore_points_on_cancel() from public, anon, authenticated;");
  });
  it("클라이언트에 2단계 복원 호출이 없다(restore RPC를 부르는 코드 없음)", () => {
    for (const f of ["lib/orders.ts", "lib/reviews.ts", "app/purchases/page.tsx", "app/manager/orders/page.tsx", "app/checkout/page.tsx", "app/checkout/fail/page.tsx"]) {
      expect(read(f)).not.toMatch(/restore_order_points|_restore_order/);
    }
    expect(read("lib/orders.ts")).toContain('.from("orders").update({ status: "cancelled" }).eq("id", orderId).eq("status", "pending")');
  });
  it("상태 전이 가드: cancelled는 종료 상태, done은 변경 불가(환불은 refund_membership)", () => {
    const g = fn(sql, "orders_guard_status_transition");
    expect(g).toContain("new.status is not distinct from old.status");
    expect(g).toContain("if old.status = 'cancelled' then");
    expect(g).toContain("if old.status = 'done' then");
    expect(sql).toContain("before update of status on orders");
    expect(sql).toContain("revoke all on function orders_guard_status_transition() from public, anon, authenticated;");
  });
  it("허용 전이를 명시: pending→paid|done|cancelled, paid→done|cancelled, 같은 값 no-op — 그 외(paid→pending 등)는 예외", () => {
    const g = fn(sql, "orders_guard_status_transition");
    expect(g).toContain("old.status = 'pending' and new.status in ('paid', 'done', 'cancelled')");
    expect(g).toContain("old.status = 'paid' and new.status in ('done', 'cancelled')");
    expect(g).toContain("허용되지 않는 주문 상태 변경이에요");
    expect(g.indexOf("허용되지 않는 주문 상태 변경이에요")).toBeGreaterThan(g.indexOf("old.status = 'paid' and new.status"));
    // 마지막 허용 분기 뒤에는 raise뿐 — paid→pending이 통과할 return이 없다
    const tail = g.slice(g.indexOf("old.status = 'paid' and new.status"));
    expect(tail.match(/return new;/g)).toHaveLength(1);
    // Mock confirm(pending→paid→done)과 cancel_test_payment(→cancelled)는 모두 허용 전이
    const mock = read("add_payment_test_provider.sql");
    expect(mock).toContain("update orders set status = 'paid'");
    expect(mock).toContain("update orders set status = 'done'");
  });
  it("트리거 함수는 SECURITY DEFINER + search_path 고정(회원은 point_transactions INSERT 권한이 없으므로)", () => {
    for (const n of ["orders_guard_status_transition", "orders_restore_points_on_cancel"]) {
      const f = fn(sql, n);
      expect(f).toContain("security definer");
      expect(f).toContain("set search_path = public");
    }
  });
});

describe("refund_membership — 기존 정책 유지 + 포인트 복원", () => {
  const r = fn(sql, "refund_membership");
  it("라이브 정의의 환불 조건/매출/쿠폰 복원이 그대로 있다", () => {
    for (const s of ["v_hours > 24", "remaining_count is distinct from v_mem.total_count", "set status = 'refunded', remaining_count = 0", "-v_amount",
      "set status = 'available', used_at = null, order_id = null", "'앱 셀프 환불'", "set status = 'expired'", "이미 환불된 수강권이에요"]) expect(r).toContain(s);
  });
  it("쿠폰 복원과 같은 order_id로 포인트 헬퍼 호출 — 환불 금액(payments.total_amount)과 별개로 실제 포인트 원장만 복원", () => {
    expect(r).toContain("perform _restore_order_points(v_order_id, '환불 포인트 복원');");
    expect(r.indexOf("set status = 'available'")).toBeLessThan(r.indexOf("_restore_order_points"));
    expect(r).toContain("SET search_path TO 'public'");
  });
  it("쿠폰 할인액을 포인트로 복원하지 않는다(헬퍼는 point_transactions 차감 행만 읽음)", () => {
    const h = fn(sql, "_restore_order_points");
    expect(h).not.toMatch(/member_coupons|discount/);
  });
});

describe("use_points — 중복 차감 방어(기존 사용처 유지)", () => {
  const u = fn(sql, "use_points");
  it("시그니처/권한 유지: (center, profile, amount, order default null), 본인 프로필만", () => {
    expect(u).toContain("p_center_id uuid, p_profile_id uuid, p_amount integer, p_order_id uuid default null");
    expect(u).toContain("p_profile_id not in (select my_profile_ids())");
    expect(u).toContain("v_balance < p_amount");
  });
  it("주문에 묶인 호출: 주문 잠금, 본인/센터 일치, pending만, points_used와 금액 일치, 이미 차감됐으면 다시 차감하지 않음", () => {
    for (const s of ["select * into v_order from orders where id = p_order_id for update;", "v_order.profile_id is distinct from p_profile_id", "v_order.status <> 'pending'",
      "coalesce(v_order.points_used, 0) <> p_amount", "return json_build_object('used', v_existing, 'already_used', true);"]) expect(u).toContain(s);
    expect(u.indexOf("already_used")).toBeLessThan(u.indexOf("insert into point_transactions"));
  });
  it("order_id가 없는 기존 용도는 그대로 동작, anon 실행 차단", () => {
    expect(u).toContain("if p_order_id is not null then");
    expect(sql).toContain("revoke all on function use_points(uuid, uuid, integer, uuid) from public, anon;");
    expect(sql).toContain("grant execute on function use_points(uuid, uuid, integer, uuid) to authenticated, service_role;");
  });
});

describe("cancelled 주문 재발급 금지", () => {
  it("fulfill_order / confirm_real_payment가 cancelled를 명시적으로 거부(done 선처리 뒤, 발급 전)", () => {
    const f = fn(sql, "fulfill_order");
    expect(f).toContain("if v_order.status = 'cancelled' then");
    expect(f).toContain("취소된 주문은 발급할 수 없어요");
    expect(f.indexOf("already_done', true")).toBeLessThan(f.indexOf("v_order.status = 'cancelled'"));
    expect(f.indexOf("v_order.status = 'cancelled'")).toBeLessThan(f.indexOf("insert into memberships"));
    const c = fn(sql, "confirm_real_payment");
    expect(c).toContain("취소된 주문은 결제를 확정할 수 없어요");
    expect(c.indexOf("v_order.status = 'cancelled'")).toBeLessThan(c.indexOf("_issue_membership_and_record_payment"));
    expect(c).toContain("SET search_path TO 'public'");
    // 이번 범위 밖: cancel_real_payment / _issue_membership_and_record_payment는 교체하지 않는다
    expect(sql).not.toMatch(/function (public\.)?(cancel_real_payment|_issue_membership_and_record_payment)\(/i);
  });
  it("fulfill_order 나머지 라이브 로직(권한/금액 검증/횟수선택/자동예약/쿠폰 사용)이 보존된다", () => {
    const f = fn(sql, "fulfill_order");
    for (const s of ["has_permission(v_order.center_id, 'pass.payment.create')", "_order_expected_amount(v_order, true)", "purchase_count_selectable", "_order_auto_book(", "set status = 'used'",
      "bound_day_of_week", "ensure_center_member"]) expect(f).toContain(s);
    expect(f).toContain("SET search_path TO 'public'");
  });
  it("옛 migration 전체를 복사해 최신 함수를 덮어쓰지 않는다(이 파일이 교체하는 함수는 5개뿐)", () => {
    const names = [...sql.matchAll(/create or replace function (?:public\.)?(\w+)\(/gi)].map((m) => m[1]).sort();
    expect(names).toEqual(["_restore_order_points", "confirm_real_payment", "fulfill_order", "orders_guard_status_transition", "orders_restore_points_on_cancel", "refund_membership", "use_points"]);
  });
});

describe("point_transactions 직접 INSERT 정책 — 주문 연계 행 위조 차단", () => {
  const policy = raw.slice(raw.indexOf('create policy "매니저 포인트 등록"'), raw.indexOf("-- 2) 내부 헬퍼"));
  it("수기 조정만 허용: 관리 센터 + order_id null + reverses_id null (기존 center 조건 유지)", () => {
    expect(sql).toContain('drop policy if exists "매니저 포인트 등록" on point_transactions;');
    expect(policy).toContain("for insert");
    expect(policy).toContain("center_id in (select my_managed_center_ids())");
    expect(policy).toContain("and order_id is null");
    expect(policy).toContain("and reverses_id is null");
    expect(policy).not.toMatch(/\bto\s+(anon|authenticated)\b/i);   // 기존 정책처럼 roles=public(별도 TO 지정 없음)
  });
  it("새 permission 체계를 만들지 않고, 다른 정책은 건드리지 않는다", () => {
    expect((sql.match(/create policy/gi) ?? [])).toHaveLength(1);
    expect(sql).not.toMatch(/insert into permissions|alter policy/i);
  });
  it("정상 수기 지급 클라이언트(registerPoint)는 order_id/reverses_id를 보내지 않는다", () => {
    const f = read("lib/sales.ts");
    const body = f.slice(f.indexOf("export async function registerPoint"), f.indexOf("export async function fetchPoints"));
    expect(body).not.toMatch(/order_id|reverses_id/);
  });
  it("서버 경로는 RLS를 우회하는 SECURITY DEFINER(use_points/_restore_order_points/트리거), 정책에 의존하지 않는다", () => {
    for (const n of ["use_points", "_restore_order_points", "orders_restore_points_on_cancel"]) expect(fn(sql, n)).toContain("security definer");
  });
  it("rollback은 적용 전 Production 정책으로 정확히 복원", () => {
    expect(rollback).toContain('drop policy if exists "매니저 포인트 등록" on point_transactions;');
    expect(rollback).toMatch(/create policy "매니저 포인트 등록" on point_transactions\s+for insert\s+with check \(center_id in \(select my_managed_center_ids\(\)\)\);/);
    expect(rollback).not.toMatch(/order_id is null|reverses_id is null/);
    expect(rollback.indexOf('create policy "매니저 포인트 등록"')).toBeLessThan(rollback.indexOf("drop index if exists uq_point_tx_reverses_id"));
  });
  it("적용 전/후 read-only 검증이 정책 정의를 확인한다", () => {
    for (const s of ["insert_policy_blocks_order_and_reverses_must_be_true", "insert_policy_count_must_be_1", "order_id IS NULL", "reverses_id IS NULL", "guard_has_allowlist_must_be_true", "confirm_search_path_must_be_true"]) expect(raw).toContain(s);
    expect(raw).toContain("where schemaname = 'public' and tablename = 'point_transactions' and cmd = 'INSERT'");
  });
});

describe("migration 구조 / rollback", () => {
  it("BEGIN/COMMIT, 새 테이블 없음, RLS 정책 변경은 point_transactions INSERT 정책 1개뿐", () => {
    expect(sql.trim().startsWith("BEGIN;")).toBe(true);
    expect(sql).toContain("COMMIT;");
    expect(sql).not.toMatch(/create table/i);
    expect([...sql.matchAll(/(create|drop|alter) policy[^;]*on (\w+)/gi)].map((m) => m[2])).toEqual(["point_transactions", "point_transactions"]);
  });
  it("rollback: 트리거/헬퍼/인덱스 제거 + 4개 함수를 적용 전 라이브 정의로 복원, 복원 원장 행은 지우지 않는다", () => {
    for (const s of ["drop trigger if exists orders_restore_points_on_cancel", "drop trigger if exists orders_guard_status_transition", "drop function if exists _restore_order_points(uuid, text);",
      "drop index if exists uq_point_tx_reverses_id", "drop index if exists uq_point_tx_order_debit"]) expect(rollback).toContain(s);
    expect(rollback).not.toMatch(/delete from point_transactions/i);
    expect(rollback).not.toContain("_restore_order_points(v_order_id");
    expect(rollback).not.toContain("취소된 주문은 발급할 수 없어요");
    expect(fn(rollback, "confirm_real_payment")).not.toContain("search_path");   // 적용 전 라이브 정의 그대로
    for (const n of ["use_points", "refund_membership", "fulfill_order", "confirm_real_payment"]) expect(rollback).toContain(`FUNCTION public.${n}(`);
  });
  it("적용 후 read-only 검증 쿼리 포함", () => {
    for (const s of ["indexes_must_be_2", "triggers_must_be_2", "helper_anon_must_be_false", "refund_restores_must_be_true", "fulfill_blocks_cancelled_must_be_true"]) expect(raw).toContain(s);
  });
});

describe("PG 실패/취소 경로(승인 전)", () => {
  it("failUrl 페이지가 서명된 복귀 토큰으로 서버의 pending 주문 취소를 요청한다(외부 Safari에는 로그인 세션이 없다 — 2026-10-02 변경)", () => {
    const p = read("app/checkout/fail/page.tsx");
    expect(p).toContain('sp.get("orderId")');
    expect(p).toContain("returnCancel({ returnToken, orderId })");
    expect(p).not.toContain("cancelMyPendingOrderQuietly");
  });
  it("정리는 status='pending' 조건부 UPDATE — 발급(done)된 주문은 건드리지 않고 실패는 조용히 무시", () => {
    const o = read("lib/orders.ts");
    const f = o.slice(o.indexOf("export async function cancelMyPendingOrderQuietly"), o.indexOf("function mapOrder"));
    expect(f).toContain('.eq("status", "pending")');
    expect(f).toContain("catch {");
    expect(f).not.toContain("confirm");   // 승인(confirm)/Toss 환불 API는 이번 범위가 아니다
  });
  it("checkout: 포인트 차감 실패(direct)/결제창 오류·실패(PG) 시 방금 만든 pending 주문을 정리, 결제창이 열린 뒤에는 fail 페이지에 맡긴다", () => {
    const c = read("app/checkout/page.tsx");
    expect(c).toContain("await cancelMyPendingOrderQuietly(directOrderIdForCleanup);");
    expect(c).toContain("await cancelMyPendingOrderQuietly(pgOrderIdForCleanup);");
    expect(c).toContain("pgOrderIdForCleanup = null;   // 결제창이 열린 뒤의 취소/실패는 /checkout/fail이 정리한다");
    expect(c.indexOf("directOrderIdForCleanup = directOrderId;")).toBeLessThan(c.indexOf("await usePoints(centerId, pointToUse, directOrderId)"));
  });
  it("Toss 승인 후 환불/cancel API 인증/승인 성공 후 DB 확정 실패 보상은 이번 범위가 아니다 — 서버 라우트 미변경", () => {
    expect(read("app/api/payments/cancel/route.ts")).toContain("cancel_real_payment");
    expect(read("app/api/payments/confirm/route.ts")).not.toContain("_restore_order_points");
  });
});

describe("Production QA 시나리오(실행 안 함)와 격리", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  it("별도 명령으로만 실행, 기본 test/integration/all에 포함되지 않는다", () => {
    expect(scripts["qa:production:points"]).toBe("vitest run --config vitest.qa-production.config.ts tests/qa/scenarios/order-points.qa.test.ts");
    for (const k of ["test", "test:integration", "test:all"]) expect(scripts[k] ?? "").not.toMatch(/qa/);
  });
  it("시나리오가 CASE 11(직접 INSERT 정책)·12(상태 전이)도 다룬다", () => {
    const sc = read("tests/qa/scenarios/order-points.qa.test.ts");
    for (const s of ["CASE 11", "CASE 12", "reverses_id: debit.id", "reason: \"결제 시 사용\", order_id: freshOrder", "forgedReverse.error).not.toBeNull()", "forgedDebit.error).not.toBeNull()", "수기 포인트 조정", "paid → pending 금지"]) expect(sc).toContain(s);
  });
  it("시나리오가 CASE 1~10(취소/중복/관리자/확정/환불/중복환불/변조/재확정/중복차감/PG 정리)을 다룬다", () => {
    const sc = read("tests/qa/scenarios/order-points.qa.test.ts");
    for (let i = 1; i <= 10; i++) expect(sc).toContain(`CASE ${i}`);
    for (const s of ["환불 포인트 복원", "주문 취소 포인트 복원", "requestRefund(", "cancelMyPendingOrderQuietly(", "toBe(35000)", "-35000", "status: \"available\""]) expect(sc).toContain(s);
  });
  it("정리는 이번 실행이 만든 UUID만, 기존 원장은 UPDATE/DELETE하지 않는다(시드는 +행 INSERT)", () => {
    const sc = read("tests/qa/scenarios/order-points.qa.test.ts");
    expect(sc).toContain("cleanupFixtures(admin(), tracker, { keep })");
    expect(sc).toContain('from("point_transactions").insert(');
    expect(sc).not.toMatch(/point_transactions"\)\s*\.(update|delete)/);
    expect(sc).toContain("shouldKeepFailedFixtures(process.env, failed)");
  });
});
