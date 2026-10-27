#!/usr/bin/env node
/*
  격리 baseline 이 공유 DEV(mwhabit-ci-dev)의 "구조·권한"과 같은지 대조한다(개발자 도구 — CI 에서는 돌지 않는다: DEV 읽기 접근 필요).
  비교 대상은 구조와 권한 메타데이터뿐이다(ACL 이 NULL 이면 acldefault 로 풀어 비교: NULL 은 '기본 권한'과 같은 뜻이다; 함수 ACL, 테이블/뷰/시퀀스 ACL, RLS 켜짐 여부, 정책, 컬럼 정의, storage 버킷/정책). 행 데이터는 읽지 않는다.
  사용: node scripts/isolated/verifyBaselineParity.mjs   (로컬 스택 `supabase start --workdir isolated-supabase` 실행 중 + `supabase login` 상태)
  DEV 조회는 빈 임시 디렉터리에서 `--linked --project-ref` 로 하므로 저장소의 Production link 를 쓰지 않는다.
*/
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const DEV_REF = "jdglfvwdnkjnraqdxuuj";
// 격리 스택에만 있는 "의도적 추가"(운영에는 적용됐지만 공유 DEV baseline 에는 아직 없는 보안 수정). 차이 계산에서 제외하고 따로 출력한다. DEV 에도 적용돼 baseline 을 다시 덤프하면 이 목록에서 지운다.
const KNOWN_ISOLATED_ONLY = [{ query: "functions", match: "enforce_accounts_insert_privileged_columns", why: "accounts INSERT 특권 컬럼 보호(PR #245, 운영 적용) — isolated-supabase/supabase/migrations/20261030000000_accounts_insert_privileged_columns.sql" }];
const QUERIES = {
  functions: "select p.oid::regprocedure::text as sig, coalesce(p.proacl, acldefault('f', p.proowner))::text as acl, p.prosecdef as secdef from pg_proc p where p.pronamespace='public'::regnamespace order by 1",
  relations: "select c.relname, c.relkind::text as kind, coalesce(c.relacl, (case when c.relkind='S' then acldefault('s', c.relowner) else acldefault('r', c.relowner) end))::text as acl, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','S','p') order by 1",
  policies: "select tablename, policyname, cmd, roles::text as roles, coalesce(qual,'') as qual, coalesce(with_check,'') as with_check from pg_policies where schemaname='public' order by 1,2",
  columns: "select table_name, column_name, data_type, is_nullable, coalesce(column_default,'') as dflt from information_schema.columns where table_schema='public' order by 1,column_name",
  storage_policies: "select policyname, cmd, roles::text as roles, coalesce(qual,'') as qual, coalesce(with_check,'') as with_check from pg_policies where schemaname='storage' and tablename='objects' order by 1",
  buckets: "select id, public from storage.buckets order by 1",
};
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
const dev = (sql) => { const out = execFileSync("supabase", ["db", "query", "--linked", "--project-ref", DEV_REF, sql], { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 }); return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).rows; };
const local = (sql) => JSON.parse(execFileSync("docker", ["exec", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-tAc", `select coalesce(json_agg(t),'[]') from (${sql}) t`], { encoding: "utf8", maxBuffer: 1 << 28 }).trim());
const norm = (rows) => rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort()))).sort();
let diffs = 0;
for (const [name, sql] of Object.entries(QUERIES)) {
  const a = new Set(norm(dev(sql))), b = new Set(norm(local(sql)));
  const known = KNOWN_ISOLATED_ONLY.filter((k) => k.query === name);
  const onlyDev = [...a].filter((x) => !b.has(x)), onlyLocalAll = [...b].filter((x) => !a.has(x));
  const onlyLocal = onlyLocalAll.filter((x) => !known.some((k) => x.includes(k.match)));
  for (const k of known) { const n = onlyLocalAll.length - onlyLocal.length; if (n) console.log(`   (알려진 의도적 추가 ${n}건 제외: ${k.why})`); }
  diffs += onlyDev.length + onlyLocal.length;
  console.log(`${name}: DEV ${a.size} · 격리 ${b.size} · DEV 에만 ${onlyDev.length} · 격리에만 ${onlyLocal.length}`);
  for (const x of onlyDev.slice(0, 5)) console.log("   DEV  : " + x.slice(0, 220));
  for (const x of onlyLocal.slice(0, 5)) console.log("   격리 : " + x.slice(0, 220));
}
fs.rmSync(scratch, { recursive: true, force: true });
console.log(diffs === 0 ? "PARITY: 구조·권한 차이 0" : `PARITY: 차이 ${diffs}건 — 위 목록을 검토`);
process.exit(diffs === 0 ? 0 : 1);
