// accounts INSERT 특권 컬럼 보호 — 일회용 로컬 Supabase(실제 Auth + PostgREST + Postgres) 검증. 모든 항목은 "기대값 단언"이며 하나라도 어긋나면 종료 코드 1 이다(INFO·무시 항목 없음).
// 사용: ISO_ENV_FILE=<bootstrapEphemeral 가 쓴 환경 파일> node scripts/security/accountsInsertGuard.verify.mjs [결과.json]
// 모든 요청 전에 일회용 로컬 스택인지 검사한다(운영·공유 DEV·호스팅 주소·키는 거부). 이 스크립트는 운영 DB 를 절대 대상으로 하지 않는다.
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./lib/assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const results = []; let failures = 0;
function expectEq(id, name, expected, actual, extra = "") { const pass = expected === actual; if (!pass) failures++; results.push({ id, name, expected, actual, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${expected} / 실제 ${actual}${extra ? " · " + extra : ""}`); }
const pwd = () => crypto.randomBytes(12).toString("base64url") + "Aa1!"; const tag = crypto.randomBytes(3).toString("hex");
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const errOf = (e) => (e ? String(e.message ?? e).slice(0, 70) : "");
const created = []; // 정리용 auth id
async function signup(label) { const c = createClient(url, anon, { auth: { persistSession: false } }); const email = `sec-${label}-${tag}@isolated.test`, password = pwd(); const { data, error } = await c.auth.signUp({ email, password }); if (error || !data.user) throw new Error("signUp 실패: " + error?.message); if (!data.session) await c.auth.signInWithPassword({ email, password }); created.push(data.user.id); return { c, uid: data.user.id }; }
const appPayload = (uid, name) => ({ auth_id: uid, name, phone: null, address: null, is_member: true, is_manager: false, marketing_consent: false, marketing_consent_at: null });   // app/login/page.tsx handleSignup 과 같은 페이로드
const row = async (uid) => (await svc.from("accounts").select("id,is_platform_admin,pg_checkout_override,merged_into,name").eq("auth_id", uid).maybeSingle()).data;
const ins = async (cl, payload) => { const r = await cl.from("accounts").insert(payload).select("id").single(); return r.error ? "DENIED" : "CREATED"; };

// 피해자(다른 계정) — 정상 가입
const victim = await signup("victim"); const vIns = await victim.c.from("accounts").insert(appPayload(victim.uid, "피해자")).select("id").single(); if (vIns.error) throw new Error("피해자 가입 실패 " + vIns.error.message); const victimAccountId = vIns.data.id;
const attack = [["is_platform_admin", true], ["pg_checkout_override", true], ["merged_into", victimAccountId]];

// ── A. 정상 흐름 유지 ──
const n1 = await signup("normal"); let r = await n1.c.from("accounts").insert(appPayload(n1.uid, "정상가입")).select("id").single();
expectEq("A1", "정상 가입(앱 페이로드)", "CREATED", r.error ? "DENIED" : "CREATED", errOf(r.error)); const a1 = await row(n1.uid);
expectEq("A1b", "정상 가입 계정의 특권 값은 모두 기본값(false/false/null)", "false/false/null", `${a1?.is_platform_admin}/${a1?.pg_checkout_override}/${a1?.merged_into}`);
const n2 = await signup("explicit-false"); expectEq("A2", "특권 컬럼을 false/null 로 명시한 가입", "CREATED", await ins(n2.c, { ...appPayload(n2.uid, "명시기본값"), is_platform_admin: false, pg_checkout_override: false, merged_into: null }));
r = await n1.c.from("accounts").update({ name: "이름변경", address: "서울", marketing_consent: true }).eq("auth_id", n1.uid).select("id"); expectEq("A3", "기존 계정의 일반 정보 갱신(이름·주소·마케팅 동의)", "UPDATED", r.error ? "DENIED" : (r.data?.length ? "UPDATED" : "0ROWS"), errOf(r.error));
r = await n1.c.from("accounts").upsert({ ...appPayload(n1.uid, "upsert갱신") }, { onConflict: "auth_id" }).select("id"); expectEq("A4", "기존 계정 upsert(일반 갱신)", "UPDATED", r.error ? "DENIED" : (r.data?.length ? "UPDATED" : "0ROWS"), errOf(r.error));
// 정상 계정 연동: 코드 발급(n1) → 연동(n3 = 합쳐질 계정)
const n3 = await signup("linker"); await n3.c.from("accounts").insert(appPayload(n3.uid, "연동대상"));
const code = await n1.c.rpc("create_account_link_code"); let linkResult = "NO_CODE";
if (!code.error && code.data) { const lk = await n3.c.rpc("link_accounts_by_code", { p_code: code.data }); linkResult = lk.error ? "ERR:" + errOf(lk.error) : "LINKED"; } else linkResult = "ERR:" + errOf(code.error);
expectEq("A5", "정상 계정 연동(create_account_link_code → link_accounts_by_code)", "LINKED", linkResult); expectEq("A5b", "연동 후 합쳐진 계정의 merged_into 가 코드 발급 계정", n1.uid && (await row(n1.uid))?.id, (await row(n3.uid))?.merged_into);
// ── B. 승인된 서버 경로 유지 ──
for (const [col, val] of attack) { const s = await signup("server-" + col.slice(0, 4)); const rr = await svc.from("accounts").insert({ ...appPayload(s.uid, "서버생성"), [col]: val }).select("id").single(); expectEq("B-" + col, `서버(service_role)가 ${col} 지정해 생성`, "CREATED", rr.error ? "DENIED" : "CREATED", errOf(rr.error)); }
{ const s = await signup("sqleditor"); let o = "CREATED"; try { psql(`insert into accounts(auth_id, name, is_platform_admin, pg_checkout_override, merged_into) values ('${s.uid}', 'sql-editor', true, true, '${victimAccountId}')`); } catch (e) { o = "DENIED"; } expectEq("B-sql", "SQL Editor(postgres, auth.uid() is null)가 특권 값으로 생성", "CREATED", o); }
// ── C. 차단 경로: 직접 INSERT / 신규 upsert / 삭제 후 재생성 / 기존 행 갱신 ──
for (const [col, val] of attack) {
  const u = await signup("ins-" + col.slice(0, 4)); expectEq("C-ins-" + col, `직접 INSERT 로 ${col} 지정`, "DENIED", await ins(u.c, { ...appPayload(u.uid, "시도"), [col]: val })); expectEq("C-ins-row-" + col, "거부 후 계정 행이 없다", "none", (await row(u.uid)) ? "exists" : "none");
  const up = await signup("ups-" + col.slice(0, 4)); r = await up.c.from("accounts").upsert({ ...appPayload(up.uid, "시도"), [col]: val }, { onConflict: "auth_id" }).select("id"); expectEq("C-upsert-" + col, `신규 upsert 로 ${col} 지정`, "DENIED", r.error ? "DENIED" : "CREATED", errOf(r.error)); expectEq("C-upsert-row-" + col, "거부 후 계정 행이 없다", "none", (await row(up.uid)) ? "exists" : "none");
  const rc = await signup("rec-" + col.slice(0, 4)); await rc.c.from("accounts").insert(appPayload(rc.uid, "삭제될 계정")); const del = await rc.c.from("accounts").delete().eq("auth_id", rc.uid).select("id"); expectEq("C-del-" + col, "본인 계정 삭제(사전 조건)", "1", String(del.data?.length ?? 0));
  expectEq("C-recreate-" + col, `삭제 후 ${col} 지정 재생성`, "DENIED", await ins(rc.c, { ...appPayload(rc.uid, "재생성시도"), [col]: val })); expectEq("C-recreate-ok-" + col, "삭제 후 정상 재생성은 가능", "CREATED", await ins(rc.c, appPayload(rc.uid, "정상재생성")));
  const ex = await signup("upd-" + col.slice(0, 4)); await ex.c.from("accounts").insert(appPayload(ex.uid, "기존계정")); r = await ex.c.from("accounts").update({ [col]: val }).eq("auth_id", ex.uid).select("id"); expectEq("C-update-" + col, `기존 계정이 ${col} 를 UPDATE (기존 가드 유지)`, "DENIED", r.error ? "DENIED" : (r.data?.length ? "UPDATED" : "0ROWS"), errOf(r.error));
  r = await ex.c.from("accounts").upsert({ ...appPayload(ex.uid, "기존계정"), [col]: val }, { onConflict: "auth_id" }).select("id"); expectEq("C-upsert-existing-" + col, `기존 행 ON CONFLICT DO UPDATE 로 ${col}`, "DENIED", r.error ? "DENIED" : "UPDATED", errOf(r.error)); const after = await row(ex.uid); expectEq("C-existing-unchanged-" + col, "시도 후 값 불변", "false/false/null", `${after?.is_platform_admin}/${after?.pg_checkout_override}/${after?.merged_into}`);
}
{ const u = await signup("eff-admin"); await ins(u.c, { ...appPayload(u.uid, "시도"), is_platform_admin: true }); const e = await u.c.rpc("is_platform_admin"); expectEq("C-effect-admin", "시도 후 is_platform_admin() RPC 는 false", "false", String(e.data)); }
{ const u = await signup("eff-merge"); await ins(u.c, { ...appPayload(u.uid, "시도"), merged_into: victimAccountId }); const m = await u.c.rpc("my_account_id"); expectEq("C-effect-merge", "시도 후 my_account_id() 는 피해자 계정이 아니다", "false", String(m.data === victimAccountId)); }
// ── D. DB 최소 재현(psql: authenticated 역할 + JWT claims) ──
const dbu = await signup("dbonly");
const dbRun = (cols, vals) => { try { psql(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${dbu.uid}","role":"authenticated"}', true); insert into accounts(auth_id, name${cols}) values ('${dbu.uid}', 'db-min'${vals}); rollback;`); return "CREATED"; } catch (e) { return /운영자만|merged_into/.test(String(e.stderr)) ? "DENIED" : "ERR:" + String(e.stderr).slice(0, 80); } };
expectEq("D1", "psql: INSERT(기본값)", "CREATED", dbRun("", "")); expectEq("D2", "psql: INSERT(is_platform_admin=true)", "DENIED", dbRun(", is_platform_admin", ", true")); expectEq("D3", "psql: INSERT(pg_checkout_override=true)", "DENIED", dbRun(", pg_checkout_override", ", true")); expectEq("D4", "psql: INSERT(merged_into=다른 계정)", "DENIED", dbRun(", merged_into", `, '${victimAccountId}'`));
// ── 정리 ──
for (const id of created) { await svc.from("accounts").delete().eq("auth_id", id); }
console.log(`\n${results.filter((x) => x.pass).length}/${results.length} PASS, ${failures} FAIL`);
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ failures, results }, null, 1));
process.exit(failures ? 1 : 0);
