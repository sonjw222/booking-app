/*
  add_email_signup_precheck.sql/rollback_add_email_signup_precheck.sql은 아직 production에
  실행되지 않았다(사용자 승인 대기, 최종 보고서 참고) — DB가 필요한 통합 테스트로 검증할 수
  없으므로, 이 정적 테스트는 파일 텍스트가 의도한 보안 경계(anon/authenticated 실행 금지,
  service_role 전용, 네이버 실제 이메일까지 비교)를 실제로 포함하는지 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(__dirname, "../../add_email_signup_precheck.sql"), "utf-8");
const rollback = readFileSync(join(__dirname, "../../rollback_add_email_signup_precheck.sql"), "utf-8");

describe("add_email_signup_precheck.sql 정적 검토", () => {
  it("auth.users.email과 네이버 실제 이메일(raw_user_meta_data->>'naver_email') 둘 다 비교한다", () => {
    expect(sql).toMatch(/lower\(email\) = lower\(trim\(p_email\)\)/);
    expect(sql).toMatch(/raw_user_meta_data->>'naver_email'/);
  });

  it("anon/authenticated 실행 권한을 명시적으로 회수하고 service_role에만 부여한다(클라이언트 직접 호출 차단)", () => {
    expect(sql).toContain("revoke all on function email_signup_available(text) from anon;");
    expect(sql).toContain("revoke all on function email_signup_available(text) from authenticated;");
    expect(sql).toContain("grant execute on function email_signup_available(text) to service_role;");
  });

  it("rate-limit 테이블은 이메일 원문이 아니라 IP 해시만 저장한다(개인정보 최소화)", () => {
    expect(sql).toContain("ip_hash");
    expect(sql).not.toMatch(/create table if not exists email_check_attempts \([^)]*email\b/i);
  });

  it("rate-limit 테이블도 RLS를 켜고 service_role에만 권한을 준다(phone_verifications와 동일 패턴)", () => {
    expect(sql).toContain("alter table email_check_attempts enable row level security;");
    expect(sql).toContain("grant select, insert on email_check_attempts to service_role;");
  });

  it("기존 테이블/컬럼을 변경하지 않는다(create table/function만, alter table ... add column 없음)", () => {
    expect(sql).not.toMatch(/alter table \w+ add column/i);
    expect(sql).not.toMatch(/drop table|drop column/i);
  });
});

describe("rollback_add_email_signup_precheck.sql 정적 검토", () => {
  it("추가한 함수/테이블만 제거하고 그 외 아무것도 건드리지 않는다", () => {
    expect(rollback).toContain("drop function if exists email_signup_available(text);");
    expect(rollback).toContain("drop table if exists email_check_attempts;");
  });
});
