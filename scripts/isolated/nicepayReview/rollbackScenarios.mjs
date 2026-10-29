// 로컬 격리 DB 전용: 롤백 안전장치·복원 시나리오 검증. 분리 SQL 이 적용되고 setupLocal.sh 로 준비된 상태에서 실행한다.
import { execFileSync } from "node:child_process"; import fs from "node:fs";
import { loadIsolatedEnv } from "./assertIsolated.mjs";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE);
const sql = (q, file) => { try { return { ok: true, out: execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", ...(file ? [] : ["-c", q])], { input: file ? fs.readFileSync(file) : undefined, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim() }; } catch (e) { return { ok: false, out: String(e.stderr || e.message).trim().split("\n").filter((l) => !/NOTICE/.test(l)).slice(-2).join(" | ") }; } };
const APPLY = "add_nicepay_review_center_isolation_20261028.sql", RB = "rollback_add_nicepay_review_center_isolation_20261028.sql", PER = "add_public_storefront_product_periods_20261027.sql", RB2B = "rollback_fix_nicepay_gate_reviewer_flag_20261029.sql", AP2B = "fix_nicepay_gate_reviewer_flag_20261029.sql";
const res = []; const rec = (name, pass, detail) => { res.push({ name, pass, detail }); console.log((pass ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const as = async (e, p) => { const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } }); if (e) await c.auth.signInWithPassword({ email: e, password: p }); return c; };
const rev = (await svc.from("centers").select("id").eq("is_nicepay_review", true).single()).data.id;
const reads = async () => { const out = {}; for (const [n, e, p] of [["비회원"], ["일반회원A", env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD], ["심사관B", env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD]]) { const c = await as(e, p); out[n] = { centers: (await c.from("centers").select("id").eq("id", rev)).data.length, products: (await c.from("products").select("id").eq("center_id", rev)).data.length, classes: (await c.from("classes").select("id").eq("center_id", rev)).data.length }; } return out; };
const periodsDef = () => sql("select md5(pg_get_functiondef('fetch_public_storefront_product_periods(uuid)'::regprocedure))").out;

// 전제: S2/S3 는 "기간 RPC 가 이전부터 있던" 경우를 시험하므로 먼저 P1(선행 기간 RPC)을 보장한다(S4 가 "없던" 경우를 따로 시험)
sql(null, PER);
// 시나리오 0: P2b 가 적용돼 있으면 P2 롤백은 아무것도 바꾸지 않고 중단(롤백은 역순: P2b → P2). 이어서 P2b 롤백은 게이트가 off 일 때만 성공한다.
sql("update centers set is_internal=true where id='" + rev + "'"); sql("select 1");
{ if (sql("select to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null").out !== "t") sql(null, AP2B);
  const polBefore = sql("select count(*) from pg_policies where policyname='nicepay_review_isolation'").out; const r0 = sql(null, RB);
  rec("S0 P2b 적용 상태에서 P2 롤백은 중단 + 변경 없음", !r0.ok && /P2b/.test(r0.out) && sql("select count(*) from pg_policies where policyname='nicepay_review_isolation'").out === polBefore, r0.out.slice(0, 80));
  sql("update nicepay_checkout_gate set mode='reviewer' where id"); const gb = sql("select md5(pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure))").out; const r0b = sql(null, RB2B);
  rec("S0b 게이트 mode 가 reviewer 면 P2b 롤백 중단 + 함수 변경 없음", !r0b.ok && /off 가 아니에요/.test(r0b.out) && sql("select md5(pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure))").out === gb, r0b.out.slice(0, 80));
  // S0d: 승인 선점(approving) 상태의 NICEPAY 주문이 남아 있으면 mode=off 여도 P2b 롤백은 중단, release 로 해소되면 성공
  { const { data: bAcc } = await svc.from("profiles").select("id").eq("account_id", (await svc.from("accounts").select("id").eq("nicepay_review_access", true).limit(1).single()).data.id).limit(1).single();
    const { data: prodR } = await svc.from("products").select("id,name,center_id").eq("center_id", rev).limit(1).single();
    const ins = await svc.from("orders").insert({ center_id: rev, profile_id: bAcc.id, product_id: prodR.id, product_name: prodR.name, amount: 1000, pay_method: "card", payment_provider: "nicepay" }).select("id").single();
    sql("update nicepay_checkout_gate set mode='reviewer' where id"); sql("update centers set is_internal=false, status='approved' where id='" + rev + "'");
    const cl = await svc.rpc("nicepay_claim_order", { p_order_id: ins.data.id }); const claimId = cl.data;
    sql("update nicepay_checkout_gate set mode='off' where id"); const gh = sql("select md5(pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure))").out;
    const rIn = sql(null, RB2B);
    rec("S0d approving 주문이 있으면(mode=off 여도) P2b 롤백 중단 + 함수 변경 없음", !!claimId && !rIn.ok && /approving/.test(rIn.out) && sql("select md5(pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure))").out === gh, rIn.out.slice(0, 90));
    await svc.rpc("nicepay_release_order", { p_order_id: ins.data.id, p_claim_id: claimId, p_basis: "approve_rejected" }); sql(`begin; set local session_replication_role = replica; delete from nicepay_review_actions where order_id='${ins.data.id}'; delete from orders where id='${ins.data.id}'; commit;`); sql("update centers set is_internal=true where id='" + rev + "'"); }
  sql("update nicepay_checkout_gate set mode='off' where id"); const r0c = sql(null, RB2B);
  rec("S0c mode=off 에서 P2b 롤백 성공 + 도우미 함수 제거", r0c.ok && sql("select to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is null").out === "t", r0c.out.slice(0, 80)); }
// 시나리오 1: 심사 센터가 공개 가능(approved, 비내부) 상태면 롤백이 아무것도 바꾸지 않고 중단
sql("update centers set is_internal=false, status='approved' where id='" + rev + "'");
const before = sql("select count(*) from pg_policies where policyname='nicepay_review_isolation'").out;
const r1 = sql(null, RB);
const after = sql("select count(*) from pg_policies where policyname='nicepay_review_isolation'").out;
rec("S1 공개 가능 상태에서 롤백 중단 + 변경 없음", !r1.ok && /롤백 중단/.test(r1.out) && before === after && before === "3", r1.out.slice(0, 80));
// 시나리오 2: 센터 상태만 pending 으로 바꿔도 상품·수업 직접 조회까지 막힌다(분리 정책 제거 상태에서 확인 → 롤백 실행 후 조회)
sql("update centers set is_internal=true where id='" + rev + "'");
const r2 = sql(null, RB);
rec("S2 pending 으로 비공개 후 롤백 성공", r2.ok, r2.out.slice(0, 80));
const rd = await reads(); const allZero = Object.values(rd).every((v) => v.centers === 0 && v.products === 0 && v.classes === 0);
rec("S2 분리 정책이 없는 상태에서도 pending 센터의 센터·상품·수업 직접 조회 0행(비회원/일반/심사관)", allZero, JSON.stringify(rd));
rec("S2 롤백 후 정책/트리거/함수 제거(데이터 보존용 accounts 보호 트리거 1개만 남음)", sql("select (select count(*) from pg_policies where policyname in ('nicepay_review_isolation','nicepay_own_reservation_class'))||'/'||(select count(*) from pg_trigger where not tgisinternal and tgname ~ '^trg_(centers|accounts|orders|memberships|cart_items|purchase_requests|reservations)_nicepay_review_')||'/'||(to_regprocedure('nicepay_review_center_allowed(uuid)') is null)||'/'||(to_regprocedure('nicepay_review_center_member_allowed(uuid)') is null)").out === "0/1/true/true");
{ // S2d: 롤백 뒤에도 남는 accounts 보호 트리거가 의존하는 함수가 있어야 하고, 권한 변경 동작이 롤백 전과 같아야 한다(과거 결함: nicepay_is_client_request 삭제로 모든 권한 변경이 "function does not exist")
  const dep = sql("select (to_regprocedure('enforce_nicepay_review_access_admin_only()') is not null)||'/'||(to_regprocedure('nicepay_is_client_request()') is not null)").out;
  rec("S2d 롤백 뒤 accounts 보호 트리거 의존 함수 유지(enforce_…, nicepay_is_client_request)", dep === "true/true", dep);
  const aid = sql("select auth_id from accounts where auth_id is not null order by created_at limit 1").out;
  const cl = `select set_config('request.jwt.claims','{"sub":"${aid}","role":"authenticated"}',true)`;
  const ed = sql(`begin; update accounts set nicepay_review_access = true where auth_id = '${aid}'; update accounts set nicepay_review_access = false where auth_id = '${aid}'; rollback;`);
  rec("S2d 롤백 뒤 SQL Editor(postgres)의 권한 부여·해제 정상", ed.ok, ed.out.slice(0, 80));
  const un = sql(`begin; set local role authenticated; ${cl}; update accounts set nicepay_review_access = true where auth_id = '${aid}'; rollback;`);
  rec("S2d 롤백 뒤 일반 계정의 본인 권한 true 변경은 '운영자만' 메시지로 거부(함수 없음 오류가 아님)", !un.ok && /운영자만 변경/.test(un.out) && !/does not exist/.test(un.out), un.out.slice(0, 80));
  const nm = sql(`begin; set local role authenticated; ${cl}; update accounts set name = name where auth_id = '${aid}'; rollback;`);
  rec("S2d 롤백 뒤 일반 계정의 평소 UPDATE 정상", nm.ok, nm.out.slice(0, 60)); }
rec("S2 기간 RPC 는 이전부터 있었으므로 삭제되지 않고 이전 정의로 복원", sql("select to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null").out === "t" && !/nicepay_review_center_allowed/.test(sql("select pg_get_functiondef('fetch_public_storefront_product_periods(uuid)'::regprocedure)").out));
// 변형: 센터 승인 상태(status)만 pending 으로 바꿔도 같은 결과(로컬에서만 status 보호 트리거를 잠시 끄고 재현 — 운영에서는 플랫폼 관리자 계정으로 변경)
sql("alter table centers disable trigger trg_guard_center_status; update centers set is_internal=false, status='pending' where id='" + rev + "'; alter table centers enable trigger trg_guard_center_status");
const rd2 = await reads(); rec("S2b status=pending(비내부)만으로도 센터·상품·수업 직접 조회 0행", Object.values(rd2).every((v) => v.centers === 0 && v.products === 0 && v.classes === 0), JSON.stringify(rd2));
sql("alter table centers disable trigger trg_guard_center_status; update centers set is_internal=false, status='approved' where id='" + rev + "'; alter table centers enable trigger trg_guard_center_status");
const rd3 = await reads(); rec("S2c(대조) 롤백 후 approved·비내부로 되돌리면 심사 센터가 일반 사용자에게 노출됨 — 롤백 안전장치가 필요한 이유", rd3["일반회원A"].centers === 1 && rd3["비회원"].products > 0, JSON.stringify(rd3));
sql("update centers set is_internal=true where id='" + rev + "'");
const origMd5 = periodsDef();
// 시나리오 3: 이전부터 있었던 경우 — 적용(주석 표식 없음) → 롤백 → 같은 정의
sql("update centers set is_internal=false, status='approved' where id='" + rev + "'"); sql(null, APPLY); const m1 = sql("select coalesce(obj_description('fetch_public_storefront_product_periods(uuid)'::regprocedure,'pg_proc'),'') like 'created_by:%'").out;
rec("S3 이전부터 있던 기간 RPC 는 분리 SQL 이 표식을 붙이지 않음", m1 === "f");
sql("update centers set is_internal=true where id='" + rev + "'"); sql(null, RB);
rec("S3 적용→롤백 뒤 기간 RPC 정의가 처음과 동일", periodsDef() === origMd5);
// 시나리오 4: 없었던 경우 — 함수 삭제 → 적용(표식) → 롤백 시 삭제
sql("drop function fetch_public_storefront_product_periods(uuid)"); sql("update centers set is_internal=false, status='approved' where id='" + rev + "'"); const a4 = sql(null, APPLY);
const m2 = sql("select coalesce(obj_description('fetch_public_storefront_product_periods(uuid)'::regprocedure,'pg_proc'),'') like 'created_by:add_nicepay_review_center_isolation%'").out;
rec("S4 기간 RPC 없이 적용하면 분리 SQL 이 만들고 표식을 남김", a4.ok && m2 === "t");
sql("update centers set is_internal=true where id='" + rev + "'"); const r4 = sql(null, RB);
rec("S4 롤백 시 분리 SQL 이 만든 기간 RPC 는 삭제", r4.ok && sql("select to_regprocedure('fetch_public_storefront_product_periods(uuid)') is null").out === "t");
// 정상 상태로 복구: 선행 SQL → 분리 SQL → 심사 센터 공개
sql(null, PER); sql(null, APPLY); sql("update centers set is_internal=false, status='approved' where id='" + rev + "'");
console.log(`\n${res.filter((r) => r.pass).length}/${res.length} PASS`); process.exit(res.every((r) => r.pass) ? 0 : 1);
