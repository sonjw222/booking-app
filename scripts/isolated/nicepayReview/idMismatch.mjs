// 로컬 격리 스택 전용: 서로 다른 운영 센터 간 잘못된 ID 조합(주문·장바구니·구매신청·수강권·예약)과 정상 흐름(주문·예약·취소·NULL 허용) 단언. 하나라도 어긋나면 종료 코드 1.
// 사용: ISO_ENV_FILE=… node idMismatch.mjs [결과.json]
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tag = crypto.randomBytes(3).toString("hex"); let failures = 0; const results = [];
const expectEq = (id, name, expected, actual, extra = "") => { const pass = expected === actual; if (!pass) failures++; results.push({ id, name, expected, actual, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${expected} / 실제 ${actual}${extra ? " · " + extra : ""}`); };
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const errOf = (e) => (e ? String(e.message ?? e).slice(0, 50) : "");
const login = async (e, p) => { const c = createClient(url, anon, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email: e, password: p }); if (error) throw new Error("login " + error.message); const { data: pr } = await c.from("profiles").select("id").limit(1); return { c, profile: pr?.[0]?.id, uid: (await c.auth.getUser()).data.user.id }; };
const A = await login(env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD), MA = await login(env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD);
// ── 데이터(서비스 롤): 운영 센터 2개(OP, OP2) + 상품 + 수업 + A 의 수강권 ──
const mkCenter = async (name) => { const c = (await svc.from("centers").insert({ name, status: "approved", is_internal: false }).select("id").single()).data; await svc.from("center_settings").insert({ center_id: c.id }); return c.id; };
const OP = await mkCenter(`[IDM] 운영센터1-${tag}`), OP2 = await mkCenter(`[IDM] 운영센터2-${tag}`);
const mkProd = async (c, n) => (await svc.from("products").insert({ center_id: c, name: n, price: 10000, product_kind: "pass", pass_type: "count", total_count: 5, expiry_mode: "days", expiry_days: 30, is_active: true, is_on_sale: true, visibility_type: "all" }).select("id").single()).data.id;
const P1 = await mkProd(OP, `IDM상품1-${tag}`), P2 = await mkProd(OP2, `IDM상품2-${tag}`);
const { data: accA } = await svc.from("accounts").select("id").eq("auth_id", A.uid).single(); const { data: accM } = await svc.from("accounts").select("id").eq("auth_id", MA.uid).single();
await svc.from("manager_centers").insert({ account_id: accM.id, center_id: OP, status: "active" });
const mkMem = async (c, p) => (await svc.from("memberships").insert({ profile_id: A.profile, center_id: c, product_id: p, product_name: "IDM수강권", pass_type: "count", total_count: 5, remaining_count: 5 }).select("id").single()).data.id;
const M1 = await mkMem(OP, P1), M2 = await mkMem(OP2, P2);
const mkClass = async (title, h) => (await svc.from("classes").insert({ center_id: OP, title, start_time: new Date(Date.now() + h * 36e5).toISOString(), end_time: new Date(Date.now() + (h + 1) * 36e5).toISOString(), capacity: 10 }).select("id").single()).data.id;
const C1 = await mkClass(`IDM수업1-${tag}`, 50), C2 = await mkClass(`IDM수업2-${tag}`, 52), C3 = await mkClass(`IDM수업3-${tag}`, 54);
const ord = (center, product) => ({ center_id: center, profile_id: A.profile, product_id: product, product_name: "x", amount: 10000, pay_method: "direct", payment_provider: null });
const res = (r) => (r.error ? "DENIED" : "CREATED");
// ── 주문 ──
let r = await A.c.from("orders").insert(ord(OP, P1)).select("id").single(); expectEq("O1", "정상 주문(센터=상품 센터)", "CREATED", res(r), errOf(r.error)); const okOrder = r.data?.id;
r = await A.c.rpc("create_order_secure", { p_product_id: P1, p_pay_method: "direct", p_selected_size: null, p_point_used: 0, p_auto_book: false, p_provider: null }); expectEq("O2", "정상 주문(create_order_secure RPC)", "CREATED", r.error ? "DENIED" : "CREATED", errOf(r.error));
r = await A.c.from("orders").insert(ord(OP, P2)).select("id").single(); expectEq("O3", "운영 센터 간 불일치(center=센터1, product=센터2 상품)", "DENIED", res(r), errOf(r.error));
r = await A.c.from("orders").insert(ord(OP2, P1)).select("id").single(); expectEq("O4", "운영 센터 간 불일치(center=센터2, product=센터1 상품)", "DENIED", res(r), errOf(r.error));
r = await A.c.from("orders").insert(ord(OP, null)).select("id").single(); expectEq("O5", "product_id 가 NULL 인 주문은 기존대로 허용(NULL 은 일치 검사 제외)", "CREATED", res(r), errOf(r.error));
r = await svc.from("orders").insert(ord(OP, P2)).select("id").single(); expectEq("O6", "서버(service_role) 경로는 이 검사를 받지 않는다(기존 서버 처리 유지)", "CREATED", res(r), errOf(r.error));
if (okOrder) { r = await A.c.from("orders").update({ status: "cancelled" }).eq("id", okOrder).select("id"); expectEq("O7", "본인 대기 주문 취소(UPDATE status)는 정상", "UPDATED", r.error ? "DENIED" : (r.data?.length ? "UPDATED" : "0ROWS"), errOf(r.error)); }
// ── 장바구니·구매신청 ──
const cart = (c, p) => ({ profile_id: A.profile, center_id: c, product_id: p, product_name: "x" });
r = await A.c.from("cart_items").insert(cart(OP, P1)).select("id").single(); expectEq("C1", "정상 장바구니", "CREATED", res(r), errOf(r.error));
r = await A.c.from("cart_items").insert(cart(OP, P2)).select("id").single(); expectEq("C2", "장바구니 불일치", "DENIED", res(r), errOf(r.error));
const pr = (c, p) => ({ center_id: c, profile_id: A.profile, product_id: p, product_name: "x" });
r = await A.c.from("purchase_requests").insert(pr(OP, P1)).select("id").single(); expectEq("P1", "정상 구매신청", "CREATED", res(r), errOf(r.error));
r = await A.c.from("purchase_requests").insert(pr(OP, P2)).select("id").single(); expectEq("P2", "구매신청 불일치", "DENIED", res(r), errOf(r.error));
r = await A.c.from("purchase_requests").insert(pr(OP, null)).select("id").single(); expectEq("P3", "구매신청 product_id NULL 은 허용", "CREATED", res(r), errOf(r.error));
// ── 수강권(클라이언트 역할 + 해당 테이블 RLS 만 끈 트랜잭션 — 트리거 자체를 격리해 시험) ──
const memTry = (center, product) => { try { psql(`begin; alter table memberships disable row level security; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${A.uid}","role":"authenticated"}', true); insert into memberships(profile_id, center_id, product_id, product_name, pass_type) values ('${A.profile}', '${center}', ${product ? `'${product}'` : "null"}, 'x', 'count'); rollback;`); return "CREATED"; } catch (e) { return /일치하지|이용할 수 없/.test(String(e.stderr)) ? "DENIED" : "ERR:" + String(e.stderr).slice(0, 80); } };
expectEq("M1", "수강권 정상(센터=상품 센터)", "CREATED", memTry(OP, P1)); expectEq("M2", "수강권 불일치(center=센터1, product=센터2 상품)", "DENIED", memTry(OP, P2)); expectEq("M3", "수동 발급처럼 product_id NULL 은 허용", "CREATED", memTry(OP, null));
// ── 예약(매니저 RPC — 클라이언트는 reservations INSERT 권한이 없다) ──
r = await MA.c.rpc("manager_book_member", { p_class_id: C1, p_profile_id: A.profile, p_membership_id: M1, p_deduct: true }); expectEq("R1", "매니저가 같은 센터 수강권으로 예약(정상)", "CREATED", r.error ? "DENIED" : "CREATED", errOf(r.error)); const resId = r.data?.reservation_id ?? r.data?.id ?? (typeof r.data === "string" ? r.data : null);
r = await MA.c.rpc("manager_book_member", { p_class_id: C2, p_profile_id: A.profile, p_membership_id: M2, p_deduct: true }); expectEq("R2", "매니저가 다른 센터 수강권으로 예약 시도(수업 센터 ≠ 수강권 센터)", "DENIED", r.error ? "DENIED" : "CREATED", errOf(r.error));
r = await MA.c.rpc("manager_book_member", { p_class_id: C3, p_profile_id: A.profile, p_membership_id: null, p_deduct: false }); expectEq("R3", "수강권 없이(membership_id NULL) 예약은 기존대로 허용", "CREATED", r.error ? "DENIED" : "CREATED", errOf(r.error));
const { data: myRes } = await svc.from("reservations").select("id,status").eq("profile_id", A.profile).eq("class_id", C1).maybeSingle();
if (myRes) { r = await A.c.rpc("cancel_reservation", { p_reservation_id: myRes.id }); expectEq("R4", "회원 본인의 예약 취소는 정상", "CREATED", r.error ? "DENIED" : "CREATED", errOf(r.error)); }
// ── 정리 ──
for (const id of [C1, C2, C3]) { await svc.from("reservations").delete().eq("class_id", id); await svc.from("classes").delete().eq("id", id); }
await svc.from("memberships").delete().in("id", [M1, M2]); await svc.from("orders").delete().in("center_id", [OP, OP2]); await svc.from("cart_items").delete().in("center_id", [OP, OP2]); await svc.from("purchase_requests").delete().in("center_id", [OP, OP2]);
await svc.from("manager_centers").delete().eq("center_id", OP); await svc.from("products").delete().in("center_id", [OP, OP2]); await svc.from("center_settings").delete().in("center_id", [OP, OP2]); await svc.from("centers").delete().in("id", [OP, OP2]);
console.log(`\n${results.filter((x) => x.pass).length}/${results.length} PASS, ${failures} FAIL`); if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ failures, results }, null, 1)); process.exit(failures ? 1 : 0);
