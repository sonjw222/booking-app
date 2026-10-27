import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const dir = path.join(root, "isolated-supabase/supabase");
const migrations = fs.readdirSync(path.join(dir, "migrations")).sort();
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
const baseline = read("migrations/20261027000000_baseline_public_schema.sql");

describe("격리 Supabase baseline 위생(공유 DEV/운영 데이터가 섞이지 않았는가)", () => {
  it("baseline 은 스키마-only: 행 데이터·JWT·이메일·URL·프로젝트 ref 가 없다", () => {
    expect(baseline.match(/^(INSERT INTO|COPY )/gm) ?? []).toHaveLength(0);
    expect(baseline).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(baseline).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    expect(baseline).not.toMatch(/https?:\/\/[A-Za-z0-9]/);
    expect(baseline).not.toMatch(/bxntqggkfwnhcczsbqtj|jdglfvwdnkjnraqdxuuj/);
    expect(baseline).toMatch(/^-- 격리 환경 baseline: .*스키마-only/m);
  });
  it("마이그레이션 순서: 기본 권한 초기화 → public baseline → Storage 정책 → 운영 보안 수정(accounts INSERT 보호, PR #245)(파일명 순서가 곧 적용 순서)", () => {
    expect(migrations).toEqual(["20261026235900_reset_default_privileges.sql", "20261027000000_baseline_public_schema.sql", "20261027000001_baseline_storage_policies.sql", "20261030000000_accounts_insert_privileged_columns.sql"]);
    expect(read("migrations/20261026235900_reset_default_privileges.sql")).toMatch(/revoke all on functions from anon, authenticated, service_role/);
  });
  it("카탈로그 시드는 저장소 루트 SQL 에서 재생성한 결과와 같다(드리프트 방지) — 운영/공유 DEV 접속 없음", () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seed-")), "seed.sql");
    execFileSync("node", ["scripts/isolated/extractCatalogSeed.mjs", out], { cwd: root, stdio: "ignore" });
    expect(fs.readFileSync(out, "utf8")).toBe(read("seed.sql"));
    const seed = read("seed.sql");
    expect(seed).toContain("set session_replication_role = replica;"); expect(seed).toContain("set session_replication_role = origin;");
    expect(seed).not.toMatch(/\binsert into (public\.)?(accounts|profiles|centers|memberships|payments|orders|reservations)\b/i);   // 회원·결제 등 사용자 데이터 테이블은 시드하지 않는다
  });
  it("stack 설정: 격리 전용 project_id·포트, 이메일 확인 OFF, 외부 발송 자격증명 없음(OTP 우회 접두사만), 버킷 3개", () => {
    const cfg = read("config.toml");
    expect(cfg).toMatch(/^project_id = "mwhabit-isolated"/m);
    expect(cfg).toMatch(/\[api\][\s\S]*?port = 54421/); expect(cfg).toMatch(/\[db\][\s\S]*?port = 54422/);
    expect(cfg).toMatch(/\[auth\.email\][\s\S]*?enable_confirmations = false/);
    expect(cfg).toMatch(/PHONE_OTP_TEST_BYPASS_PREFIX = "0100000"/);
    const active = cfg.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");   // 주석 처리된 기본 예시 제외
    expect(active).not.toMatch(/ALIGO/i);
    for (const m of active.matchAll(/^\s*(?:[a-z_]*api_key|[a-z_]*auth_token|[a-z_]*secret(?:_key)?)\s*=\s*"([^"]*)"/gim)) expect(m[1], "자격증명 값은 env(...) 자리표시자뿐이어야 한다(리터럴 금지)").toMatch(/^env\(/);
    expect(active).not.toMatch(/\[auth\.sms\.(twilio|messagebird|textlocal|vonage)(_verify)?\]\s*\nenabled = true/);   // 외부 SMS 공급자 비활성
    expect([...cfg.matchAll(/^\[storage\.buckets\.([a-z-]+)\]/gm)].map((m) => m[1]).sort()).toEqual(["alimtalk-images", "avatars", "business-licenses"]);
  });
  it("functions 는 저장소의 supabase/functions 를 가리키는 심볼릭 링크(함수 소스 복제 없음)", () => {
    expect(fs.lstatSync(path.join(dir, "functions")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dir, "functions"))).toBe("../../supabase/functions");
  });
});
