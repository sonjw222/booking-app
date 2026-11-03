// 로컬 격리 스택 전용: 허용 목록 SQL 의 생애주기 — 적용 → 허용 행 등록 → 권한 철회(행 삭제·심사관 권한 회수) → 롤백(행 있으면 중단) → 재적용 → 변조 감지.
// 매 단계에서 "기존 사용자 가시성 스냅샷"(역할 7 × 센터 4 × {센터·상품·수업·공개RPC·구매RPC·기간RPC})이 적용 전(BEFORE)과 같은지 비교한다. 정의 MD5 는 운영 기준값(적용 전)과도 대조한다.
// 사전: setupLocal.sh → setupExtraPersonas.mjs → setupRealCenter.sh. 사용: ISO_ENV_FILE=… node realCenterGrantsLifecycle.mjs <결과.json> — 어긋나면 종료 코드 1. 마지막 상태: 적용됨·허용 행 0.
import fs from "node:fs"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const docker = (args, input) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", ...args], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const psql = (sql) => docker(["-v", "ON_ERROR_STOP=1", "-c", sql]);
const runFile = (f) => { try { return { ok: true, out: docker(["-v", "ON_ERROR_STOP=1"], fs.readFileSync(f, "utf8")) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };
const SQL = "add_nicepay_review_real_center_grants_20261103.sql", RB = "rollback_add_nicepay_review_real_center_grants_20261103.sql", VERIFY = "verify_add_nicepay_review_real_center_grants_20261103.sql";
const PRE = { allowed: "636cb33ff0feaf95244ef0c41c3eb923", member: "a3a299f743087d104ebf41948e464d94", guard: "0e8dc90f9da6cb921225657ba6ae4fb4" };
const hashes = () => psql("select md5(pg_get_functiondef('public.nicepay_review_center_allowed(uuid)'::regprocedure))||','||md5(pg_get_functiondef('public.nicepay_review_center_member_allowed(uuid)'::regprocedure))||','||md5(pg_get_functiondef('public.nicepay_review_guard_center()'::regprocedure))");
const RPC_H = () => psql("select md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure))||','||md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure))||','||md5(pg_get_functiondef('public.fetch_public_storefront_product_periods(uuid)'::regprocedure))||','||md5(pg_get_functiondef('public.create_order_secure(uuid,text,text,integer,boolean,text)'::regprocedure))");   // 이 SQL 과 롤백이 건드리면 안 되는 함수(만료 상품 숨김 SQL 이 만든 정의 포함)
const PRE_H = `${PRE.allowed},${PRE.member},${PRE.guard}`;
const OUT = process.argv[2]; const results = []; let failures = 0;
const rec = (id, name, expected, actual, extra = "") => { const pass = String(expected) === String(actual); if (!pass) failures++; results.push({ id, name, expected, actual, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${String(expected).slice(0, 70)} / 실제 ${String(actual).slice(0, 70)}${extra ? " · " + String(extra).slice(0, 120) : ""}`); };
const login = async (e, p) => { const c = createClient(url, anon, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email: e, password: p }); if (error) throw new Error(error.message); return c; };
const WHO = { anon: null, A: [env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD], T: [env.TOSS_REVIEWER_EMAIL, env.TOSS_REVIEWER_PASSWORD], B: [env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD], MA: [env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD], MB: [env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD], S: [env.SONJW_LIKE_EMAIL, env.SONJW_LIKE_PASSWORD] };
const C = {}; for (const [k, v] of Object.entries(WHO)) C[k] = v ? await login(...v) : createClient(url, anon, { auth: { persistSession: false } });
const { data: centers } = await svc.from("centers").select("id,name,is_nicepay_review");
const CEN = { REAL: centers.find((c) => c.name === "[로컬] 실센터 모사").id, OP: centers.find((c) => c.name === "[QA] 심사 시험 스튜디오").id, REV: centers.find((c) => c.is_nicepay_review).id, TOSS: centers.find((c) => c.name === "[토스 심사용] 로컬 시험 센터").id };
const accB = psql(`select a.id from accounts a join auth.users u on u.id=a.auth_id where u.email='${env.TEST_USER_B_EMAIL}'`);
async function cell(c, id) {
  const q = async (p) => { const r = await p; return Array.isArray(r.data) ? r.data.length : r.error ? "E" : 0; };
  return [await q(c.from("centers").select("id").eq("id", id)), await q(c.from("products").select("id").eq("center_id", id)), await q(c.from("classes").select("id").eq("center_id", id)),
    await q(c.rpc("fetch_public_storefront_products", { p_center_id: id })), await q(c.rpc("fetch_purchasable_products", { p_center_id: id })), await q(c.rpc("fetch_public_storefront_product_periods", { p_center_id: id }))].join("/");
}
const snapshot = async () => { const s = {}; for (const [w, c] of Object.entries(C)) { s[w] = {}; for (const [n, id] of Object.entries(CEN)) s[w][n] = await cell(c, id); } return s; };
const diff = (a, b) => { const out = []; for (const w of Object.keys(a)) for (const n of Object.keys(a[w])) if (a[w][n] !== b[w][n]) out.push(`${w}/${n}:${a[w][n]}→${b[w][n]}`); return out; };
const clear = () => psql("delete from nicepay_review_center_grants");
const grant = (purchase) => psql(`delete from nicepay_review_center_grants; insert into nicepay_review_center_grants(account_id, center_id, can_purchase, note) values ('${accB}','${CEN.REAL}',${purchase},'생애주기 시험')`);

// 0. 적용 전(BEFORE) 상태 만들기: 적용돼 있으면 먼저 롤백(허용 행이 있으면 지운 뒤)
if (psql("select to_regclass('public.nicepay_review_center_grants') is not null") === "t") { clear(); const r = runFile(RB); if (!r.ok) throw new Error("사전 롤백 실패: " + r.out); }
rec("L0", "적용 전 함수 정의 MD5 가 운영 기준값(읽기 전용 조회 값)과 같다", PRE_H, hashes());
const snap0 = await snapshot(); const rpc0 = RPC_H();

// 1. 적용
const ap = runFile(SQL); rec("L1", "적용 성공(preflight 해시 통과)", true, ap.ok, ap.out.slice(-80));
rec("L1g", "적용은 목록 RPC·주문 생성 함수 정의를 바꾸지 않는다", rpc0, RPC_H()); const h1 = hashes(); rec("L1b", "적용 후 함수 정의가 적용 전과 다르다(교체됨)", true, h1 !== PRE_H);
const v1 = docker([], fs.readFileSync(VERIFY, "utf8")); rec("L1c", "verify SQL: 3개 함수 APPLIED, 허용 행 0", "3/true", `${(v1.match(/APPLIED/g) ?? []).length}/${/grants_rows\|0\|0/.test(v1)}`);
rec("L1d", "허용 행이 없으면 모든 역할·센터 가시성이 적용 전과 동일(기존 사용자 영향 0)", "", diff(snap0, await snapshot()).join(","));
const ap2 = runFile(SQL); rec("L1e", "재실행(멱등): 적용본 해시를 허용", true, ap2.ok, ap2.out.slice(-60)); rec("L1f", "재실행 후 정의 동일", h1, hashes());

// 2. 허용 행 등록
grant(false); const s2 = await snapshot(); const d2 = diff(snap0, s2);
rec("L2", "허용(조회 전용) 등록: 달라지는 것은 심사관B 의 REAL 센터 한 칸뿐", "B/REAL:0/0/0/0/0/0→1/4/1/3/3/3", d2.join(","));
rec("L2b", "그 밖의 모든 역할·센터는 적용 전과 동일", "1", String(d2.length));

// 3. 권한 철회 ①: 허용 행 삭제
clear(); rec("L3", "허용 행 삭제 → 스냅샷이 적용 전과 동일", "", diff(snap0, await snapshot()).join(","));
// 3-b. 권한 철회 ②: 심사관 권한 회수(허용 행은 남김) → B 는 일반 회원 규칙, 허용은 무효
grant(true); psql(`update accounts set nicepay_review_access=false where id='${accB}'`);
const sB = await snapshot(); rec("L3b", "심사관 권한 회수 시 B 의 REAL 가시성이 일반 회원 A 와 같다(허용 효력 없음)", sB.A.REAL, sB.B.REAL);
rec("L3c", "권한 회수 시 B 는 일반 회원처럼 운영 센터도 본다(기존 규칙)", sB.A.OP, sB.B.OP);
psql(`update accounts set nicepay_review_access=true where id='${accB}'`); rec("L3d", "권한을 되돌리면 허용이 다시 유효(B/REAL 보임)", "1", (await cell(C.B, CEN.REAL)).split("/")[0]);

// 4. 롤백: 행이 있으면 중단
const hApplied = hashes(); const rb1 = runFile(RB);
rec("L4", "허용 행이 있으면 롤백 중단(데이터 보존)", "ABORT", rb1.ok ? "RAN" : /롤백 중단: 허용 목록에 행이 있어요/.test(rb1.out) ? "ABORT" : "OTHER", rb1.out.slice(0, 80));
rec("L4b", "중단 시 아무것도 바뀌지 않음(정의 그대로, 허용 유효)", `${hApplied}|1`, `${hashes()}|${(await cell(C.B, CEN.REAL)).split("/")[0]}`);
clear(); const rb2 = runFile(RB); rec("L4c", "행 삭제 후 롤백 성공(복원 경고 없음)", true, rb2.ok && !/롤백 복원 확인/.test(rb2.out), rb2.out.slice(-100));
rec("L4h", "롤백도 목록 RPC·주문 생성 함수 정의를 바꾸지 않는다(만료 상품 숨김 보존)", rpc0, RPC_H()); rec("L4d", "롤백 후 함수 정의 MD5 가 운영 기준값(적용 전)과 같다", PRE_H, hashes());
rec("L4e", "롤백 후 새 객체 삭제(테이블·함수)", "true|true|true|true", psql("select (to_regclass('public.nicepay_review_center_grants') is null)||'|'||(to_regprocedure('nicepay_review_center_granted(uuid)') is null)||'|'||(to_regprocedure('nicepay_my_review_center_ids()') is null)||'|'||(to_regprocedure('nicepay_review_center_purchase_allowed(uuid)') is null)"));
rec("L4f", "롤백 후 스냅샷이 적용 전과 동일(기존 사용자 영향 0)", "", diff(snap0, await snapshot()).join(","));
const rb3 = runFile(RB); rec("L4g", "롤백 재실행(멱등)", true, rb3.ok, rb3.out.slice(-60));

// 5. 재적용
const ap3 = runFile(SQL); rec("L5", "롤백 후 재적용 성공", true, ap3.ok, ap3.out.slice(-60)); rec("L5b", "재적용 후 정의가 첫 적용본과 동일", h1, hashes());
grant(false); rec("L5c", "재적용 후 허용 등록이 다시 동작(B/REAL 보임)", "1/4/1/3/3/3", await cell(C.B, CEN.REAL)); clear();
rec("L5d", "허용 삭제 후 스냅샷이 적용 전과 동일", "", diff(snap0, await snapshot()).join(","));

// 6. 변조 감지: 교체 대상 함수가 운영 정의와 달라졌다면 적용이 중단돼야 한다
psql("create or replace function public.nicepay_review_center_allowed(p_center_id uuid) returns boolean language sql stable security definer set search_path=public as $$ select true $$");
const ap4 = runFile(SQL); rec("L6", "함수 정의가 예상과 다르면 preflight 가 적용을 중단", "ABORT", ap4.ok ? "RAN" : /현재 정의가 예상.*달라요/.test(ap4.out) ? "ABORT" : "OTHER", ap4.out.slice(0, 90));
const rb4 = runFile(RB); rec("L6b", "변조된 상태에서도 롤백은 P2 정의로 정확히 복원", PRE_H, rb4.ok ? hashes() : "ROLLBACK_FAILED");
const ap5 = runFile(SQL); rec("L6c", "복원 후 다시 적용 성공(최종 상태: 적용됨)", true, ap5.ok); rec("L6d", "최종 정의 = 첫 적용본", h1, hashes());

fs.writeFileSync(OUT ?? "real-center-grants-lifecycle.json", JSON.stringify({ at: new Date().toISOString(), failures, results }, null, 2));
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAIL"} (${results.length} checks)`); process.exit(failures ? 1 : 0);
