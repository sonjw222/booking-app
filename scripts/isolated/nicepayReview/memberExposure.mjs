// 로컬 격리 스택 전용: 심사 종료·P2 롤백 시 "심사 센터에 등록된 일반 회원" 때문에 심사 센터가 노출되는지 실제 인증 컨텍스트로 검증한다. 단언(어긋나면 종료 코드 1).
// 사용: ISO_ENV_FILE=… [ROLLBACK_FILE=이전버전.sql] node memberExposure.mjs <결과.json> [라벨]
//  ROLLBACK_FILE 로 수정 전 롤백 SQL 을 지정하면 결함 재현(BEFORE) 용도로 쓴다 — 이때 일부 단언은 "노출됨"을 기대하지 않고 결과만 기록한다(EXPECT_DEFECT=1).
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const OUT = process.argv[2], LABEL = process.argv[3] ?? ""; const RB = process.env.ROLLBACK_FILE ?? "rollback_add_nicepay_review_center_isolation_20261028.sql"; const DEFECT = process.env.EXPECT_DEFECT === "1";
const psqlRaw = (args, input) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const q = (sql) => psqlRaw(["-v", "ON_ERROR_STOP=1", "-c", sql]);
const runFile = (f, mutate) => { let t = fs.readFileSync(f, "utf8"); if (mutate) t = mutate(t); try { return { ok: true, out: psqlRaw(["-v", "ON_ERROR_STOP=1"], t) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };
const res = []; let failures = 0;
const rec = (id, name, expected, actual, extra = "") => { const pass = String(expected) === String(actual); if (!pass) failures++; res.push({ id, name, expected, actual, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${expected} / 실제 ${actual}${extra ? " · " + String(extra).slice(0, 200).replace(/\n/g, " ") : ""}`); };
const note = (id, name, actual, extra = "") => { res.push({ id, name, actual, pass: null, extra }); console.log(`INFO ${id} ${name} — ${actual}${extra ? " · " + String(extra).slice(0, 160) : ""}`); };
const login = async (e, p) => { const c = createClient(url, anon, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email: e, password: p }); if (error) throw new Error(error.message); return c; };
const tag = crypto.randomBytes(3).toString("hex");
// 플랫폼 관리자 계정(로컬 전용)
const admEmail = `ci-admin-${tag}@isolated.test`, admPw = crypto.randomBytes(12).toString("base64url") + "Aa1!";
{ const c = createClient(url, anon, { auth: { persistSession: false } }); const { data, error } = await c.auth.signUp({ email: admEmail, password: admPw }); if (error) throw new Error(error.message);
  await svc.from("accounts").insert({ auth_id: data.user.id, name: "관리자(로컬)", is_member: true, is_manager: false, is_platform_admin: true, marketing_consent: false }); }
const WHO = { "비회원(anon)": null, "일반회원A": [env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD], "NICEPAY 심사관B": [env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD], "토스 심사관T": [env.TOSS_REVIEWER_EMAIL, env.TOSS_REVIEWER_PASSWORD], "심사 센터 매니저": [env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD], "운영 센터 매니저": [env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD], "토스센터 매니저S(is_member=false)": [env.SONJW_LIKE_EMAIL, env.SONJW_LIKE_PASSWORD], "플랫폼 관리자": [admEmail, admPw] };
const clients = {}; for (const [n, cred] of Object.entries(WHO)) clients[n] = cred ? await login(...cred) : createClient(url, anon, { auth: { persistSession: false } });
const REV = () => q("select id from centers where is_nicepay_review limit 1");
const seen = async () => { const rev = REV(); const out = {}; for (const [n, c] of Object.entries(clients)) { const ce = await c.from("centers").select("id").eq("id", rev); const pr = await c.from("products").select("id").eq("center_id", rev); const cl = await c.from("classes").select("id").eq("center_id", rev);
  const rp = await c.rpc("fetch_purchasable_products", { p_center_id: rev }); const rs = await c.rpc("fetch_public_storefront_products", { p_center_id: rev });
  out[n] = [ce.data?.length ?? 0, pr.data?.length ?? 0, cl.data?.length ?? 0, Array.isArray(rp.data) ? rp.data.length : 0, Array.isArray(rs.data) ? rs.data.length : 0].join("/"); } return out; };
const fp = () => q("select md5(string_agg(x, '|' order by x)) from (select 'a:'||id||coalesce(auth_id::text,'')||is_platform_admin x from accounts union all select 'p:'||id||account_id from profiles union all select 'cm:'||id from center_members union all select 'o:'||id||status||amount from orders union all select 'm:'||id||status||remaining_count from memberships union all select 'r:'||id||status from reservations union all select 'c:'||id||name||is_internal from centers where not is_nicepay_review union all select 'pr:'||p.id||p.price from products p join centers c on c.id=p.center_id where not c.is_nicepay_review) s");
const reset = () => { // 적용 상태·열린 심사 센터·페르소나 권한으로 되돌림(로컬 전용)
  runFile("add_nicepay_review_center_isolation_20261028.sql"); runFile("fix_nicepay_gate_reviewer_flag_20261029.sql");
  q("update centers set is_internal=false, status='approved' where is_nicepay_review; update nicepay_checkout_gate set mode='off' where id; update accounts set nicepay_review_access = true where auth_id in (select id from auth.users where email in ('" + env.TEST_USER_B_EMAIL + "', '" + env.SONJW_LIKE_EMAIL + "'))"); };
const closeIt = () => runFile("close_nicepay_review_20261029.sql");
const aProfile = () => q(`select p.id from profiles p join accounts a on a.id=p.account_id where a.auth_id=(select id from auth.users where email='${env.TEST_USER_A_EMAIL}') limit 1`);
const polCount = () => q("select count(*) from pg_policies where policyname in ('nicepay_review_isolation','nicepay_own_reservation_class')");
const failureTest = (file, label, id) => { const before = q("select mode||'/'||(select count(*) from accounts where nicepay_review_access)||'/'||(select count(*) from centers where is_nicepay_review and is_internal)||'/'||(select count(*) from pg_policies where policyname='nicepay_review_isolation') from nicepay_checkout_gate where id"); runFile(file, (t) => t.replace(/commit;\s*(\n|$)/i, "select 1/0;\ncommit;\n")); const after = q("select mode||'/'||(select count(*) from accounts where nicepay_review_access)||'/'||(select count(*) from centers where is_nicepay_review and is_internal)||'/'||(select count(*) from pg_policies where policyname='nicepay_review_isolation') from nicepay_checkout_gate where id"); rec(id, label, before, after); };

// ── A. 정상 종료: 회원 등록 없음 ──
reset(); q("delete from center_members where center_id = (select id from centers where is_nicepay_review)");
const mOpen = await seen(); note("M0", "종료 전(P2 적용·센터 공개) 역할별 심사 센터 가시성 센터/상품/수업/구매RPC/공개RPC", JSON.stringify(mOpen));
const Z = "0/0/0/0/0", GENERAL = ["비회원(anon)", "일반회원A", "토스 심사관T", "운영 센터 매니저", "토스센터 매니저S(is_member=false)"];
const openOk = (m) => GENERAL.filter((n) => !n.startsWith("토스센터 매니저S")).every((n) => m[n] === Z) && ["NICEPAY 심사관B", "토스센터 매니저S(is_member=false)", "심사 센터 매니저", "플랫폼 관리자"].every((n) => m[n] !== Z);   // S 는 NICEPAY 전용 권한도 가진 페르소나라 종료 전에는 보임
const closedOk = (m) => [...GENERAL, "NICEPAY 심사관B"].every((n) => m[n] === Z) && ["심사 센터 매니저", "플랫폼 관리자"].every((n) => m[n] !== Z);
rec("A0", "종료 전: 심사관B·심사 센터 매니저·관리자는 보이고, 일반회원/토스 심사관/운영 매니저/비회원은 0", "true", String(openOk(mOpen)));
const fpA0 = fp(); const c1 = closeIt(); rec("A1", "심사 종료 SQL 실행", true, c1.ok, c1.out.slice(-80));
const c1b = closeIt(); rec("A1b", "심사 종료 SQL 중복 실행(멱등)", true, c1b.ok);
const mClosed = await seen(); note("M1", "종료 후(P2 적용) 역할별 가시성", JSON.stringify(mClosed));
rec("A2", "종료 후: 일반 계층(비회원/일반/토스/운영매니저/심사관 해제)은 0, 심사 센터 매니저·관리자만 보임(의도)", "true", String(closedOk(mClosed)));
const r2b = runFile("rollback_fix_nicepay_gate_reviewer_flag_20261029.sql"); rec("A3", "P2b 롤백 성공", true, r2b.ok, r2b.out.slice(-60));
const r2 = runFile(RB); rec("A4", "회원 등록 없음: P2 롤백 성공", true, r2.ok, r2.out.slice(-80));
const mRb = await seen(); note("M2", "롤백 후 역할별 가시성", JSON.stringify(mRb));
rec("A5", "롤백 후에도 일반 계층에게 심사 센터가 보이지 않음", "true", String(closedOk(mRb)));
const r2r = runFile(RB); rec("A6", "P2 롤백 중복 실행(멱등)", true, r2r.ok, r2r.out.slice(-60));
rec("A7", "운영 센터 데이터 지문(회원·주문·수강권·예약·운영 센터/상품)이 종료·롤백 전후 동일", fpA0, fp());

// ── B. 심사 센터에 일반 회원 등록 ──
reset(); const prof = aProfile(); const revId = REV();
q(`insert into center_members(center_id, profile_id) values ('${revId}', '${prof}') on conflict do nothing`);
q(`insert into memberships(profile_id, center_id, product_name, pass_type, total_count, remaining_count) values ('${prof}', '${revId}', '[심사용] 시험 회원권', 'count', 1, 1)`);
const relCnt = q(`select (select count(*) from center_members where center_id='${revId}')||'/'||(select count(*) from memberships where center_id='${revId}')`); note("B0", "일반회원A 의 심사 센터 관계 center_members/memberships", relCnt);
closeIt(); const mB1 = await seen(); note("B1", "종료 후(P2 적용) 가시성 — 회원 관계가 있어도 분리 정책이 막고 있음", JSON.stringify(mB1));
rec("B2", "종료 후 P2 적용 중에는 일반회원A 에게도 0 (정책이 숨김)", "0/0/0/0/0", mB1["일반회원A"]);
runFile("rollback_fix_nicepay_gate_reviewer_flag_20261029.sql");
const fpB = fp(); const polB = polCount(); const rb = runFile(RB);
if (DEFECT) { note("B3", "수정 전 롤백 SQL 결과", rb.ok ? "성공(정책 제거됨)" : "중단", rb.out.slice(-120)); const mX = await seen(); rec("B4", "[결함 재현] 롤백 뒤 일반회원A 에게 심사 센터가 노출됨", "true", String(mX["일반회원A"] !== "0/0/0/0/0"), mX["일반회원A"]); }
else {
  rec("B3", "회원 관계가 있으면 P2 롤백은 오류로 중단", false, rb.ok, rb.out.slice(0, 300));
  rec("B3b", "오류 메시지에 원인(노출·회원 등록)과 해결 방법이 있음", "true", String(/새로 보이게/.test(rb.out) && /회원 등록/.test(rb.out) && /해결/.test(rb.out)));
  rec("B4", "중단 후 P2 분리 정책 유지", polB, polCount());
  const mB2 = await seen(); rec("B5", "중단 후 일반회원A 에게 여전히 0", "0/0/0/0/0", mB2["일반회원A"]); rec("B5b", "중단 후 역할별 가시성이 롤백 시도 전과 동일", JSON.stringify(mB1), JSON.stringify(mB2));
  rec("C1", "중단 후 회원·프로필·센터 회원 관계·주문·수강권·예약·운영 센터/상품 데이터 보존", fpB, fp());
  rec("C2", "일반회원A 의 심사 센터 관계가 그대로 남음", relCnt, q(`select (select count(*) from center_members where center_id='${revId}')||'/'||(select count(*) from memberships where center_id='${revId}')`));
  rec("C3", "임시 객체가 남지 않음(롤백된 트랜잭션)", "0", q("select count(*) from pg_proc where proname='nicepay_rb_probe'"));
  // 관계 정리(승인된 절차를 흉내 — 로컬 시험 데이터만) 후에는 롤백이 가능하다
  q(`delete from memberships where center_id='${revId}' and profile_id='${prof}'; delete from center_members where center_id='${revId}' and profile_id='${prof}'`);
  const rb2 = runFile(RB); rec("B6", "관계를 정리한 뒤에는 P2 롤백 성공", true, rb2.ok, rb2.out.slice(-60));
}
// ── D. 다른 우회 경로: 심사 센터에 일반 회원이 주문만 가진 경우 / 최근 계정 샘플 ──
if (!DEFECT) {
  reset(); q(`insert into orders(center_id, profile_id, product_id, product_name, amount, pay_method, payment_provider, status) select '${revId}', '${prof}', id, name, 1000, 'card', 'toss', 'cancelled' from products where center_id='${revId}' limit 1`);
  closeIt(); runFile("rollback_fix_nicepay_gate_reviewer_flag_20261029.sql"); const rbo = runFile(RB);
  rec("D1", "주문 기록만 있는 일반 회원(center_members 없음)은 노출이 늘지 않으므로 롤백 허용(관계 존재 자체가 아니라 실제 노출 증가를 기준으로 판정)", true, rbo.ok, rbo.out.slice(-80));
  // ── E. 실패 원자성·반복 ──
  reset(); q(`insert into center_members(center_id, profile_id) values ('${revId}', '${prof}') on conflict do nothing`);
  failureTest("close_nicepay_review_20261029.sql", "E1 심사 종료 SQL 중간 실패: 게이트/권한/센터/정책 상태 불변(전체 롤백)", "E1");
  closeIt(); runFile("rollback_fix_nicepay_gate_reviewer_flag_20261029.sql");
  failureTest(RB, "롤백 SQL 끝에서 실패 주입: 정책·함수·게이트 불변", "E2");
  q(`delete from center_members where center_id='${revId}' and profile_id='${prof}'`);
}
// 정리
reset(); q(`delete from memberships where center_id='${revId}' and profile_id='${prof}'; delete from center_members where center_id='${revId}' and profile_id='${prof}'; delete from orders where center_id='${revId}' and profile_id='${prof}' and payment_provider='toss'`);
console.log(`\n${res.filter((x) => x.pass).length}/${res.filter((x) => x.pass !== null).length} PASS, ${failures} FAIL`); if (OUT) fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, failures, results: res }, null, 1)); process.exit(failures ? 1 : 0);
