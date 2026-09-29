/*
  add_email_signup_precheck.sql/rollback_add_email_signup_precheck.sql은 아직 production에
  실행되지 않았다(사용자 승인 대기, 최종 보고서 참고) — DB가 필요한 통합 테스트로 검증할 수
  없으므로, 이 정적 테스트는 파일 텍스트가 의도한 보안 경계(search_path hardening,
  anon/authenticated 실행 금지, service_role 전용, 네이버 실제 이메일까지 비교, rate limit
  원자성)를 실제로 포함하는지 확인한다. 2026-09-30 보안 보완 반영.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(__dirname, "../../add_email_signup_precheck.sql"), "utf-8");
const rollback = readFileSync(join(__dirname, "../../rollback_add_email_signup_precheck.sql"), "utf-8");

describe("email_signup_available — 이메일 비교 로직", () => {
  it("auth.users.email과 네이버 실제 이메일(raw_user_meta_data->>'naver_email') 둘 다 비교한다", () => {
    expect(sql).toMatch(/lower\(email\) = lower\(trim\(p_email\)\)/);
    expect(sql).toMatch(/raw_user_meta_data->>'naver_email'/);
  });

  it("대소문자/앞뒤 공백 무관하게 같은 이메일로 판정한다(lower + trim)", () => {
    const fnBody = sql.slice(sql.indexOf("create or replace function email_signup_available"), sql.indexOf("revoke all on function email_signup_available"));
    expect(fnBody).toContain("lower(trim(p_email))");
    expect(fnBody).toContain("lower(email)");
    expect(fnBody).toContain("lower(raw_user_meta_data->>'naver_email')");
  });

  it("카카오 이메일은 추론/추가하지 않는다(실제 이메일 scope가 없어 비교 대상 자체가 없음)", () => {
    const fnBody = sql.slice(sql.indexOf("create or replace function email_signup_available"), sql.indexOf("revoke all on function email_signup_available"));
    expect(fnBody).not.toMatch(/kakao_email/i);
  });
});

describe("SECURITY DEFINER hardening — search_path", () => {
  it("email_signup_available과 consume_email_check_attempt 둘 다 search_path를 빈 값으로 고정한다", () => {
    const fn1 = sql.slice(sql.indexOf("create or replace function email_signup_available"), sql.indexOf("revoke all on function email_signup_available"));
    const fn2 = sql.slice(sql.indexOf("create or replace function consume_email_check_attempt"), sql.indexOf("revoke all on function consume_email_check_attempt"));
    expect(fn1).toMatch(/set search_path = ''/);
    expect(fn2).toMatch(/set search_path = ''/);
  });

  it("search_path가 비어 있으므로 모든 테이블 참조에 스키마를 명시한다(auth.users, public.email_check_attempts)", () => {
    const fn1 = sql.slice(sql.indexOf("create or replace function email_signup_available"), sql.indexOf("revoke all on function email_signup_available"));
    const fn2 = sql.slice(sql.indexOf("create or replace function consume_email_check_attempt"), sql.indexOf("revoke all on function consume_email_check_attempt"));
    expect(fn1).toContain("from auth.users");
    expect(fn2).toContain("from public.email_check_attempts");
    expect(fn2).toContain("into public.email_check_attempts");
  });
});

describe("권한 — public/anon/authenticated 실행 금지, service_role만 허용", () => {
  it("email_signup_available: anon/authenticated 실행 권한을 명시적으로 회수하고 service_role에만 부여한다", () => {
    expect(sql).toContain("revoke all on function email_signup_available(text) from public;");
    expect(sql).toContain("revoke all on function email_signup_available(text) from anon;");
    expect(sql).toContain("revoke all on function email_signup_available(text) from authenticated;");
    expect(sql).toContain("grant execute on function email_signup_available(text) to service_role;");
  });

  it("consume_email_check_attempt도 동일하게 service_role 전용이다", () => {
    expect(sql).toContain("revoke all on function consume_email_check_attempt(text) from public;");
    expect(sql).toContain("revoke all on function consume_email_check_attempt(text) from anon;");
    expect(sql).toContain("revoke all on function consume_email_check_attempt(text) from authenticated;");
    expect(sql).toContain("grant execute on function consume_email_check_attempt(text) to service_role;");
  });
});

describe("consume_email_check_attempt — 원자적 rate limit", () => {
  const fnBody = sql.slice(sql.indexOf("create or replace function consume_email_check_attempt"), sql.indexOf("revoke all on function consume_email_check_attempt"));

  it("advisory lock으로 같은 IP 해시에 대한 동시 실행을 직렬화한다", () => {
    expect(fnBody).toMatch(/pg_advisory_xact_lock/);
  });

  it("advisory lock 획득이 카운트 확인보다 먼저, 카운트 확인 후에 insert가 온다(같은 잠금 구간 안에서 원자적으로 처리)", () => {
    const lockIdx = fnBody.indexOf("pg_advisory_xact_lock");
    const countIdx = fnBody.indexOf("select count(*)");
    const insertIdx = fnBody.indexOf("insert into public.email_check_attempts");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(countIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(countIdx);
  });

  it("10분 윈도우, 20회 임계값(20회 이상이면 차단, 그 미만이면 허용+기록)을 그대로 구현한다", () => {
    expect(fnBody).toContain("interval '10 minutes'");
    expect(fnBody).toMatch(/if v_recent_count >= 20 then\s*return false;/);
    expect(fnBody).toContain("return true;");
  });

  it("Edge Function이 아니라 이 RPC 하나가 count/insert를 모두 수행한다(check-then-act race 제거)", () => {
    expect(fnBody).toContain("select count(*) into v_recent_count");
    expect(fnBody).toContain("insert into public.email_check_attempts (ip_hash) values (p_ip_hash);");
  });
});

describe("email_check_attempts 테이블", () => {
  it("이메일 원문이 아니라 IP 해시만 저장한다(개인정보 최소화)", () => {
    expect(sql).toContain("ip_hash");
    expect(sql).not.toMatch(/create table if not exists email_check_attempts \([^)]*email\b/i);
  });

  it("RLS를 켜고 service_role에만 권한을 준다(phone_verifications와 동일 패턴)", () => {
    expect(sql).toContain("alter table email_check_attempts enable row level security;");
    expect(sql).toContain("grant select, insert on email_check_attempts to service_role;");
  });
});

describe("기존 production 객체 보호", () => {
  it("기존 테이블/컬럼을 변경하지 않는다(alter table ... add column 없음)", () => {
    expect(sql).not.toMatch(/alter table \w+ add column/i);
    expect(sql).not.toMatch(/drop table|drop column/i);
  });

  it("계정 자동 병합 로직을 추가하지 않는다(accounts/profiles를 update/merge하지 않음, DEC-004 유지)", () => {
    expect(sql).not.toMatch(/update accounts|merged_into/i);
  });
});

describe("rollback_add_email_signup_precheck.sql 정적 검토", () => {
  it("이번에 추가한 함수 2개 + 테이블 1개만 정확히 제거한다", () => {
    expect(rollback).toContain("drop function if exists email_signup_available(text);");
    expect(rollback).toContain("drop function if exists consume_email_check_attempt(text);");
    expect(rollback).toContain("drop table if exists email_check_attempts;");
  });

  it("그 외 다른 production 객체는 건드리지 않는다(다른 drop 문이 없음)", () => {
    const dropStatements = rollback.match(/^drop /gim) ?? [];
    expect(dropStatements).toHaveLength(3);
  });
});
