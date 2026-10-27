// 로컬 격리 스택 전용: accounts.nicepay_review_access 보호(INSERT·UPDATE·upsert·삭제 후 재생성) 검증.
//  [실제 인증·REST] Auth signUp → 앱 가입 화면(app/login/page.tsx)과 같은 페이로드로 PostgREST INSERT. [DB 최소 재현] 같은 INSERT 를 psql(set local role authenticated + JWT claims)로.
// 사용: ISO_ENV_FILE=… node accountsFlagGuard.mjs <결과.json> [라벨]  — 보호 전 스키마에서는 "결함 재현"(DENY 가 아니라 CREATED), 보호 후에는 모두 기대값이어야 한다.
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const OUT = process.argv[2], LABEL = process.argv[3] ?? "";
const res = []; const rec = (id, group, name, expected, actual, extra = "") => { const pass = expected === actual; res.push({ id, group, name, expected, actual, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} [${group}] ${name} — 기대 ${expected} / 실제 ${actual}${extra ? " · " + extra : ""}`); };
const pwd = () => crypto.randomBytes(12).toString("base64url") + "Aa1!"; const tag = crypto.randomBytes(3).toString("hex");
const sql = (q) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-c", q], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const errOf = (e) => (e ? (e.message ?? String(e)).slice(0, 60) : "");
async function signup(label) { const c = createClient(url, anon, { auth: { persistSession: false } }); const email = `ci-${label}-${tag}@isolated.test`, password = pwd(); const { data, error } = await c.auth.signUp({ email, password }); if (error || !data.user) throw new Error("signUp 실패 " + error?.message); if (!data.session) await c.auth.signInWithPassword({ email, password }); return { c, uid: data.user.id, email, password }; }
// 앱 가입 화면과 같은 INSERT 페이로드(app/login/page.tsx handleSignup) — 이 컬럼은 보내지 않는다
const appPayload = (uid, name) => ({ auth_id: uid, name, phone: null, address: null, is_member: true, is_manager: false, marketing_consent: false, marketing_consent_at: null });
const flagOf = async (uid) => (await svc.from("accounts").select("id,nicepay_review_access,pg_checkout_override,is_platform_admin").eq("auth_id", uid).maybeSingle()).data;
const outcome = (r) => (r.error ? "DENIED" : "CREATED");

console.log(`== 라벨: ${LABEL} ==`);
// ── 실제 인증·REST ──
const u1 = await signup("normal"); let r = await u1.c.from("accounts").insert(appPayload(u1.uid, "정상가입")).select("id").single();
rec("R1", "실제 인증·REST", "정상 가입(앱 페이로드, 권한 컬럼 미지정)", "CREATED", outcome(r), errOf(r.error)); const a1 = await flagOf(u1.uid); rec("R1b", "실제 인증·REST", "정상 가입 계정의 권한 값은 false", "false", String(a1?.nicepay_review_access));
const u2 = await signup("true"); r = await u2.c.from("accounts").insert({ ...appPayload(u2.uid, "권한지정시도"), nicepay_review_access: true }).select("id").single();
rec("R2", "실제 인증·REST", "가입 시 nicepay_review_access=true 지정", "DENIED", outcome(r), errOf(r.error)); rec("R2b", "실제 인증·REST", "거부 후 계정 행이 남지 않음", "none", (await flagOf(u2.uid)) ? "exists" : "none");
if ((await flagOf(u2.uid))?.nicepay_review_access) await svc.from("accounts").delete().eq("auth_id", u2.uid);
const u3 = await signup("false"); r = await u3.c.from("accounts").insert({ ...appPayload(u3.uid, "명시false"), nicepay_review_access: false }).select("id").single(); rec("R3", "실제 인증·REST", "가입 시 nicepay_review_access=false 명시", "CREATED", outcome(r), errOf(r.error));
r = await u1.c.from("accounts").update({ nicepay_review_access: true }).eq("auth_id", u1.uid).select("id"); rec("R4", "실제 인증·REST", "기존 계정이 본인 권한을 true 로 수정", "DENIED", r.error ? "DENIED" : (r.data?.length ? "CREATED" : "0ROWS"), errOf(r.error)); rec("R4b", "실제 인증·REST", "수정 시도 후 값은 false 유지", "false", String((await flagOf(u1.uid))?.nicepay_review_access));
const u4 = await signup("upsert-new"); r = await u4.c.from("accounts").upsert({ ...appPayload(u4.uid, "upsert신규"), nicepay_review_access: true }, { onConflict: "auth_id" }).select("id"); rec("R5", "실제 인증·REST", "upsert(신규, true)", "DENIED", outcome(r), errOf(r.error)); rec("R5b", "실제 인증·REST", "거부 후 계정 행 없음", "none", (await flagOf(u4.uid)) ? "exists" : "none");
r = await u1.c.from("accounts").upsert({ ...appPayload(u1.uid, "정상가입"), nicepay_review_access: true }, { onConflict: "auth_id" }).select("id"); rec("R6", "실제 인증·REST", "upsert(기존 행, ON CONFLICT DO UPDATE 로 true)", "DENIED", outcome(r), errOf(r.error)); rec("R6b", "실제 인증·REST", "값은 false 유지", "false", String((await flagOf(u1.uid))?.nicepay_review_access));
r = await u1.c.from("accounts").upsert({ ...appPayload(u1.uid, "이름변경"), nicepay_review_access: false }, { onConflict: "auth_id" }).select("id"); rec("R6c", "실제 인증·REST", "upsert(기존 행, 권한은 false — 일반 갱신)", "CREATED", outcome(r), errOf(r.error));
const u5 = await signup("recreate"); await u5.c.from("accounts").insert(appPayload(u5.uid, "삭제후재생성")); const del = await u5.c.from("accounts").delete().eq("auth_id", u5.uid).select("id");
r = await u5.c.from("accounts").insert({ ...appPayload(u5.uid, "재생성"), nicepay_review_access: true }).select("id").single(); rec("R7", "실제 인증·REST", "본인 계정 삭제 후 true 로 재생성", "DENIED", outcome(r), `삭제행 ${del.data?.length ?? 0}건 ${errOf(r.error)}`);
r = await u5.c.from("accounts").insert(appPayload(u5.uid, "재생성정상")).select("id").single(); rec("R7b", "실제 인증·REST", "삭제 후 정상(false) 재생성", "CREATED", outcome(r), errOf(r.error));
// ── 승인된 운영자·서버 경로 ──
const adm = await signup("admin"); await svc.from("accounts").insert({ ...appPayload(adm.uid, "관리자(로컬)"), is_platform_admin: true }); await adm.c.auth.signInWithPassword({ email: adm.email, password: adm.password });
r = await adm.c.from("accounts").update({ nicepay_review_access: true }).eq("auth_id", adm.uid).select("id"); rec("R8", "운영자·서버", "플랫폼 관리자가 본인 계정 권한 부여(REST — 승인된 운영자 분기)", "CREATED", r.error ? "DENIED" : (r.data?.length ? "CREATED" : "0ROWS"), errOf(r.error)); rec("R8b", "운영자·서버", "값이 true 로 반영", "true", String((await flagOf(adm.uid))?.nicepay_review_access));
r = await adm.c.from("accounts").update({ nicepay_review_access: false }).eq("auth_id", adm.uid).select("id"); rec("R8c", "운영자·서버", "플랫폼 관리자가 권한 해제", "CREATED", r.error ? "DENIED" : (r.data?.length ? "CREATED" : "0ROWS"), errOf(r.error));
r = await adm.c.from("accounts").update({ nicepay_review_access: true }).eq("auth_id", u1.uid).select("id"); rec("R8d", "운영자·서버", "플랫폼 관리자가 다른 계정을 REST 로 수정 — 기존 RLS(본인 계정 수정)가 0행 처리(이번 변경과 무관, 부여는 SQL Editor·서버 경로)", "0ROWS", r.error ? "DENIED" : (r.data?.length ? "CREATED" : "0ROWS"), errOf(r.error));
const uS = await signup("server"); r = await svc.from("accounts").insert({ ...appPayload(uS.uid, "서버생성"), nicepay_review_access: true }).select("id").single(); rec("R9", "운영자·서버", "서버(service_role)가 true 로 계정 생성", "CREATED", outcome(r), errOf(r.error));
r = await svc.from("accounts").update({ nicepay_review_access: false }).eq("auth_id", uS.uid).select("id"); rec("R9b", "운영자·서버", "서버가 권한 해제", "CREATED", r.error ? "DENIED" : (r.data?.length ? "CREATED" : "0ROWS"), errOf(r.error));
let sqlEd = "ERR"; try { sql(`update accounts set nicepay_review_access = true where auth_id = '${u1.uid}'`); sqlEd = (await flagOf(u1.uid))?.nicepay_review_access ? "CREATED" : "NOCHANGE"; sql(`update accounts set nicepay_review_access = false where auth_id = '${u1.uid}'`); } catch (e) { sqlEd = "DENIED"; } rec("R10", "운영자·서버", "SQL Editor(postgres, auth.uid() is null) 경로로 부여", "CREATED", sqlEd);
// ── 기존 보호 유지 ──
r = await u1.c.from("accounts").update({ pg_checkout_override: true }).eq("auth_id", u1.uid).select("id"); rec("R11", "기존 보호", "본인이 pg_checkout_override(토스) 를 true 로 UPDATE", "DENIED", r.error ? "DENIED" : "CREATED", errOf(r.error));
r = await u1.c.from("accounts").update({ is_platform_admin: true }).eq("auth_id", u1.uid).select("id"); rec("R12", "기존 보호", "본인이 is_platform_admin 을 true 로 UPDATE", "DENIED", r.error ? "DENIED" : "CREATED", errOf(r.error));
// ── DB 최소 재현(psql, 인증된 일반 사용자 역할) ──
const uD = await signup("dbonly");
const dbRun = (insertSql) => { try { execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", `begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${uD.uid}","role":"authenticated"}', true); ${insertSql}; rollback;`], { stdio: ["pipe", "pipe", "pipe"] }); return "CREATED"; } catch (e) { return /운영자만/.test(String(e.stderr)) ? "DENIED" : "ERR:" + String(e.stderr).slice(0, 80); } };
const dbTry = (flag) => dbRun(`insert into accounts(auth_id, name, nicepay_review_access) values ('${uD.uid}', 'db-min', ${flag})`);
rec("D1", "DB 최소 재현", "authenticated 역할 + JWT sub 로 INSERT(true)", "DENIED", dbTry("true")); rec("D2", "DB 최소 재현", "같은 조건으로 INSERT(false)", "CREATED", dbTry("false")); rec("D3", "DB 최소 재현", "같은 조건으로 INSERT(기본값, 컬럼 생략)", "CREATED", dbRun(`insert into accounts(auth_id, name) values ('${uD.uid}', 'db-min')`));
// ── 참고: 같은 방식으로 기존 권한 컬럼(INSERT 보호 없음)을 가입 시점에 지정할 수 있는지(이 작업 범위 밖 — 재현만) ──
{ const vic = await flagOf(u1.uid); const x = await signup("hole-merge"); r = await x.c.from("accounts").insert({ ...appPayload(x.uid, "참고시험"), merged_into: vic.id }).select("id").single(); let eff = ""; if (!r.error) { const m = await x.c.rpc("my_account_id"); eff = "my_account_id()==다른 계정 id: " + (m.data === vic.id); } console.log(`INFO 참고 [merged_into] 가입 시점 다른 계정 id 지정 → ${outcome(r)} ${eff}`); res.push({ id: "INFO-merged_into", group: "참고(범위 밖)", name: "가입 시 merged_into=다른 계정 id", actual: outcome(r), extra: eff, pass: null }); await svc.from("accounts").delete().eq("auth_id", x.uid); }
for (const col of ["pg_checkout_override", "is_platform_admin"]) {
  const x = await signup("hole-" + col.slice(0, 5)); r = await x.c.from("accounts").insert({ ...appPayload(x.uid, "참고시험"), [col]: true }).select("id").single();
  let eff = ""; if (!r.error && col === "is_platform_admin") { const a = await x.c.rpc("is_platform_admin"); eff = "is_platform_admin()=" + a.data; }
  console.log(`INFO 참고 [${col}] 가입 시점 지정 → ${outcome(r)} ${eff}`); res.push({ id: "INFO-" + col, group: "참고(범위 밖)", name: `가입 시 ${col}=true 지정`, actual: outcome(r), extra: eff, pass: null });
  await svc.from("accounts").delete().eq("auth_id", x.uid);
}
const ok = res.filter((x) => x.pass !== null); console.log(`\n${ok.filter((x) => x.pass).length}/${ok.length} PASS (${LABEL})`); fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, results: res }, null, 1));
for (const u of [u1, u2, u3, u4, u5, adm, uS, uD]) await svc.from("accounts").delete().eq("auth_id", u.uid);
process.exit(0);
