import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  it("심사관 판정은 인증 사용자의 계정(my_account_id)과 pg_checkout_override 만 — 이메일 문자열을 쓰지 않는다", () => {
    expect(apply).toMatch(/pg_checkout_override from accounts a where a\.id = my_account_id\(\)/);
    expect(nonComment(apply)).not.toMatch(/@|email/i);
  });
  it("기존 허용 정책을 대체하지 않고 restrictive 정책 3개(centers/classes/products)로 겹친다", () => {
    expect(apply.match(/as restrictive for select/g)).toHaveLength(3);
    expect(nonComment(apply)).not.toMatch(/drop policy if exists "(승인된 센터 조회|승인된 센터 수업 조회|상품 조회)"/);
  });
  it("구매·예약·수강권 발급 경로는 테이블 트리거로 막는다(SECURITY DEFINER RPC 우회 방지), 서버(auth.uid() null)는 통과", () => {
    for (const t of ["orders", "memberships", "reservations"]) expect(apply).toContain(`trg_${t}_nicepay_review_guard`);
    expect(apply).toMatch(/if auth\.uid\(\) is null then return new; end if;/);
  });
  it("목록 RPC 3개에 같은 판정이 들어가고 기존 is_internal 조건은 유지된다", () => {
    expect(apply.match(/nicepay_review_center_allowed\((c\.id|p\.center_id)\)\s+--/g)?.length).toBeGreaterThanOrEqual(3);
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
    expect(rollback).toContain('drop policy if exists "nicepay_review_isolation" on centers');
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
});
