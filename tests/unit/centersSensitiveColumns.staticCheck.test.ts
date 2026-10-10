// centers 민감 컬럼(business_number / business_license_url / reject_reason) 차단의 정적 계약.
// 1) 클라이언트가 centers 테이블에서 '*' 또는 민감 컬럼을 select하면 컬럼 권한 적용 후 42501로 깨진다 → 코드에 없어야 한다.
// 2) SQL 1/2는 분리돼 있고 각각 독립 트랜잭션이며 필요한 보안 속성을 갖는다.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const SENSITIVE = /business_number|business_license_url|reject_reason/;
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const code = (s: string) => s.replace(/^\s*--.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, n); const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out); else if (/\.(ts|tsx)$/.test(n)) out.push(rel);
  }
  return out;
}

describe("앱 코드: centers 테이블 select에 '*'/민감 컬럼이 없다", () => {
  const files = [...walk("app"), ...walk("lib")];
  it(".from(\"centers\") 직접 select", () => {
    for (const f of files) {
      const s = read(f);
      for (const m of s.matchAll(/\.from\(\s*["']centers["']\s*\)\s*\.select\(\s*([`"'])([\s\S]*?)\1/g)) {
        expect(m[2], `${f}: centers 직접 select에 '*'`).not.toMatch(/\*/);
        expect(m[2], `${f}: centers 직접 select에 민감 컬럼`).not.toMatch(SENSITIVE);
      }
    }
  });
  it("다른 테이블을 통한 centers(...) / centers!inner(...) embed", () => {
    for (const f of files) {
      for (const m of read(f).matchAll(/\bcenters(?:!\w+)?\(([^()]*)\)/g)) {
        expect(m[1], `${f}: centers embed에 '*'`).not.toMatch(/\*/);
        expect(m[1], `${f}: centers embed에 민감 컬럼`).not.toMatch(SENSITIVE);
      }
    }
  });
  it("lib/admin.ts는 센터 목록을 RPC로만 읽고 centers 테이블 select에 민감 컬럼을 쓰지 않는다", () => {
    const s = read("lib/admin.ts");
    expect(s).toMatch(/\.rpc\(\s*"admin_list_centers"/);
    expect(s).not.toMatch(/\.from\(\s*"centers"\s*\)\s*\.select/);
  });
});

describe("SQL 계약", () => {
  const rpc = code(read("add_admin_list_centers_rpc_20261009.sql"));
  const priv = code(read("fix_centers_sensitive_column_privileges_20261009.sql"));
  it("SQL 1(RPC)과 SQL 2(권한)는 서로 다른 파일이고 각각 begin/commit 한 쌍", () => {
    for (const s of [rpc, priv]) { expect(s.match(/^\s*begin;/gim)?.length).toBe(1); expect(s.match(/^\s*commit;/gim)?.length).toBe(1); }
    expect(rpc).not.toMatch(/\bgrant select\b|revoke select/i);
    expect(priv).not.toMatch(/create or replace function public\.admin_list_centers/i);
  });
  it("RPC: security definer + search_path 고정 + 관리자 검증이 본문 첫 단계 + EXECUTE 최소화", () => {
    expect(rpc).toMatch(/security definer/i);
    expect(rpc).toMatch(/set search_path = public, pg_temp/i);
    expect(rpc).toMatch(/if public\.is_platform_admin\(\) is not true then/i);
    expect(rpc).not.toMatch(/if not public\.is_platform_admin\(\)/i);
    expect(rpc.indexOf("public.is_platform_admin()")).toBeLessThan(rpc.indexOf("return query"));
    expect(rpc).toMatch(/errcode = '42501'/);
    expect(rpc).toMatch(/revoke all on function public\.admin_list_centers\(text\) from public, anon, authenticated;/i);
    expect(rpc).toMatch(/grant execute on function public\.admin_list_centers\(text\) to authenticated;/i);
    expect(rpc).not.toMatch(/\bexecute\s+format|\bexecute\s+['"]/i);   // 동적 SQL 없음
  });
  it("권한 SQL: 테이블 SELECT 회수 → 컬럼 단위 grant, 민감 3개 제외, RLS/INSERT/UPDATE는 건드리지 않음", () => {
    expect(priv).toMatch(/revoke select on table public\.centers from anon, authenticated;/i);
    expect(priv).toMatch(/v_sensitive text\[\] := array\['business_number', 'business_license_url', 'reject_reason'\];/);
    expect(priv).toMatch(/v_public\s+text\[\] := array\[/);   // 명시적 허용 목록(동적 '전체 - 민감' 방식 아님)
    expect(priv).toMatch(/grant select \(%I\) on table public\.centers to anon, authenticated/i);
    expect(priv).toMatch(/컬럼이 예상과 다릅니다/);   // 예상 밖/누락 컬럼 시 중단
    expect(priv).not.toMatch(/attname not in/i);
    expect(priv).not.toMatch(/create policy|drop policy|alter table|\b(insert|update|delete)\b[^;]*\bcenters\b|grant (all|insert|update)/i);
  });
  it("verify SQL은 SELECT만 포함, rollback은 각각 복구 한 가지만", () => {
    for (const f of ["verify_add_admin_list_centers_rpc_20261009.sql", "verify_fix_centers_sensitive_column_privileges_20261009.sql"]) {
      expect(code(read(f)).replace(/'[^']*'/g, "''")).not.toMatch(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);   // 권한 이름 문자열 리터럴('update' 등)은 제외
    }
    expect(code(read("rollback_fix_centers_sensitive_column_privileges_20261009.sql"))).toMatch(/grant select on table public\.centers to anon, authenticated;/i);
    expect(code(read("rollback_add_admin_list_centers_rpc_20261009.sql"))).toMatch(/drop function if exists public\.admin_list_centers\(text\);/i);
  });
});
