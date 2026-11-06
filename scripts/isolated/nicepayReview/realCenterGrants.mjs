// 로컬 격리 스택 전용: "지정한 실제 센터를 NICEPAY 심사관에게 보여 주는" 허용 목록(add_nicepay_review_real_center_grants_20261103.sql)의 접근 매트릭스.
// 실제 인증 컨텍스트(계정별 JWT)로 PostgREST/RPC 를 호출해 단언한다. 어긋나면 종료 코드 1. 사용: ISO_ENV_FILE=… node realCenterGrants.mjs <결과.json>
// 사전: setupLocal.sh → setupExtraPersonas.mjs → setupRealCenter.sh. 실제 NICEPAY 호출 0건, 운영/공유 DEV 접근 없음(assertIsolated).
import fs from "node:fs"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const tryPsql = (sql) => { try { return { ok: true, out: psql(sql) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };
const OUT = process.argv[2]; const results = []; let failures = 0;
const rec = (id, name, expected, actual, extra = "") => { const pass = String(expected) === String(actual); if (!pass) failures++; results.push({ id, name, expected, actual, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${expected} / 실제 ${actual}${extra ? " · " + String(extra).slice(0, 140) : ""}`); };
const login = async (e, p) => { const c = createClient(url, anon, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email: e, password: p }); if (error) throw new Error(error.message); const { data: pr } = await c.from("profiles").select("id").limit(1); return { c, profile: pr?.[0]?.id }; };
const WHO = { A: [env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD], B: [env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD], T: [env.TOSS_REVIEWER_EMAIL, env.TOSS_REVIEWER_PASSWORD], MA: [env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD], MB: [env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD], S: [env.SONJW_LIKE_EMAIL, env.SONJW_LIKE_PASSWORD] };
const U = {}; for (const [k, v] of Object.entries(WHO)) U[k] = await login(...v);
const anonC = createClient(url, anon, { auth: { persistSession: false } });
const { data: centers } = await svc.from("centers").select("id,name,is_nicepay_review"); const byName = (n) => centers.find((c) => c.name === n)?.id;
const REAL = byName("[로컬] 실센터 모사"), OP = byName("[QA] 심사 시험 스튜디오"), REV = centers.find((c) => c.is_nicepay_review).id;
const { data: prods } = await svc.from("products").select("id,center_id,name,price"); const P = (n) => prods.find((p) => p.name === n);
const REAL_ACTIVE = ["[로컬] 11월 스케줄링 수강권", "[로컬] 11월 요일고정 수강권", "[로컬] 11월 4주완성 수강권"], EXPIRED = "[로컬] 10월 수강권(만료)";
const accB = psql(`select a.id from accounts a join auth.users u on u.id=a.auth_id where u.email='${env.TEST_USER_B_EMAIL}'`);
const grantSql = (purchase) => `delete from nicepay_review_center_grants; insert into nicepay_review_center_grants(account_id, center_id, can_purchase, note) values ('${accB}','${REAL}',${purchase},'로컬 시험')`;
const clearGrants = () => psql("delete from nicepay_review_center_grants");
const names = (rows) => (rows ?? []).map((r) => r.name).sort().join("|");
// 한 계정이 보는 것: 센터행/상품행/수업행/공개RPC 상품명/구매RPC 건수/기간RPC 건수 (대상 센터별)
async function view(c, center) {
  const ce = await c.from("centers").select("id").eq("id", center); const pr = await c.from("products").select("id").eq("center_id", center); const cl = await c.from("classes").select("id").eq("center_id", center);
  const rs = await c.rpc("fetch_public_storefront_products", { p_center_id: center }); const rp = await c.rpc("fetch_purchasable_products", { p_center_id: center }); const pe = await c.rpc("fetch_public_storefront_product_periods", { p_center_id: center });
  return { center: ce.data?.length ?? 0, products: pr.data?.length ?? 0, classes: cl.data?.length ?? 0, storefront: names(rs.data), purchasable: Array.isArray(rp.data) ? rp.data.length : 0, periods: Array.isArray(pe.data) ? pe.data.length : 0, _rs: rs.data ?? [], _pe: pe.data ?? [] };
}
const brief = (v) => `${v.center}/${v.products}/${v.classes}/${v.storefront ? v.storefront.split("|").length : 0}/${v.purchasable}/${v.periods}`;
const myIds = async (c) => { const r = await c.rpc("nicepay_my_review_center_ids"); return r.error ? "ERR" : (r.data ?? []).map((x) => `${x.center_id === REAL ? "REAL" : x.center_id}:${x.can_purchase}`).join(","); };
const fingerprint = () => psql("select md5(string_agg(x, '|' order by x)) from (select 'o:'||id||status||amount x from orders union all select 'm:'||id||status from memberships union all select 'r:'||id from reservations union all select 'pr:'||id||price||is_on_sale||coalesce(expiry_date::text,'') from products union all select 'c:'||id||status||is_internal||is_nicepay_review from centers union all select 'pay:'||id from payments) s");
const snapBefore = fingerprint();

// ── 1. 허용 목록이 비어 있을 때: 기존 동작과 완전히 동일 ──
clearGrants();
const b0 = await view(U.B.c, REAL), a0 = await view(U.A.c, REAL);
rec("G0a", "허용 전: 심사관B 는 실제 센터가 안 보임(센터/상품/수업/공개RPC/구매RPC/기간RPC = 0)", "0/0/0/0/0/0", brief(b0));
rec("G0b", "허용 전: 심사관B 는 심사 센터는 보임", true, (await view(U.B.c, REV)).center === 1);
rec("G0c", "허용 전: 일반회원A 는 실제 센터와 11월 상품 3종을 봄(만료 10월 상품은 공개RPC 제외)", REAL_ACTIVE.slice().sort().join("|"), a0.storefront);
rec("G0d", "허용 전: nicepay_my_review_center_ids 는 비어 있음", "", await myIds(U.B.c));

// ── 2. 조회 전용 허용(can_purchase=false) ──
psql(grantSql(false));
const b1 = await view(U.B.c, REAL);
rec("G1a", "조회 허용: 심사관B 가 실제 센터를 봄 (센터 1)", 1, b1.center);
rec("G1b", "조회 허용: 공개 RPC 가 11월 수강권 3종만 반환(만료 10월 제외)", REAL_ACTIVE.slice().sort().join("|"), b1.storefront);
rec("G1c", "조회 허용: 구매 가능 RPC 3종, 기간 RPC 3종", "3/3", `${b1.purchasable}/${b1.periods}`);
rec("G1d", "조회 허용: 상품 행 4(만료 포함 — 목록 RPC 가 거르고, 신규 주문은 별도 정책이 막음), 수업 1", "4/1", `${b1.products}/${b1.classes}`);
const dbRows = Object.fromEntries(prods.filter((p) => p.center_id === REAL).map((p) => [p.name, p.price]));
rec("G1e", "조회 허용: 표시 가격이 DB 와 일치(공개 RPC price == products.price)", "true", String(b1._rs.every((r) => dbRows[r.name] === r.price)));
rec("G1f", "조회 허용: 기간 RPC 의 만료일이 DB 와 일치(date 2026-11-28)", "true", String(b1._pe.length === 3 && b1._pe.every((r) => r.expiry_mode === "date" && String(r.expiry_date) === "2026-11-28")));
rec("G1g", "조회 허용: 다른 운영 센터([QA] 심사 시험 스튜디오)는 기존처럼 안 보임", "0/0/0/0/0/0", brief(await view(U.B.c, OP)));
rec("G1h", "조회 허용: 기존 심사 센터는 그대로 보임", true, (await view(U.B.c, REV)).center === 1 && (await view(U.B.c, REV)).purchasable >= 1);
rec("G1i", "조회 허용: nicepay_my_review_center_ids = REAL:false", "REAL:false", await myIds(U.B.c));
rec("G1j", "허용 목록은 다른 계정에 영향 없음(일반회원A·토스 심사관T·운영 매니저 MA 의 my_ids 비어 있음)", ",,", [await myIds(U.A.c), await myIds(U.T.c), await myIds(U.MA.c)].join(","));
rec("G1k", "일반회원A 의 실제 센터 조회는 허용 전과 동일", a0.storefront, (await view(U.A.c, REAL)).storefront);
rec("G1l", "비로그인도 실제 센터 공개 RPC 는 기존과 같음(3종), 허용 목록 테이블은 읽을 수 없음", "3/DENIED", `${(await anonC.rpc("fetch_public_storefront_products", { p_center_id: REAL })).data?.length}/${(await anonC.from("nicepay_review_center_grants").select("*")).error ? "DENIED" : "READ"}`);
rec("G1m", "일반회원A 는 허용 목록 테이블을 읽거나 쓸 수 없음", "DENIED/DENIED", `${(await U.A.c.from("nicepay_review_center_grants").select("*")).error ? "DENIED" : "READ"}/${(await U.A.c.from("nicepay_review_center_grants").insert({ account_id: accB, center_id: REAL })).error ? "DENIED" : "WROTE"}`);
rec("G1n", "심사관B 본인도 허용 목록을 스스로 늘릴 수 없음", "DENIED", (await U.B.c.from("nicepay_review_center_grants").insert({ account_id: accB, center_id: OP, can_purchase: true })).error ? "DENIED" : "WROTE");

// 쓰기 가드: can_purchase=false → 주문·장바구니·구매신청 모두 거부(센터 가드 메시지)
const real = P("[로컬] 11월 4주완성 수강권");
const ord = (who) => ({ center_id: REAL, profile_id: who.profile, product_id: real.id, product_name: real.name, amount: real.price, pay_method: "direct" });
const guardMsg = (e) => (e && /이용할 수 없어요/.test(e.message) ? "GUARD" : e ? "OTHER:" + e.message.slice(0, 40) : "CREATED");
rec("W1a", "조회 허용(can_purchase=false): 심사관B 직접결제 주문 생성 → 센터 가드 거부", "GUARD", guardMsg((await U.B.c.from("orders").insert(ord(U.B)).select("id").single()).error));
rec("W1b", "조회 허용: 장바구니 담기 거부", "GUARD", guardMsg((await U.B.c.from("cart_items").insert({ profile_id: U.B.profile, center_id: REAL, product_id: real.id, product_name: real.name }).select("id").single()).error));
rec("W1c", "조회 허용: 구매신청 거부", "GUARD", guardMsg((await U.B.c.from("purchase_requests").insert({ center_id: REAL, profile_id: U.B.profile, product_name: real.name }).select("id").single()).error));
const rpcOrder = await U.B.c.rpc("create_order_secure", { p_product_id: real.id, p_pay_method: "direct", p_selected_size: null, p_point_used: 0, p_auto_book: false, p_provider: null });
rec("W1d", "조회 허용: create_order_secure RPC 도 거부(주문 행이 만들어지지 않음)", "DENIED", rpcOrder.error ? "DENIED" : "CREATED", rpcOrder.error?.message);

// ── 3. 구매 허용(can_purchase=true): 주문 경로 열림, 카드 결제 게이트는 여전히 심사 센터 전용 ──
psql(grantSql(true));
rec("G2a", "구매 허용: nicepay_my_review_center_ids = REAL:true", "REAL:true", await myIds(U.B.c));
const o2 = await U.B.c.from("orders").insert(ord(U.B)).select("id").single(); rec("W2a", "구매 허용: 심사관B 직접결제 주문 생성(결제 아님)", "CREATED", guardMsg(o2.error)); if (o2.data) await svc.from("orders").delete().eq("id", o2.data.id);
const expired = P(EXPIRED); const oe = await U.B.c.from("orders").insert({ ...ord(U.B), product_id: expired.id, product_name: expired.name, amount: expired.price }).select("id").single();
rec("W2b", "구매 허용이어도 만료된 10월 상품 신규 주문은 거부", "DENIED", oe.error ? "DENIED" : "CREATED", oe.error?.message); if (oe.data) await svc.from("orders").delete().eq("id", oe.data.id);
const oa = await U.A.c.from("orders").insert({ ...ord(U.A), product_id: expired.id, product_name: expired.name, amount: expired.price }).select("id").single();
rec("W2c", "일반회원A 도 만료 10월 상품 신규 주문 거부(기존 만료 정책 유지)", "DENIED", oa.error ? "DENIED" : "CREATED", oa.error?.message); if (oa.data) await svc.from("orders").delete().eq("id", oa.data.id);
const oaOk = await U.A.c.from("orders").insert(ord(U.A)).select("id").single(); rec("W2d", "일반회원A 의 실제 센터 11월 상품 주문은 기존처럼 가능", "CREATED", guardMsg(oaOk.error)); if (oaOk.data) await svc.from("orders").delete().eq("id", oaOk.data.id);
psql("update nicepay_checkout_gate set mode='reviewer', updated_at=now() where id");
const nic = { ...ord(U.B), pay_method: "card", payment_provider: "nicepay" }; const on = await U.B.c.from("orders").insert(nic).select("id").single();
rec("W2e", "구매 허용 + 게이트 reviewer: 실제 센터 상품의 NICEPAY 카드 주문은 거부(카드 결제는 심사 센터만 — 결제 활성화 아님)", "DENIED", on.error ? "DENIED" : "CREATED", on.error?.message); if (on.data) await svc.from("orders").delete().eq("id", on.data.id);
const revP = prods.find((p) => p.center_id === REV); const onRev = await U.B.c.from("orders").insert({ center_id: REV, profile_id: U.B.profile, product_id: revP.id, product_name: revP.name, amount: revP.price, pay_method: "card", payment_provider: "nicepay" }).select("id").single();
rec("W2f", "게이트 reviewer: 기존 심사 센터 상품의 NICEPAY 주문은 기존처럼 가능", "CREATED", onRev.error ? "DENIED" : "CREATED", onRev.error?.message); if (onRev.data) psql(`begin; set local session_replication_role = replica; delete from nicepay_review_actions where order_id='${onRev.data.id}'; delete from orders where id='${onRev.data.id}'; commit;`);
psql("update nicepay_checkout_gate set mode='off', updated_at=now() where id");

// ── 4. 다른 계정·역할의 규칙 불변 ──
const opB = await view(U.B.c, OP); rec("R1", "구매 허용이어도 다른 운영 센터는 심사관B 에게 계속 숨김", "0/0/0/0/0/0", brief(opB));
rec("R2", "토스 심사관T: 실제 센터·운영 센터 가시성은 일반 회원과 같음", `${(await view(U.A.c, REAL)).storefront}/${(await view(U.A.c, OP)).center}`, `${(await view(U.T.c, REAL)).storefront}/${(await view(U.T.c, OP)).center}`);
rec("R3", "운영 센터 매니저MA·플랫폼 규칙: 운영 센터는 기존처럼 보임", 1, (await view(U.MA.c, OP)).center);
rec("R4", "심사 센터 매니저MB: 심사 센터 관리 가시성 유지", 1, (await view(U.MB.c, REV)).center);
rec("R5", "심사관 겸 매니저 S: 실제 센터는 허용이 없으므로 안 보임(구매 규칙은 매니저 예외 없음)", "0", String((await view(U.S.c, REAL)).purchasable));


// ── 6. 조회 전용 권한의 유지: UPDATE·기존 주문/예약 상태 변경·서버 RPC (can_purchase=false) ──
psql(grantSql(false));
const realP = P("[로컬] 11월 4주완성 수강권"), realP2 = P("[로컬] 11월 스케줄링 수강권"), opP = prods.find((p) => p.center_id === OP);
const svcOrder = async (extra = {}) => (await svc.from("orders").insert({ center_id: REAL, profile_id: U.B.profile, product_id: realP.id, product_name: realP.name, amount: realP.price, pay_method: "direct", ...extra }).select("id").single());
const o6 = await svcOrder(); rec("U0", "서버(service_role)는 허용 여부와 무관하게 주문 생성 가능(서버 경로 불변)", "CREATED", o6.error ? "DENIED" : "CREATED", o6.error?.message);
const oid = o6.data?.id; const col = (t, id, c) => psql(`select ${c} from ${t} where id='${id}'`);
const upd = async (table, id, patch) => { const r = await U.B.c.from(table).update(patch).eq("id", id).select("id"); return r.error ? guardMsg(r.error) : (r.data?.length ? "UPDATED" : "NOROW"); };
rec("U1", "조회 전용: 기존 주문의 상품을 다른 상품으로 바꾸는 UPDATE 는 거부(또는 행 없음)이고 DB 값 불변", `${realP.id}|true`, `${col("orders", oid, "product_id")}|${["GUARD", "NOROW"].includes(await upd("orders", oid, { product_id: realP2.id })) || col("orders", oid, "product_id") === realP.id}`);
rec("U2", "조회 전용: 기존 주문의 센터를 다른 운영 센터로 바꾸는 UPDATE 거부, DB 값 불변", `${REAL}`, (await upd("orders", oid, { center_id: OP, product_id: opP.id }), col("orders", oid, "center_id")));
const cancelRes = await upd("orders", oid, { status: "cancelled" });
rec("U3", "조회 전용: 기존(사전에 있던) 주문의 상태 변경은 센터 가드가 막지 않는다(사후 처리 보존 — 가드 메시지가 아님)", "true", String(cancelRes !== "GUARD"), `결과 ${cancelRes}`);
const ci = await svc.from("cart_items").insert({ profile_id: U.B.profile, center_id: REAL, product_id: realP.id, product_name: realP.name }).select("id").single();
rec("U4", "조회 전용: 장바구니 항목의 상품을 바꾸는 UPDATE 거부, DB 값 불변", `${realP.id}`, (await upd("cart_items", ci.data.id, { product_id: realP2.id }), col("cart_items", ci.data.id, "product_id")));
const clsId = psql(`select id from classes where center_id='${REAL}' limit 1`);
const mem = await svc.from("memberships").insert({ profile_id: U.B.profile, center_id: REAL, product_name: "[로컬] 시험 수강권", pass_type: "count", total_count: 4, remaining_count: 4 }).select("id").single();
const rs1 = await U.B.c.rpc("reserve_class", { p_class_id: clsId, p_profile_id: U.B.profile });
rec("U5", "조회 전용: reserve_class RPC 거부(센터 가드)", "GUARD", rs1.error ? guardMsg(rs1.error) : "CREATED", rs1.error?.message);
const rs2 = await U.B.c.rpc("reserve_with_membership", { p_class_id: clsId, p_profile_id: U.B.profile, p_membership_id: mem.data.id });
rec("U6", "조회 전용: reserve_with_membership RPC(수강권이 이미 있어도) 거부", "GUARD", rs2.error ? guardMsg(rs2.error) : "CREATED", rs2.error?.message);
const resv = await svc.from("reservations").insert({ class_id: clsId, profile_id: U.B.profile, membership_id: mem.data.id, status: "confirmed" }).select("id").single();
rec("U7", "서버(service_role)의 예약 생성은 가능(서버 경로 불변)", "CREATED", resv.error ? "DENIED" : "CREATED", resv.error?.message);
const cr = resv.data ? await U.B.c.rpc("cancel_reservation", { p_reservation_id: resv.data.id }) : { error: { message: "no reservation" } };
rec("U8", "조회 전용: 사전에 있던 예약의 본인 취소는 센터 가드가 막지 않는다(사후 처리 보존)", "true", String(!(cr.error && /이용할 수 없어요/.test(cr.error.message))), cr.error?.message ?? "ok");
const cleanup = () => psql(`begin; set local session_replication_role = replica; delete from reservations where profile_id='${U.B.profile}' and class_id='${clsId}'; delete from memberships where id='${mem.data.id}'; delete from cart_items where id='${ci.data.id}'; delete from orders where id='${oid}'; commit;`);
cleanup();

// ── 7. 센터 상태 변화 시 허용 즉시 무효 (승인 취소·내부 전환) — 사용자·관리자 동작 불변 ──
psql(grantSql(true));
const setCenter = (sql) => psql(`begin; set local session_replication_role = replica; ${sql}; commit;`);
const baseA = brief(await view(U.A.c, REAL)), baseMA = (await view(U.MA.c, OP)).center;
rec("I0", "허용(구매 포함) 상태: 심사관B 가 보고 구매 가능", "1|true", `${(await view(U.B.c, REAL)).center}|${guardMsg((await U.B.c.from("orders").insert(ord(U.B)).select("id").single()).error) === "CREATED"}`);
await svc.from("orders").delete().eq("profile_id", U.B.profile).eq("center_id", REAL);
setCenter(`update centers set status='pending' where id='${REAL}'`);
rec("I1", "센터 승인 취소(pending) → 허용 즉시 무효: B 가 못 봄, my_ids 비어 있음", "0/0/0/0/0/0|", `${brief(await view(U.B.c, REAL))}|${await myIds(U.B.c)}`);
rec("I1b", "승인 취소 중 B 의 구매 시도는 거부(서비스 계정 외 주문 불가)", "DENIED", (await U.B.c.from("orders").insert(ord(U.B)).select("id").single()).error ? "DENIED" : "CREATED");
setCenter(`update centers set status='approved' where id='${REAL}'`);
rec("I2", "다시 승인되면 허용 행이 그대로 되살아남", "1|REAL:true", `${(await view(U.B.c, REAL)).center}|${await myIds(U.B.c)}`);
setCenter(`update centers set is_internal=true where id='${REAL}'`);
rec("I3", "내부 센터로 전환 → 허용 즉시 무효", "0/0/0/0/0/0|", `${brief(await view(U.B.c, REAL))}|${await myIds(U.B.c)}`);
setCenter(`update centers set is_internal=false where id='${REAL}'`);
rec("I4", "내부 전환을 되돌리면 되살아남", "1", String((await view(U.B.c, REAL)).center));
rec("I5", "그 동안 일반회원 A·운영 매니저 MA 의 가시성은 원래 값과 같음(허용 목록 영향 없음)", `${baseA}|${baseMA}`, `${brief(await view(U.A.c, REAL))}|${(await view(U.MA.c, OP)).center}`);

// ── 5. 허용 해제·권한 회수 ──
clearGrants(); rec("X1", "허용 삭제 후 심사관B 에게 실제 센터가 다시 숨겨짐", "0/0/0/0/0/0", brief(await view(U.B.c, REAL)));
psql(grantSql(false)); psql(`update accounts set nicepay_review_access=false where id='${accB}'`);
const gone = await view(U.B.c, REAL); rec("X2", "심사관 권한을 끄면 허용 행이 있어도 효력 없음 → 일반 회원처럼 보임(공개 RPC 3종)", REAL_ACTIVE.slice().sort().join("|"), gone.storefront, "권한이 꺼진 계정은 일반 회원과 같은 규칙");
rec("X2b", "심사관 권한을 끄면 my_ids 도 빔", "", await myIds(U.B.c));
psql(`update accounts set nicepay_review_access=true where id='${accB}'`);
// 허용 대상 제한: 내부/심사 센터는 지정 불가, 심사관 권한 없는 계정 지정 불가
const accA = psql(`select a.id from accounts a join auth.users u on u.id=a.auth_id where u.email='${env.TEST_USER_A_EMAIL}'`);
rec("V1", "내부(QA) 센터를 허용 목록에 넣을 수 없음", "DENIED", tryPsql(`insert into nicepay_review_center_grants(account_id,center_id) values ('${accB}','${byName("[토스 심사용] 로컬 시험 센터")}')`).ok ? "WROTE" : "DENIED");
rec("V2", "기존 심사 센터를 허용 목록에 넣을 수 없음(자체 규칙)", "DENIED", tryPsql(`insert into nicepay_review_center_grants(account_id,center_id) values ('${accB}','${REV}')`).ok ? "WROTE" : "DENIED");
rec("V3", "심사관 권한이 없는 계정(일반회원A)을 지정할 수 없음", "DENIED", tryPsql(`insert into nicepay_review_center_grants(account_id,center_id) values ('${accA}','${REAL}')`).ok ? "WROTE" : "DENIED");
clearGrants();
rec("Z1", "시험 전후 운영성 데이터(주문·수강권·예약·상품·센터·결제) 지문 동일", snapBefore, fingerprint());

fs.writeFileSync(OUT ?? "real-center-grants.json", JSON.stringify({ at: new Date().toISOString(), failures, results }, null, 2));
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAIL"} (${results.length} checks)`); process.exit(failures ? 1 : 0);
