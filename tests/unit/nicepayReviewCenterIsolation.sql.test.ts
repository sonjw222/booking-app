import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const read = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");
const apply = read("add_nicepay_review_center_isolation_20261028.sql");
const rollback = read("rollback_add_nicepay_review_center_isolation_20261028.sql");
const seed = read("seed_nicepay_review_center_20261028.sql");
const verify = read("verify_add_nicepay_review_center_isolation_20261028.sql");
const nonComment = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("NICEPAY 심사 센터 분리 SQL — 정적 계약(실제 격리 Postgres 검증은 scripts/isolated/nicepayReview/*)", () => {
  it("파괴적 문장이 없다(DROP TABLE/TRUNCATE/DELETE/UPDATE 데이터 변경 없음), 단일 트랜잭션", () => {
    const sql = nonComment(apply);
    expect(sql).not.toMatch(/drop\s+table|truncate|delete\s+from|drop\s+column/i);
    expect(sql).not.toMatch(/^\s*update\s/im);
    expect(sql).toMatch(/^BEGIN;/m); expect(sql).toMatch(/^COMMIT;/m);
  });
  it("B안: 심사관 판정은 인증 사용자의 계정(my_account_id)과 전용 권한 nicepay_review_access 만 — 토스용 pg_checkout_override·이메일 문자열을 쓰지 않는다", () => {
    expect(apply).toMatch(/nicepay_review_access from accounts a where a\.id = my_account_id\(\)/);
    expect(nonComment(apply).replace(/comment on [^;]*;/g, "")).not.toContain("pg_checkout_override");   // 주석·COMMENT 문구 제외, 실행 코드에는 없다
    expect(nonComment(apply)).not.toMatch(/@|email/i);
  });
  it("기존 허용 정책을 대체하지 않고 restrictive 정책 3개(centers/classes/products)로 겹친다", () => {
    expect(apply.match(/as restrictive for select/g)).toHaveLength(3);
    expect(nonComment(apply)).not.toMatch(/drop policy if exists "(승인된 센터 조회|승인된 센터 수업 조회|상품 조회)"/);
  });
  it("구매·예약·수강권 발급 경로는 테이블 트리거로 막는다(SECURITY DEFINER RPC 우회 방지), 서버(클라이언트 요청이 아닌 경로)는 통과", () => {
    for (const t of ["orders", "memberships", "cart_items", "purchase_requests"]) expect(apply).toContain(`'${t}'`);
    expect(apply).toContain("trg_%s_nicepay_review_guard"); expect(apply).toContain("trg_%s_nicepay_review_guard_upd");
    expect(apply).toContain("trg_reservations_nicepay_review_guard"); expect(apply).toContain("trg_reservations_nicepay_review_guard_upd");
    expect(apply).toMatch(/if not nicepay_is_client_request\(\) then return new; end if;/);
  });
  it("클라이언트가 보낸 center_id 만 믿지 않는다 — 상품의 실제 센터·수업 센터·수강권 센터도 검사하고, UPDATE 는 바뀔 때만 검사", () => {
    expect(apply).toMatch(/select p\.center_id into v_b from products p where p\.id = \(v_row->>'product_id'\)::uuid/);
    expect(apply).toMatch(/select c\.center_id into v_a from classes c/); expect(apply).toMatch(/select m\.center_id into v_b from memberships m/);
    // 센터↔상품, 수업↔수강권 센터 일치 검사(둘 다 non-null 일 때만 — NULL 을 허용하는 기존 흐름 유지)
    expect(apply).toContain("센터와 상품이 일치하지 않아요"); expect(apply).toContain("수업과 수강권의 센터가 일치하지 않아요");
    expect(apply).toMatch(/v_a is not null and v_b is not null and v_a <> v_b/);
    expect(apply.match(/when \(old\.center_id is distinct from new\.center_id or old\.product_id is distinct from new\.product_id\)/g)).toHaveLength(1);
    expect(apply).toMatch(/update of class_id, membership_id on reservations/);
  });
  it("기존 예약 사후 처리: 내 예약이 걸린 수업만 읽는 예외(수업만, 센터·상품 예외 없음)", () => {
    expect(apply).toContain("nicepay_class_has_my_reservation"); expect(apply).toContain('create policy "nicepay_own_reservation_class" on classes for select');
    const policies = nonComment(apply).split("\n").filter((l) => /^create policy/.test(l.trim()));
    expect(policies.filter((l) => l.includes("nicepay_class_has_my_reservation") && !/ on classes /.test(l))).toEqual([]);
  });
  it("목록 RPC 3개에 같은 판정이 들어가고 기존 is_internal 조건은 유지된다", () => {
    expect(apply.match(/nicepay_review_center_member_allowed\((c\.id|p\.center_id)\)\s+--/g)?.length).toBeGreaterThanOrEqual(3);   // 회원용 판정(매니저 예외 없음)
    expect(apply).toContain("and not c.is_internal");
    expect(apply).toMatch(/revoke all on function public\.fetch_purchasable_products\(uuid\) from public, anon;/);
  });
  it("is_nicepay_review 는 운영자만 바꿀 수 있고 default false", () => {
    expect(apply).toContain("add column if not exists is_nicepay_review boolean not null default false");
    expect(apply).toContain("enforce_center_nicepay_review_admin_only");
  });
  it("preflight 가 전제 객체 부재 시 중단한다", () => { expect(apply).toMatch(/raise exception 'NICEPAY 심사 분리: 전제 함수가 없습니다/); });
  it("롤백: 정책·트리거·신규 함수 삭제 + 이전 정의 복원, 컬럼/데이터는 남긴다", () => {
    expect(nonComment(rollback)).not.toMatch(/drop\s+column|drop\s+table|delete\s+from/i);
    expect(rollback).toContain('drop policy if exists "nicepay_review_isolation" on centers'); expect(rollback).toContain('drop policy if exists "nicepay_own_reservation_class" on classes');
    expect(rollback).toContain("롤백 중단"); expect(rollback).toMatch(/status = 'approved' and not is_internal/);
    expect(rollback).toContain("created_by:add_nicepay_review_center_isolation_20261028"); expect(apply).toContain("_nicepay_periods_existed");
    expect(rollback).toContain("nicepay_class_has_my_reservation");
    expect(rollback).toMatch(/or public\.is_platform_admin\(\),\s*false\);/);
  });
  it("시드: 분리 SQL 미적용이면 중단, 임의 주소·사업자번호 없음, 심사 환경임을 밝힘, 멱등", () => {
    expect(seed).toMatch(/먼저 add_nicepay_review_center_isolation_20261028\.sql 을 적용하세요/);
    expect(nonComment(seed)).not.toMatch(/address|business_number/i);
    expect(seed).toContain("심사 전용"); expect(seed).toMatch(/where not exists \(select 1 from centers where is_nicepay_review/);
    expect(nonComment(seed)).not.toMatch(/delete\s+from|drop\s|update\s/i);
  });
  it("시드 상품 3종 모두 사전예약 없음(시작일=결제일) + 서비스기간 ≤ 1년(90일 이하)", () => {
    const days = [...seed.matchAll(/'(?:count|period)',\s*(?:\d+|null),\s*(?:true|false),\s*(\d+),/g)].map((m) => Number(m[1]));
    expect(days).toEqual([7, 28, 90]); for (const d of days) expect(d).toBeLessThanOrEqual(365);
    expect(seed).toContain("'days'");
  });
  it("verify 는 읽기 전용(시뮬레이션은 주석 + ROLLBACK)", () => { expect(nonComment(verify)).not.toMatch(/insert|update|delete|drop|alter|create/i); });

  it("B안 전용 권한: 컬럼·운영자 전용 보호 트리거, 회원용 판정은 심사관에게 매니저 예외를 주지 않는다", () => {
    expect(apply).toContain("add column if not exists nicepay_review_access boolean not null default false");
    expect(apply).toContain("enforce_nicepay_review_access_admin_only");
    expect(apply).toMatch(/when nicepay_is_reviewer\(\) then exists \(select 1 from centers c where c\.id = p_center_id and c\.is_nicepay_review\)/);
  });
  it("게이트 패치: 운영 적용 함수 2개의 심사관 판별만 전용 권한으로 제자리 치환(통째 덮어쓰기 금지·멱등·역치환 롤백)", () => {
    const gate = read("fix_nicepay_gate_reviewer_flag_20261029.sql"); const gateRb = read("rollback_fix_nicepay_gate_reviewer_flag_20261029.sql");
    expect(gate).toContain("orders_guard_nicepay_create"); expect(gate).toContain("nicepay_claim_order");
    expect(gate).toContain("nicepay_order_is_review_target(new.center_id, new.product_id)"); expect(gate).toContain("nicepay_order_is_review_target(go.center_id, go.product_id)");
    expect(gate).toContain("의 현재 정의가 예상"); expect(gate).toContain("덮어쓰지 않고 중단합니다"); expect(gate).toContain("b2f340d8d41fc2428e26c7cde3aaafd4"); expect(gate).toContain("4cb7d4ece28db732bd5886088c034609"); expect(gate).toContain("721bef6e27646547535cfe7b05393f88"); expect(gate).toContain("d7145831da2f416612818d2e4fe5d5fc");
    expect(gate).toContain("건너뜀");
    expect(gate).toContain("accounts.nicepay_review_access 가 없어요"); expect(nonComment(gate)).not.toMatch(/drop |delete |truncate/i);
    expect(gateRb).toContain("mode 가 off 가 아니에요"); expect(gateRb).toContain("drop function if exists public.nicepay_order_is_review_target");
    expect(gateRb).toContain("b2f340d8d41fc2428e26c7cde3aaafd4");
  });
  it("종료 절차: 권한 해제·게이트 off·센터 비공개·대기 주문 정리, 기존 센터/토스 계정/결제 기록은 건드리지 않는다", () => {
    const close = nonComment(read("close_nicepay_review_20261029.sql"));
    expect(close).toMatch(/update accounts set nicepay_review_access = false/); expect(close).toMatch(/update nicepay_checkout_gate set mode = 'off'/);
    expect(close).toMatch(/update centers set is_internal = true where is_nicepay_review/); expect(close).toMatch(/status = 'pending' and pg_claim_id is null and pg_tid is null and pg_review_at is null\s+and center_id in \(select id from centers where is_nicepay_review\)|status = 'pending' and pg_claim_id is null and pg_tid is null and pg_review_at is null/);
    expect(close).not.toMatch(/pg_checkout_override\s*=|delete\s+from|drop\s|truncate/i);
  });

  it("검증 SQL 은 P2 가 실제로 만드는 것과 일치: 컬럼 2·함수 8·정책 3+1·트리거 12(정확한 이름), 운영의 기존 nicepay_review_actions_* 트리거를 세지 않는다", () => {
    expect(verify).toContain("columns_must_be_2"); expect(verify).toContain("new_functions_must_be_8"); expect(verify).toContain("triggers_must_be_12");
    expect(verify).not.toMatch(/tgname like '%nicepay_review%'/);
    const cols = [...apply.matchAll(/add column if not exists (\w+)/g)].map((m) => m[1]).filter((c) => c.startsWith("is_nicepay") || c.startsWith("nicepay_"));
    expect(cols.sort()).toEqual(["is_nicepay_review", "nicepay_review_access"]);
    const fns = [...apply.matchAll(/^create or replace function (nicepay_\w+|enforce_\w*nicepay\w+)\(/gm)].map((m) => m[1]);
    expect(new Set(fns).size).toBe(8);
    for (const f of new Set(fns)) expect(verify).toContain(`'${f}'`);
  });

  it("전용 권한 보호는 UPDATE 뿐 아니라 INSERT(가입·upsert·삭제 후 재생성)에도 걸린다 — 서버/SQL Editor(클라이언트 요청이 아닌 경로)·플랫폼 관리자는 통과", () => {
    expect(apply).toMatch(/create trigger trg_accounts_nicepay_review_access_admin_only before insert or update on accounts/);
    expect(apply).toMatch(/tg_op = 'INSERT' and new\.nicepay_review_access/); expect(apply).toMatch(/tg_op = 'UPDATE' and new\.nicepay_review_access is distinct from old\.nicepay_review_access/);
    expect(apply).toMatch(/if nicepay_is_client_request\(\) and not is_platform_admin\(\) then/);
    expect(apply).toMatch(/create or replace function nicepay_is_client_request\(\)[\s\S]*auth\.uid\(\) is not null or coalesce\(nullif\(current_setting\('role', true\), ''\), 'none'\) in \('anon', 'authenticated'\)/);
  });
  it("accounts INSERT 특권 컬럼 보호는 PR #245 로 운영 적용 완료 — 저장소 파일은 적용본(SHA-256 고정)과 같고 P2 에 포함되지 않는다", () => {
    const d = read("fix_accounts_insert_privileged_columns_20261030.sql"); const code = nonComment(d);
    expect(createHash("sha256").update(d).digest("hex")).toBe("b8c77b4bbe669690e29d88f27cbd487d9b8dd975f63b5cc6995bae3929f619af");
    expect(code).toMatch(/create trigger trg_accounts_insert_privileged_columns before insert on accounts/);
    expect(code).toMatch(/if auth\.uid\(\) is null then return new; end if;/); expect(code).toMatch(/new\.is_platform_admin or new\.pg_checkout_override/); expect(code).toMatch(/app\.allow_merged_into_change/);
    expect(code).not.toMatch(/\b(update|delete|truncate)\b|drop (table|column)/i);
    expect(apply).not.toContain("enforce_accounts_insert_privileged_columns");
    expect(read("scripts/isolated/nicepayReview/setupLocal.sh")).toContain("fix_accounts_insert_privileged_columns_20261030.sql");
    for (const f of ["docs/payments/NICEPAY_SQL_RUNBOOK_20261028.md", "docs/payments/NICEPAY_SQL_FINAL_REVIEW.md"]) expect(read(f)).toMatch(/이미 운영 적용|운영 적용 완료|이미 적용됨/);
  });
  it("P2 롤백은 남겨 두는 accounts 보호 트리거가 의존하는 함수(nicepay_is_client_request, enforce_nicepay_review_access_admin_only)를 지우지 않는다", () => {
    const code = nonComment(rollback);
    expect(code).not.toMatch(/drop function[^;]*nicepay_is_client_request/i); expect(code).not.toMatch(/drop function[^;]*enforce_nicepay_review_access_admin_only/i);
    expect(code).not.toMatch(/drop trigger[^;]*trg_accounts_nicepay_review_access_admin_only/i);
    // 남기는 트리거가 부르는 함수가 P2 에 실제로 존재한다 + 롤백이 지우는 함수들 중 어느 것도 그 트리거가 부르지 않는다
    expect(apply).toMatch(/create trigger trg_accounts_nicepay_review_access_admin_only[\s\S]*execute function enforce_nicepay_review_access_admin_only\(\)/);
    const body = apply.slice(apply.indexOf("create or replace function enforce_nicepay_review_access_admin_only"), apply.indexOf("create trigger trg_accounts_nicepay_review_access_admin_only"));
    const called = [...body.matchAll(/\b(nicepay_\w+|is_platform_admin)\(/g)].map((m) => m[1]).filter((n) => n !== "is_platform_admin");
    for (const fn of new Set(called)) expect(code, `롤백이 보호 트리거의 의존 함수 ${fn} 를 삭제`).not.toMatch(new RegExp(`drop function[^;]*\\b${fn}\\(`, "i"));
  });
  it("P2 롤백: 정책 제거 전후로 계정별 실제 가시성을 측정해 노출이 늘면 전체 롤백(회원 데이터는 건드리지 않음)", () => {
    const code = nonComment(rollback);
    expect(code).toContain("_nicepay_rb_probe"); expect(code).toMatch(/set local role authenticated/); expect(code).toMatch(/set local role anon/);
    expect(code).toMatch(/json_build_object\('sub', p_auth, 'role', 'authenticated'\)/);
    for (const rel of ["center_members", "memberships", "orders", "cart_items", "purchase_requests", "reservations", "manager_centers"]) expect(code, rel).toContain(rel);
    expect(code).toContain("fetch_purchasable_products"); expect(code).toContain("fetch_public_storefront_products");
    expect(code).toContain("새로 보이게 돼요"); expect(code).toContain("삭제·수정하지 않았고");
    // 첫 측정은 정책 제거 전, 비교는 COMMIT 직전
    expect(code.indexOf("insert into _nicepay_rb_probe")).toBeLessThan(code.indexOf('drop policy if exists "nicepay_review_isolation" on centers'));
    expect(code.lastIndexOf("a[i] > b[i]")).toBeGreaterThan(code.indexOf("drop function if exists nicepay_is_reviewer"));
    expect(code).not.toMatch(/delete\s+from\s+(center_members|profiles|accounts|orders|memberships|reservations)|update\s+(center_members|profiles|orders|memberships|reservations)\b/i);
    expect(code).not.toMatch(/drop function[^;]*nicepay_is_client_request/i);
  });
  it("심사 종료 SQL: 게이트 off 가 가장 먼저, approving 확인(알림), 권한 해제, 센터 비공개, 대기 주문 정리, 노출 관계 확인 순서", () => {
    const c = nonComment(read("close_nicepay_review_20261029.sql"));
    const order = ["update nicepay_checkout_gate set mode = 'off'", "status = 'approving'", "update accounts set nicepay_review_access = false", "update centers set is_internal = true", "update orders set status = 'cancelled'", "review_center_member_rows_block_p2_rollback_if_nonzero"].map((k) => c.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    const ready = read("check_nicepay_review_rollback_readiness_20261030.sql"); expect(nonComment(ready)).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate)\b/i);
    expect(ready).toContain("center_member_rows_must_be_0"); expect(ready).toContain("in_flight_approving_orders_must_be_0");
  });
  it("P2b 심사 대상 판정: 승인·비내부 심사 센터 + 판매 중 상품(NULL 상품 제외), 롤백은 approving 주문이 있으면 중단", () => {
    const gate = nonComment(read("fix_nicepay_gate_reviewer_flag_20261029.sql")); const gateRb = nonComment(read("rollback_fix_nicepay_gate_reviewer_flag_20261029.sql"));
    expect(gate).toMatch(/p_center_id is not null and p_product_id is not null/); expect(gate).toMatch(/c\.is_nicepay_review and c\.status = 'approved' and not c\.is_internal/);
    expect(gate).toMatch(/pr\.center_id = p_center_id and pr\.is_active and pr\.is_on_sale/);
    expect(gateRb).toMatch(/payment_provider = 'nicepay' and status = 'approving'/); expect(gateRb).toContain("승인 선점 상태(approving)");
    expect(gateRb.indexOf("v_inflight")).toBeLessThan(gateRb.indexOf("execute v_new"));
  });
});
