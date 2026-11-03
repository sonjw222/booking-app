import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const read = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");
const apply = read("add_nicepay_review_real_center_grants_20261103.sql");
const rollback = read("rollback_add_nicepay_review_real_center_grants_20261103.sql");
const verify = read("verify_add_nicepay_review_real_center_grants_20261103.sql");
const p2 = read("add_nicepay_review_center_isolation_20261028.sql");
const nonComment = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const fn = (s: string, name: string) => (new RegExp(`create or replace function ${name}\\(.*?\\n(?:\\$\\$;|end \\$\\$;)\\n`, "s").exec(s) ?? [""])[0];

describe("NICEPAY 실제 센터 허용 목록 SQL — 정적 계약(실제 격리 Postgres 동작은 scripts/isolated/nicepayReview/realCenterGrants.mjs 41건)", () => {
  it("데이터 변경이 없다: 기존 테이블 UPDATE/DELETE/INSERT/TRUNCATE/DROP TABLE 없음, 새 테이블만 만든다, 단일 트랜잭션", () => {
    const sql = nonComment(apply);
    expect(sql).not.toMatch(/drop\s+table|truncate|delete\s+from|^\s*update\s|^\s*insert\s+into/im);
    expect(sql).toMatch(/^BEGIN;/m); expect(sql).toMatch(/^COMMIT;/m);
    expect(sql.match(/create table if not exists (\w+)/g)).toEqual(["create table if not exists nicepay_review_center_grants"]);
  });
  it("허용 목록 테이블은 RLS 켜짐·정책 없음·클라이언트 권한 회수(서버/SQL Editor 만 기록)", () => {
    expect(apply).toMatch(/alter table nicepay_review_center_grants enable row level security/);
    expect(nonComment(apply)).not.toMatch(/create policy/i);
    expect(apply).toMatch(/revoke all on table nicepay_review_center_grants from public, anon, authenticated/);
  });
  it("기본은 조회 전용(can_purchase default false), 쓰기 가드는 purchase_allowed 로 분리, 목록 RPC 는 다시 만들지 않는다(만료 상품 SQL 과 순서 무관)", () => {
    expect(apply).toMatch(/can_purchase boolean not null default false/);
    expect(fn(apply, "nicepay_review_guard_center")).toContain("nicepay_review_center_purchase_allowed");
    expect(fn(apply, "nicepay_review_guard_center")).not.toContain("nicepay_review_center_member_allowed");
    expect(nonComment(apply)).not.toMatch(/create or replace function (public\.)?(fetch_public_storefront_products|fetch_purchasable_products|fetch_public_storefront_product_periods|create_order_secure)/i);
  });
  it("카드 결제 게이트(nicepay_order_is_review_target)와 주문 정책은 건드리지 않는다 — 결제 활성화 아님", () => {
    expect(nonComment(apply)).not.toMatch(/nicepay_order_is_review_target|orders_guard_nicepay_create|nicepay_claim_order|nicepay_checkout_gate/);
  });
  it("가시성 함수: 심사관의 운영 센터는 허용 목록만 추가, 비심사관·매니저·관리자·심사 센터 분기는 P2 정의와 같은 문장", () => {
    const a = fn(apply, "nicepay_review_center_allowed"), a2 = fn(p2, "nicepay_review_center_allowed");
    expect(a).toContain("else not nicepay_is_reviewer() or nicepay_review_center_granted(p_center_id)");
    expect(a.replace(" or nicepay_review_center_granted(p_center_id)", "")).toBe(a2);   // 새 조건 한 군데만 다르다
    const m = fn(apply, "nicepay_review_center_member_allowed"), m2 = fn(p2, "nicepay_review_center_member_allowed");
    expect(m.replace(" or nicepay_review_center_granted(p_center_id)", "")).toBe(m2);
  });
  it("허용 대상 제한 트리거: 승인된 운영 센터(내부·심사 센터 제외)와 심사관 권한 계정만", () => {
    const t = fn(apply, "enforce_nicepay_review_center_grant_valid");
    expect(t).toMatch(/c\.status = 'approved' and not c\.is_internal and not c\.is_nicepay_review/); expect(t).toMatch(/a\.nicepay_review_access/);
  });
  it("허용 판정은 심사관 권한(nicepay_is_reviewer)에 종속 — 권한이 꺼지면 허용 행이 무효, 이메일·센터 UUID 하드코딩 없음", () => {
    for (const n of ["nicepay_review_center_granted", "nicepay_review_center_purchase_granted"]) expect(fn(apply, n)).toContain("nicepay_is_reviewer()");
    expect(nonComment(apply)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
  it("롤백: 함수 3개를 P2 정의 그대로 복원하고 새 객체를 삭제, 허용 행이 있으면 중단(데이터 보존)", () => {
    for (const n of ["nicepay_review_center_allowed", "nicepay_review_center_member_allowed", "nicepay_review_guard_center"]) expect(fn(rollback, n)).toBe(fn(p2, n));
    expect(rollback).toMatch(/drop table if exists nicepay_review_center_grants/); expect(rollback).toMatch(/롤백 중단: 허용 목록에 행이 있어요/);
    expect(nonComment(rollback)).not.toMatch(/\bupdate\s+\w+\s+set\b|delete\s+from\s+(?!nicepay_review_center_grants)/i);
  });
  it("verify 는 읽기 전용", () => { expect(nonComment(verify)).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate)\b/i); });
});
