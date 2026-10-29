// 로컬 격리 스택 전용: 만료 상품 기존 pending 직접결제 주문 처리(add_expired_order_resolution_20261031.sql 적용 상태)를 실제 PostgREST·JWT 로 검증한다. 단언(어긋나면 종료 코드 1).
// 사용: ISO_ENV_FILE=… node verify.mjs <결과.json>.  선행: fix_expired_fixed_date_products_20261031.sql + add_expired_order_resolution_20261031.sql 적용. 시험 데이터는 EXO- 접두로 만들고 끝에서 정리한다(로컬 격리 DB 한정).
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DB = process.env.ISO_DB_CONTAINER ?? "supabase_db_mwhabit-isolated";
const psql = (sql) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const res = []; let fails = 0;
const eq = (id, name, exp, act, extra = "") => { const pass = JSON.stringify(exp) === JSON.stringify(act); if (!pass) fails++; res.push({ id, name, expected: exp, actual: act, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${JSON.stringify(exp)} / 실제 ${JSON.stringify(act)}${extra ? " · " + String(extra).slice(0, 120) : ""}`); };
const login = async (e, p) => { const c = createClient(url, anon, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email: e, password: p }); if (error) throw new Error(error.message); return c; };
const kst = (d = 0) => psql(`select to_char((now() at time zone 'Asia/Seoul')::date + ${d}, 'YYYY-MM-DD')`);
const tag = crypto.randomBytes(2).toString("hex"); const N = (s) => `EXO-${tag}-${s}`;
const msg = (r) => r.error?.message ?? null; const has = (r, re) => re.test(r.error?.message ?? "");
const count = async (table, col, val, extra = (q) => q) => (await extra(svc.from(table).select("id", { count: "exact", head: true }).eq(col, val))).count ?? 0;

const centers = (await svc.from("centers").select("id,name,is_nicepay_review")).data;
const OP = centers.find((c) => c.name === "[QA] 심사 시험 스튜디오").id;
const A = await login(env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD), MA = await login(env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD), MB = await login(env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD);
const anonC = createClient(url, anon, { auth: { persistSession: false } });
// 매니저 A 를 OP 센터 오너로(로컬 격리 DB 한정), 제한 직원(주문 조회 권한만)을 새로 만든다
const maRow = psql(`select mc.id from manager_centers mc join accounts a on a.id = mc.account_id where mc.center_id = '${OP}' and a.auth_id = (select id from auth.users where email = '${env.TEST_MANAGER_A_EMAIL}')`);
psql(`update manager_centers set role_id = (select id from center_roles where center_id = '${OP}' and is_owner) where id = '${maRow}'`);
const staffEmail = `exo-staff-${tag}@isolated.test`, staffPw = crypto.randomBytes(12).toString("base64url") + "Aa1!";
const su = await svc.auth.admin.createUser({ email: staffEmail, password: staffPw, email_confirm: true });
const sa = (await svc.from("accounts").insert({ auth_id: su.data.user.id, name: "EXO 제한직원", is_member: true, is_manager: true, marketing_consent: false }).select("id").single()).data;
await svc.from("profiles").insert({ account_id: sa.id, name: "EXO 제한직원", is_primary: true });
const role = (await svc.from("center_roles").insert({ center_id: OP, name: N("조회전용"), is_system: false, is_owner: false }).select("id").single()).data;
await svc.from("role_permissions").insert({ role_id: role.id, permission_key: "pass.order.view" });
await svc.from("manager_centers").insert({ account_id: sa.id, center_id: OP, role_id: role.id, status: "active" });
const ST = await login(staffEmail, staffPw);
const profA = (await A.from("profiles").select("id").limit(1)).data[0].id;
const mk = async (name, mode, offset, extra = {}) => (await svc.from("products").insert({ center_id: OP, name: N(name), price: 80000, product_kind: "pass", pass_type: "count", total_count: 8, is_active: true, is_on_sale: true, visibility_type: "all", expiry_mode: mode, expiry_days: mode === "days" ? 30 : null, expiry_date: mode === "date" ? await kst(offset) : null, ...extra }).select("id,expiry_date").single()).data;
const PX = await mk("만료", "date", -1), PD = await mk("30일", "days", 0);
const order = async (p, extra = {}) => (await svc.from("orders").insert({ center_id: OP, profile_id: profA, product_id: p.id, product_name: "EXO", amount: 80000, pay_method: "direct", status: "pending", ...extra }).select("id").single()).data.id;
const rpc = (cl, id, action, over = {}) => cl.rpc("manager_resolve_expired_order", { p_order_id: id, p_action: action, p_reason: "시험 사유", p_received_amount: null, p_received_at: null, p_received_method: null, p_new_expires_on: null, p_refunded_at: null, ...over });
const recv = async (over = {}) => ({ p_received_amount: 80000, p_received_at: await kst(0), p_received_method: "cash", ...over });
const st = async (id) => (await svc.from("orders").select("status").eq("id", id).single()).data.status;
const nm = (id) => count("memberships", "profile_id", profA, (q) => q.eq("product_name", "EXO")).then(() => 0);
const msCount = async (oid) => (await svc.from("payments").select("membership_id").eq("order_id", oid)).data?.length ?? 0;
const guardHashes = () => psql("select md5(pg_get_functiondef('public.orders_guard_nicepay_create()'::regprocedure)) || md5(pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure)) || md5(pg_get_functiondef('public._issue_membership_and_record_payment(orders,text,text)'::regprocedure))");
const hBefore = guardHashes(); const prodExpiry = PX.expiry_date;
const created = [];
try {
  // ── 사전: 일반(만료 아님) 주문 회귀 ──
  const nA = await order(PD), nB = await order(PD);
  eq("R1", "회귀: 만료 아닌 상품 주문 fulfill_order(확정·발급) 정상", null, msg(await MA.rpc("fulfill_order", { p_order_id: nA })));
  eq("R2", "회귀: 만료 아닌 주문은 발급 후 done, 결제 1건·수강권 1건(만료일 = 상품 규칙)", ["done", 1], [await st(nA), await msCount(nA)]);
  eq("R3", "회귀: 만료 아닌 주문 일반 취소(UPDATE) 정상", "cancelled", (await MA.from("orders").update({ status: "cancelled" }).eq("id", nB).select("status")).data?.[0]?.status);
  eq("R4", "만료 상품이 아닌 주문은 새 기능으로 처리 거부(일반 흐름 사용 안내)", true, has(await rpc(MA, await order(PD), "unpaid_cancel"), /판매 기간이 지난 상품의 주문만/));

  // ── 4. 수납 여부 불명: 아무것도 하지 않음(서버에 '불명' 작업이 없다) — 대기 유지 확인용 주문 ──
  const oUnknown = await order(PX); created.push(oUnknown);
  eq("U1", "수납 여부 불명: 주문이 pending 그대로이고 처리 기록·수강권·결제가 없다", ["pending", 0, 0], [await st(oUnknown), await count("order_expiry_resolutions", "order_id", oUnknown), await msCount(oUnknown)]);

  // ── 직접 fulfill_order 우회 차단 ──
  eq("B1", "우회 차단: 만료 상품 pending 주문을 fulfill_order 로 직접 발급하면 거부", true, has(await MA.rpc("fulfill_order", { p_order_id: oUnknown }), /판매 기간이 지난 상품의 주문/));
  eq("B2", "우회 차단: 거부 후에도 주문 pending·수강권/결제 없음", ["pending", 0], [await st(oUnknown), await msCount(oUnknown)]);

  // ── 권한 ──
  const oAuth = await order(PX); created.push(oAuth);
  eq("P1", "일반 회원은 처리 RPC 호출 불가(권한 오류)", true, has(await rpc(A, oAuth, "unpaid_cancel"), /권한/));
  eq("P2", "타 센터 관리자(심사 센터 매니저)는 처리 불가", true, has(await rpc(MB, oAuth, "unpaid_cancel"), /권한/));
  eq("P3", "같은 센터지만 주문 조회 권한만 있는 직원은 처리 불가", true, has(await rpc(ST, oAuth, "unpaid_cancel"), /권한/));
  eq("P4", "비로그인(anon)은 함수 실행 자체가 거부", true, anonC.rpc ? (await rpc(anonC, oAuth, "unpaid_cancel")).error != null : false);
  eq("P5", "권한 오류 후에도 주문 pending·처리 기록 없음", ["pending", 0], [await st(oAuth), await count("order_expiry_resolutions", "order_id", oAuth)]);
  eq("P6", "처리 사유 없음 거부", true, has(await rpc(MA, oAuth, "unpaid_cancel", { p_reason: " " }), /사유/));
  eq("P7", "알 수 없는 처리 방식 거부", true, has(await rpc(MA, oAuth, "delete_everything"), /알 수 없는 처리 방식/));

  // ── 1. 미수납 확인 → 취소 (포인트 복원, 수강권·매출 없음) ──
  const oCancel = await order(PX, { points_used: 1000 }); created.push(oCancel);
  await svc.from("point_transactions").insert({ profile_id: profA, center_id: OP, amount: -1000, reason: "결제 시 사용", order_id: oCancel });
  const r1 = await rpc(MA, oCancel, "unpaid_cancel", { p_reason: "입금 내역 없음" });
  eq("C1", "미수납 취소: 성공, 주문 cancelled", ["cancelled", null], [await st(oCancel), msg(r1)]);
  eq("C2", "미수납 취소: 수강권·결제(매출) 없음", [0, 0], [await msCount(oCancel), (await svc.from("memberships").select("id", { count: "exact", head: true }).eq("profile_id", profA).eq("product_id", PX.id)).count]);
  eq("C3", "미수납 취소: 기존 규칙대로 사용 포인트 복원(+1000 reverses)", 1, (await svc.from("point_transactions").select("id").eq("order_id", oCancel).gt("amount", 0)).data?.length);
  const rec = (await svc.from("order_expiry_resolutions").select("resolution,reason,handled_by,handled_at").eq("order_id", oCancel).single()).data;
  eq("C4", "미수납 취소: 처리 이력(종류·사유·처리자·처리일) 기록", ["unpaid_cancelled", "입금 내역 없음", true, true], [rec?.resolution, rec?.reason, !!rec?.handled_by, !!rec?.handled_at]);
  eq("C5", "중복 클릭: 같은 주문 재처리는 거부, 이력 1건 유지", [true, 1], [has(await rpc(MA, oCancel, "unpaid_cancel"), /확인 대기 상태의 주문만|이미 처리/), await count("order_expiry_resolutions", "order_id", oCancel)]);
  eq("C6", "취소된 주문은 이후 fulfill_order 로도 발급 불가", true, (await MA.rpc("fulfill_order", { p_order_id: oCancel })).error != null);

  // ── 2. 수납 확인 + 환불 ──
  const oRef = await order(PX); created.push(oRef);
  eq("F1", "환불 예정: 수납 금액이 주문 금액과 다르면 거부(전액 확인 필요)", true, has(await rpc(MA, oRef, "refund_plan", await recv({ p_received_amount: 50000 })), /주문 금액/));
  eq("F2", "환불 예정: 수납 정보(금액·일자·수단) 누락 거부", true, has(await rpc(MA, oRef, "refund_plan"), /수납 금액·수납일·수납 수단/));
  eq("F3", "환불 예정: 미래 수납일 거부", true, has(await rpc(MA, oRef, "refund_plan", await recv({ p_received_at: await kst(1) })), /수납일은 오늘 이후일 수 없어요/));
  eq("F4", "환불 예정 기록 성공", null, msg(await rpc(MA, oRef, "refund_plan", await recv())));
  eq("F5", "환불 예정: 주문은 pending 유지, 수강권·결제(매출) 없음 — 환불 전에 완료로 기록하지 않음", ["pending", 0, "refund_planned"], [await st(oRef), await msCount(oRef), (await svc.from("order_expiry_resolutions").select("resolution").eq("order_id", oRef).single()).data.resolution]);
  eq("F6", "환불 예정 주문은 fulfill_order 로 발급 불가", true, (await MA.rpc("fulfill_order", { p_order_id: oRef })).error != null);
  eq("F7", "환불 예정 주문에 다른 처리(취소·기간 조정) 재시도 거부", [true, true], [has(await rpc(MA, oRef, "unpaid_cancel"), /이미 처리가 기록된/), has(await rpc(MA, oRef, "adjust_period", await recv({ p_new_expires_on: await kst(30) })), /이미 처리가 기록된/)]);
  eq("F8", "환불 완료 확인: 환불일이 수납일보다 빠르면 거부", true, has(await rpc(MA, oRef, "refund_complete", { p_reason: "환불", p_refunded_at: await kst(-3) }), /환불일은 수납일보다/));
  eq("F9", "환불 완료 확인은 일반 회원·타 센터 관리자 불가", [true, true], [has(await rpc(A, oRef, "refund_complete", { p_reason: "환불" }), /권한/), has(await rpc(MB, oRef, "refund_complete", { p_reason: "환불" }), /권한/)]);
  eq("F10", "환불 완료 확인 성공 → 주문 cancelled, 이력 refund_completed", [null, "cancelled", "refund_completed"], [msg(await rpc(MA, oRef, "refund_complete", { p_reason: "현금 전액 환불", p_refunded_at: await kst(0) })), await st(oRef), (await svc.from("order_expiry_resolutions").select("resolution").eq("order_id", oRef).single()).data.resolution]);
  eq("F11", "환불 경로는 결제·환불 장부(payments)에 행을 만들지 않는다(중복 기록 없음)", 0, (await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", oRef)).count);
  eq("F12", "환불 완료 재클릭 거부", true, has(await rpc(MA, oRef, "refund_complete", { p_reason: "again" }), /환불 예정으로 기록된 주문만/));
  const oNoPlan = await order(PX); created.push(oNoPlan);
  eq("F13", "환불 예정 없이 환불 완료 처리 거부(환불 안 된 채 완료 기록 불가)", true, has(await rpc(MA, oNoPlan, "refund_complete", { p_reason: "환불" }), /환불 예정으로 기록된 주문만/));

  // ── 3. 수납 확인 + 이용기간 조정 ──
  const oAdj = await order(PX); created.push(oAdj);
  eq("A1", "기간 조정: 새 만료일이 오늘이거나 과거면 거부(오늘 이후만)", [true, true], [has(await rpc(MA, oAdj, "adjust_period", await recv({ p_new_expires_on: await kst(0) })), /오늘\(KST\)보다 뒤/), has(await rpc(MA, oAdj, "adjust_period", await recv({ p_new_expires_on: await kst(-5) })), /오늘\(KST\)보다 뒤/)]);
  eq("A2", "기간 조정: 거부 후에도 주문 pending·수강권/결제 없음", ["pending", 0], [await st(oAdj), await msCount(oAdj)]);
  eq("A3", "기간 조정: 수납 금액 불일치 거부", true, has(await rpc(MA, oAdj, "adjust_period", await recv({ p_received_amount: 79999, p_new_expires_on: await kst(30) })), /주문 금액/));
  const newExp = await kst(30);
  const ra = await rpc(MA, oAdj, "adjust_period", await recv({ p_new_expires_on: newExp }));
  eq("A4", "기간 조정 성공(수납 확인·발급·기간 조정·매출 반영 한 번에)", [null, "done"], [msg(ra), await st(oAdj)]);
  const mem = (await svc.from("payments").select("membership_id,total_amount,direct_amount,status,memo").eq("order_id", oAdj)).data;
  eq("A5", "기간 조정: 결제(매출) 1건 — 금액 80000, 직접결제 구분, paid", [1, 80000, 80000, "paid"], [mem?.length, mem?.[0]?.total_amount, mem?.[0]?.direct_amount, mem?.[0]?.status]);
  const ms = (await svc.from("memberships").select("id,expires_at,product_id,total_count").eq("id", mem?.[0]?.membership_id).single()).data;
  eq("A6", "기간 조정: 이 주문의 수강권 1건에만 새 만료일 적용", [newExp, PX.id, 8], [ms?.expires_at, ms?.product_id, ms?.total_count]);
  eq("A7", "기간 조정: 상품의 expiry_date 는 바뀌지 않음", prodExpiry, (await svc.from("products").select("expiry_date").eq("id", PX.id).single()).data.expiry_date);
  eq("A8", "기간 조정: 처리 이력 기록(수납 수단·금액·새 만료일·수강권 연결)", ["period_adjusted", "cash", 80000, newExp, ms?.id], await (async () => { const r = (await svc.from("order_expiry_resolutions").select("resolution,received_method,received_amount,new_expires_on,membership_id").eq("order_id", oAdj).single()).data; return [r.resolution, r.received_method, r.received_amount, r.new_expires_on, r.membership_id]; })());
  eq("A9", "기간 조정: 결제 메모에 수납 확인 정보", true, /이용기간 조정\(수납 확인: cash/.test(mem?.[0]?.memo ?? ""));
  eq("A10", "중복 클릭/재처리: 두 번째 호출 거부, 결제·수강권 중복 없음", [true, 1], [(await rpc(MA, oAdj, "adjust_period", await recv({ p_new_expires_on: newExp }))).error != null, await msCount(oAdj)]);
  eq("A11", "처리 후 fulfill_order 직접 호출은 멱등(already_done), 중복 매출 없음", [true, 1], [(await MA.rpc("fulfill_order", { p_order_id: oAdj })).data?.already_done ?? false, await msCount(oAdj)]);
  eq("A12", "상품 원래 만료일을 쓰는 다른 주문 발급 경로(새 주문 신규 생성)는 계속 차단(PR #251)", true, (await A.rpc("create_order_secure", { p_product_id: PX.id, p_pay_method: "direct", p_selected_size: null, p_point_used: 0, p_auto_book: false, p_provider: null })).error != null);

  // ── 동시 처리 ──
  const oRace = await order(PX); created.push(oRace);
  const raceExp = await kst(20);
  const race = await Promise.all([rpc(MA, oRace, "adjust_period", await recv({ p_new_expires_on: raceExp })), rpc(MA, oRace, "adjust_period", await recv({ p_new_expires_on: raceExp })), rpc(MA, oRace, "unpaid_cancel")]);
  const ok = race.filter((r) => !r.error).length;
  eq("K1", "동시 3건 처리 요청: 정확히 1건만 성공, 나머지는 거부", 1, ok);
  const fin = await st(oRace);
  eq("K2", "동시 처리 후 상태 일관: done 이면 결제·수강권 정확히 1건, cancelled 면 0건, 이력 1건", true, (fin === "done" && (await msCount(oRace)) === 1) || (fin === "cancelled" && (await msCount(oRace)) === 0));
  eq("K3", "동시 처리 후 이력 1건", 1, await count("order_expiry_resolutions", "order_id", oRace));

  // ── 원자적 롤백: 이력 INSERT 직전(발급·매출 반영 뒤)에 실패하게 만들면 전부 되돌아간다 ──
  const oAtomic = await order(PX); created.push(oAtomic);
  psql(`create or replace function public.exo_fail() returns trigger language plpgsql as $$ begin if new.order_id = '${oAtomic}' then raise exception 'EXO 시험용 강제 실패'; end if; return new; end $$; drop trigger if exists exo_fail_trg on public.order_expiry_resolutions; create trigger exo_fail_trg before insert on public.order_expiry_resolutions for each row execute function public.exo_fail()`);
  try {
    const rf = await rpc(MA, oAtomic, "adjust_period", await recv({ p_new_expires_on: await kst(15) }));
    eq("T1", "원자성: 중간(이력 INSERT) 실패 시 오류 반환", true, has(rf, /EXO 시험용 강제 실패/));
    eq("T2", "원자성: 주문 pending 유지, 결제·수강권·이력 모두 없음(전부 롤백)", ["pending", 0, 0, 0], [await st(oAtomic), await msCount(oAtomic), (await svc.from("memberships").select("id", { count: "exact", head: true }).eq("profile_id", profA).eq("product_id", PX.id).eq("expires_at", await kst(15))).count, await count("order_expiry_resolutions", "order_id", oAtomic)]);
    eq("T3", "원자성: 롤백 뒤에도 만료 주문은 직접 발급 불가(임시 설정이 남지 않음)", true, has(await MA.rpc("fulfill_order", { p_order_id: oAtomic }), /판매 기간이 지난 상품의 주문/));
  
  // ── D. 일반 취소/상태 변경 경로 우회 차단(환불 예정 주문을 환불 완료 확인 전에 닫을 수 없다) — REST PATCH(JWT) 로 직접 시험 ──
  const patch = (cl, id, status) => cl.from("orders").update({ status }).eq("id", id).select("status");
  const dRef = await order(PX); created.push(dRef);
  eq("D0", "준비: 환불 예정 기록", null, msg(await rpc(MA, dRef, "refund_plan", await recv())));
  const rM = await patch(MA, dRef, "cancelled");
  eq("D1", "관리자 REST PATCH pending→cancelled 거부(환불 예정 주문)", ["pending", true], [await st(dRef), !!rM.error || !(rM.data?.length)]);
  const dRef2 = await order(PX); created.push(dRef2); await rpc(MA, dRef2, "refund_plan", await recv());
  const rU = await patch(A, dRef2, "cancelled");
  eq("D2", "회원 본인 취소(REST PATCH) 거부(환불 예정 주문)", ["pending", true], [await st(dRef2), !!rU.error || !(rU.data?.length)]);
  for (const to of ["done", "paid"]) { const r = await patch(MA, dRef, to); eq(`D3-${to}`, `관리자 REST PATCH →${to} 거부(환불 예정 주문)`, "pending", await st(dRef), msg(r) ?? ""); }
  eq("D4", "환불 예정 주문을 fulfill_order 로 발급 거부", true, has(await MA.rpc("fulfill_order", { p_order_id: dRef }), /발급할 수 없어요|판매 기간이 지난 상품의 주문/));
  eq("D5", "환불 예정 주문을 미수납 취소 RPC 로 닫을 수 없다(중복 처리 거부)", true, has(await rpc(MA, dRef, "unpaid_cancel"), /이미 처리가 기록된/));
  eq("D6", "거부 시도 후에도 환불 예정 상태·결제 없음", ["pending", "refund_planned", 0], [await st(dRef), (await svc.from("order_expiry_resolutions").select("resolution").eq("order_id", dRef).single()).data?.resolution, await msCount(dRef)]);
  const e7 = msg(await rpc(MA, dRef, "refund_complete"));
  eq("D7", "전용 RPC refund_complete 만 환불 예정 주문을 취소한다", [null, "cancelled", "refund_completed"], [e7, await st(dRef), (await svc.from("order_expiry_resolutions").select("resolution").eq("order_id", dRef).single()).data?.resolution]);
  await patch(A, dRef, "pending");
  eq("D7b", "refund_complete 이후 REST 로 되살릴 수 없다", "cancelled", await st(dRef));
  eq("D7c", "환불 예정 주문(회원 시도 대상)도 refund_complete 로 정리", [null, "cancelled"], [msg(await rpc(MA, dRef2, "refund_complete")), await st(dRef2)]);
  // 만료 상품 주문(기록 없음)의 REST 직접 발급 우회: PATCH done/paid 거부 — 일반 발급 차단 유지
  const dExp = await order(PX); created.push(dExp);
  for (const to of ["done", "paid"]) { const r = await patch(MA, dExp, to); eq(`D8-${to}`, `만료 상품 주문 REST PATCH →${to} 거부(확정·발급 우회)`, "pending", await st(dExp), msg(r) ?? ""); }
  // 미수납 취소는 전용 RPC 로 정상, 취소 후 재개 불가
  const e9 = msg(await rpc(MA, dExp, "unpaid_cancel"));
  eq("D9", "미수납 취소는 전용 RPC 로 동작(취소·결제 없음·이력 1건)", [null, "cancelled", 0, 1], [e9, await st(dExp), await msCount(dExp), await count("order_expiry_resolutions", "order_id", dExp)]);
  await patch(MA, dExp, "pending");
  eq("D10", "취소된 주문을 REST 로 되살릴 수 없다", "cancelled", await st(dExp));
  // 일반 상품 주문의 기존 취소·발급·회원 자가 취소는 그대로
  const dN1 = await order(PD), dN2 = await order(PD), dN3 = await order(PD);
  eq("D11", "일반 상품: 관리자 REST 취소 정상", "cancelled", (await patch(MA, dN1, "cancelled")).data?.[0]?.status);
  eq("D12", "일반 상품: 회원 본인 취소 정상", "cancelled", (await patch(A, dN2, "cancelled")).data?.[0]?.status);
  const e13 = msg(await MA.rpc("fulfill_order", { p_order_id: dN3 }));
  eq("D13", "일반 상품: 확정·발급 정상(done·결제 1건)", [null, "done", 1], [e13, await st(dN3), await msCount(dN3)]);
  // 만료 상품 주문 + 포인트 사용: 환불 예정→환불 완료 시 포인트 복원(기존 트리거)은 RPC 안에서 그대로 동작
  eq("D14", "RPC 경유 취소의 포인트 복원 경로가 트리거 가드에 막히지 않는다(unpaid_cancel 이미 C 단계에서 확인, 여기서는 refund_complete 상태 전이 성공)", "cancelled", await st(dRef));

  // ── E. 우회 심층 점검: 결제수단/제공자/상품 정보를 바꾼 뒤 상태 변경, 단일 PATCH 결합, 회원·관리자 JWT, 기록 없는 만료 주문의 일반 취소, 내부 설정 위조 ──
  const row = async (id) => (await svc.from("orders").select("status,payment_provider,pay_method,product_id,amount,product_name").eq("id", id).single()).data;
  const upd = (cl, id, obj) => cl.from("orders").update(obj).eq("id", id).select("status");
  const intact = async (id) => { const r = await row(id); return [r.status, r.payment_provider, r.pay_method, r.product_id, r.amount]; };
  const base = [ "pending", null, "direct", PX.id, 80000 ];
  const eO = async () => { const id = await order(PX); created.push(id); return id; };
  { const id = await eO(); await upd(MA, id, { payment_provider: "mock" }); await upd(MA, id, { status: "done" });
    eq("E1", "관리자: payment_provider null→mock 후 status=done 거부(주문 원래 정체성 기준)", base, await intact(id)); }
  { const id = await eO(); await upd(MA, id, { payment_provider: "mock", status: "done" });
    eq("E2", "관리자: payment_provider+status 를 한 PATCH 로 거부", base, await intact(id)); }
  { const id = await eO(); await upd(MA, id, { payment_provider: "mock", status: "cancelled" });
    eq("E2b", "관리자: payment_provider+cancelled 한 PATCH 거부(만료 직접결제 주문은 일반 취소 불가)", base, await intact(id)); }
  { const id = await eO(); await upd(MA, id, { pay_method: "card" }); await upd(MA, id, { status: "done" });
    eq("E3", "관리자: pay_method 변경 후 status=done 거부", base, await intact(id)); }
  { const id = await eO(); await upd(MA, id, { product_id: PD.id, product_name: "변조", amount: 1 }); await upd(MA, id, { status: "done" }); await upd(MA, id, { status: "paid" });
    eq("E4", "관리자: product_id/product_name/amount 변경 후 status 변경 거부", base, await intact(id)); }
  { const id = await eO(); await upd(MA, id, { status: "cancelled" });
    eq("E5", "관리자: 처리 기록 없는 만료 직접결제 주문의 일반 취소 거부(정책: 수납 확인 전 일반 취소 불가)", base, await intact(id)); }
  { const id = await eO(); await upd(A, id, { status: "cancelled" });
    eq("E6", "회원 JWT: 처리 기록 없는 만료 주문 자가 취소 거부", base, await intact(id)); }
  { const id = await eO(); await upd(A, id, { payment_provider: "mock", pay_method: "card", status: "cancelled" });
    eq("E7", "회원 JWT: 제공자·결제수단을 바꾸며 취소 시도 거부", base, await intact(id)); }
  { const id = await eO(); await upd(A, id, { product_id: PD.id, status: "cancelled" });
    eq("E8", "회원 JWT: 상품을 바꾸며 취소 시도 거부", base, await intact(id)); }
  { const id = await order(PD); created.push(id); await upd(MA, id, { payment_provider: "mock" }); const r = await row(id);
    eq("E9", "일반(만료 아님) pending 주문의 제공자 변경도 클라이언트로는 불가(정체성 컬럼 잠금)", null, r.payment_provider); }
  { const id = await order(PD); created.push(id); eq("E10", "일반 상품 주문의 취소(관리자)·확정은 그대로", "cancelled", (await upd(MA, id, { status: "cancelled" })).data?.[0]?.status);
    const id2 = await order(PD); created.push(id2); eq("E10b", "일반 상품 주문 확정·발급 그대로", null, msg(await MA.rpc("fulfill_order", { p_order_id: id2 }))); }
  { // 이미 PG 처리 중(claim 이력)인 주문은 이 가드의 대상이 아님 — 서비스 롤로 만든 승인 대기 NICEPAY 주문의 서버 취소 경로는 불변
    const id = await order(PX, { payment_provider: "nicepay", pay_method: "card" }); created.push(id);
    const r = await svc.from("orders").update({ status: "cancelled" }).eq("id", id).eq("status", "pending").eq("payment_provider", "nicepay").select("status");
    eq("E11", "서버(service_role) NICEPAY 취소 경로 불변", "cancelled", r.data?.[0]?.status); }
  // 내부 설정 위조 가능성: PostgREST 로 set_config 호출/헤더 주입/RPC 사전 설정 모두 불가
  { const f = async (path, init) => (await fetch(url + path, { ...init, headers: { apikey: anon, Authorization: "Bearer " + (await MA.auth.getSession()).data.session.access_token, "Content-Type": "application/json", ...(init?.headers ?? {}) } })).status;
    const s1 = await f("/rest/v1/rpc/set_config", { method: "POST", body: JSON.stringify({ setting_name: "app.expired_order_resolution", new_value: "x", is_local: true }) });
    eq("F1", "PostgREST 로 set_config RPC 호출 불가(노출 안 됨)", true, [404, 401, 403].includes(s1), `status=${s1}`);
    const id = await eO();
    const s2 = await f(`/rest/v1/orders?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }), headers: { "app.expired_order_resolution": id, "x-app-expired-order-resolution": id, Prefer: "return=representation" } });
    eq("F2", "헤더로 내부 설정을 주입해도 PATCH 우회 불가", base, await intact(id), `status=${s2}`);
    const s3 = await MA.rpc("fulfill_order", { p_order_id: id });
    eq("F3", "설정 위조 시도 후에도 fulfill_order 직접 발급 거부", true, has(s3, /판매 기간이 지난 상품의 주문/));
    const bad = await MA.from("order_expiry_authz").insert({ txid: 1, order_id: id }); const bad2 = await MA.from("order_expiry_authz").select("*");
    eq("F4", "내부 인증 테이블은 클라이언트가 쓰거나 읽을 수 없다", [true, true], [!!bad.error, !!bad2.error || !(bad2.data?.length)]);
    const bad3 = await svc.from("order_expiry_authz").select("*"); eq("F5", "정상 처리 후 내부 인증 행이 남지 않는다", 0, bad3.data?.length ?? -1); }
} finally { psql("drop trigger if exists exo_fail_trg on public.order_expiry_resolutions; drop function if exists public.exo_fail()"); }

  // ── 조회·쓰기 권한(RLS) ──
  eq("S1", "처리 이력 조회: 오너 가능(여러 건)", true, ((await MA.from("order_expiry_resolutions").select("order_id")).data ?? []).length >= 3);
  eq("S2", "처리 이력 조회: 일반 회원·타 센터 관리자는 0건", [0, 0], [((await A.from("order_expiry_resolutions").select("order_id")).data ?? []).length, ((await MB.from("order_expiry_resolutions").select("order_id")).data ?? []).length]);
  eq("S3", "처리 이력 직접 쓰기(INSERT/UPDATE/DELETE) 모두 거부", [true, true, true], await (async () => { const a = await MA.from("order_expiry_resolutions").insert({ order_id: oUnknown, center_id: OP, resolution: "refund_completed", reason: "forged" }); const u = await MA.from("order_expiry_resolutions").update({ reason: "x" }).eq("order_id", oCancel).select("id"); const d = await MA.from("order_expiry_resolutions").delete().eq("order_id", oCancel).select("id"); return [a.error != null, (u.error != null) || (u.data ?? []).length === 0, (d.error != null) || (d.data ?? []).length === 0]; })());
  // ── PG·NICEPAY 비영향 ──
  const oPg = await order(PX, { payment_provider: "toss", pay_method: "card" }); created.push(oPg);
  eq("G1", "PG 결제 주문(토스)은 이 기능으로 처리 불가(PG 경로 영향 없음)", true, has(await rpc(MA, oPg, "unpaid_cancel"), /직접결제 주문만/));
  eq("G2", "NICEPAY 게이트·승인 함수·PG 발급 함수 정의 해시 불변", hBefore, guardHashes());
  eq("G3", "NICEPAY 게이트 mode 는 off 그대로", "off", psql("select mode from nicepay_checkout_gate where id"));
  eq("G4", "fulfill_order 의 NICEPAY 가드 블록 유지", true, psql("select position('fulfill_nicepay_guard begin' in pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure)) > 0") === "t");
} finally {
  // 정리(로컬 격리 DB 한정): 시험 주문·수강권·결제·이력·상품·직원
  const ids = (await svc.from("orders").select("id").eq("center_id", OP).eq("product_name", "EXO")).data?.map((o) => o.id) ?? [];
  if (ids.length) {
    const mids = (await svc.from("payments").select("membership_id").in("order_id", ids)).data?.map((p) => p.membership_id).filter(Boolean) ?? [];
    await svc.from("order_expiry_resolutions").delete().in("order_id", ids); await svc.from("point_transactions").delete().in("order_id", ids);
    await svc.from("payments").delete().in("order_id", ids);
    if (mids.length) { await svc.from("admin_action_logs").delete().in("membership_id", mids); await svc.from("memberships").delete().in("id", mids); }
    await svc.from("orders").delete().in("id", ids);
  }
  await svc.from("memberships").delete().eq("profile_id", profA).in("product_id", [PX.id, PD.id]);
  await svc.from("products").delete().in("id", [PX.id, PD.id]);
  await svc.from("manager_centers").delete().eq("account_id", sa.id); await svc.from("role_permissions").delete().eq("role_id", role.id); await svc.from("center_roles").delete().eq("id", role.id);
}
console.log(`\n${res.filter((x) => x.pass).length}/${res.length} PASS, ${fails} FAIL`);
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ failures: fails, results: res }, null, 1)); process.exit(fails ? 1 : 0);
