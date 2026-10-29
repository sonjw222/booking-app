// 로컬 격리 스택 전용: 만료 상품 자동 노출 종료(fix_expired_fixed_date_products_20261031.sql 적용 상태)를 실제 PostgREST·JWT 로 검증한다. 단언(어긋나면 종료 코드 1).
// 사용: ISO_ENV_FILE=… node verify.mjs <결과.json>   — 시험 상품은 만들었다가 끝에서 정리한다(로컬 격리 DB 한정).
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const res = []; let fails = 0; const eq = (id, name, exp, act, extra = "") => { const pass = JSON.stringify(exp) === JSON.stringify(act); if (!pass) fails++; res.push({ id, name, expected: exp, actual: act, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${JSON.stringify(exp)} / 실제 ${JSON.stringify(act)}${extra ? " · " + extra : ""}`); };
const login = async (e, p) => { const c = createClient(url, anon, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email: e, password: p }); if (error) throw new Error(error.message); return c; };
const kst = (d = 0) => psql(`select to_char((now() at time zone 'Asia/Seoul')::date + ${d}, 'YYYY-MM-DD')`);
const tag = crypto.randomBytes(2).toString("hex"); const N = (s) => `EXP-${tag}-${s}`;

const centers = (await svc.from("centers").select("id,name,is_nicepay_review")).data; const OP = centers.find((c) => c.name === "[QA] 심사 시험 스튜디오").id, REV = centers.find((c) => c.is_nicepay_review).id;
const A = await login(env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD), B = await login(env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD), MA = await login(env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD);
const anonC = createClient(url, anon, { auth: { persistSession: false } });
// 로컬 페르소나의 매니저는 역할이 없어 권한이 없다 — 이 시험에서는 운영 센터 오너 역할을 부여한다(로컬 격리 DB 한정 — 마지막 활성 오너 보호 트리거 때문에 원복하지 않는다)
const maRow = psql(`select mc.id from manager_centers mc join accounts a on a.id = mc.account_id where mc.center_id = '${OP}' and a.auth_id = (select id from auth.users where email = '${env.TEST_MANAGER_A_EMAIL}')`);
psql(`update manager_centers set role_id = (select id from center_roles where center_id = '${OP}' and is_owner) where id = '${maRow}'`);
const mk = async (center, s, mode, offset, extra = {}) => { const r = await svc.from("products").insert({ center_id: center, name: N(s), price: 10000, product_kind: "pass", pass_type: "count", total_count: 5, is_active: true, is_on_sale: true, visibility_type: "all", expiry_mode: mode, expiry_date: mode === "date" ? kst(offset) : null, expiry_days: mode === "days" ? offset : null, ...extra }).select("id").single(); if (r.error) throw new Error(r.error.message); return r.data.id; };
const P = { y: await mk(OP, "어제", "date", -1), t: await mk(OP, "오늘", "date", 0), n: await mk(OP, "내일", "date", 1), d30: await mk(OP, "30일", "days", 30), d60: await mk(OP, "60일", "days", 60), d90: await mk(OP, "90일", "days", 90), none: await mk(OP, "무기한", "none", 0), rev_y: await mk(REV, "심사어제", "date", -1), rev_t: await mk(REV, "심사오늘", "date", 0) };
const mine = (rows, key = "name") => (rows ?? []).filter((r) => String(r[key]).startsWith(`EXP-${tag}`)).map((r) => r[key].replace(`EXP-${tag}-`, "")).sort();
const base = ["30일", "60일", "90일", "내일", "무기한", "오늘"];
try {
  const pubAnon = await anonC.rpc("fetch_public_storefront_products", { p_center_id: OP }); eq("L1", "비로그인 공개 목록: 어제 만료만 제외, 오늘·내일·30/60/90·무기한 유지", base, mine(pubAnon.data));
  const perAnon = await anonC.rpc("fetch_public_storefront_product_periods", { p_center_id: OP }); const perIds = (perAnon.data ?? []).map((r) => r.product_id); eq("L2", "비로그인 기간 RPC: 어제 제외, 오늘·내일 포함", [false, true, true], [perIds.includes(P.y), perIds.includes(P.t), perIds.includes(P.n)]);
  eq("L3", "비로그인 전체 목록(센터 미지정)에도 어제 만료 없음", false, mine((await anonC.rpc("fetch_public_storefront_products", {})).data).includes("어제"));
  const memA = await A.rpc("fetch_purchasable_products", { p_center_id: OP }); eq("L4", "로그인 회원 구매 목록: 어제 만료만 제외", base, mine(memA.data));
  const adm = await MA.from("products").select("id,name,is_on_sale,is_active,expiry_date").eq("center_id", OP); eq("L5", "관리자(매니저) 상품 관리 조회: 만료 상품도 그대로 보임", true, mine(adm.data).includes("어제") && adm.data.find((r) => r.id === P.y).is_on_sale === true);
  // 신규 주문
  const direct = async (cl, pid, center) => { const prof = (await cl.from("profiles").select("id").limit(1)).data[0].id; const r = await cl.from("orders").insert({ center_id: center, profile_id: prof, product_id: pid, product_name: "x", amount: 10000, pay_method: "direct", payment_provider: "mock", status: "pending" }).select("id").single(); if (!r.error) await svc.from("orders").delete().eq("id", r.data.id); return r.error ? "DENIED(" + (r.error.code ?? r.status) + ")" : "CREATED"; };
  eq("O1", "직접 INSERT: 어제 만료 상품 신규 주문 거부(RLS)", "DENIED(42501)", await direct(A, P.y, OP));
  for (const [k, id] of [["t", P.t], ["n", P.n], ["d30", P.d30], ["d60", P.d60], ["d90", P.d90], ["none", P.none]]) eq(`O2-${k}`, `직접 INSERT: ${k} 상품 신규 주문 허용`, "CREATED", await direct(A, id, OP));
  const sec = async (cl, pid) => { const r = await cl.rpc("create_order_secure", { p_product_id: pid, p_pay_method: "direct", p_selected_size: null, p_point_used: 0, p_auto_book: false, p_provider: "mock" }); if (!r.error && r.data) await svc.from("orders").delete().eq("id", r.data); return r.error ? r.error.message : "CREATED"; };
  eq("O3", "create_order_secure: 어제 만료 직접 호출 거부(만료 메시지)", true, /판매 기간이 지난 상품/.test(await sec(A, P.y)));
  eq("O4", "create_order_secure: 오늘·내일 만료 허용", ["CREATED", "CREATED"], [await sec(A, P.t), await sec(A, P.n)]);
  // 기존 pending 주문(만료 전에 만든 것으로 가정 — 서비스 롤로 생성)·구매내역·수강권 유지, 확정(fulfill_order)·발급이 막히지 않는다
  const profA = (await A.from("profiles").select("id").limit(1)).data[0].id;
  const pend = await svc.from("orders").insert({ center_id: OP, profile_id: profA, product_id: P.y, product_name: N("어제"), amount: 10000, pay_method: "direct", payment_provider: "mock", status: "pending", verified: true }).select("id").single();
  const own = await svc.from("memberships").insert({ center_id: OP, profile_id: profA, product_id: P.y, product_name: N("어제"), pass_type: "count", total_count: 5, remaining_count: 5 }).select("id").single();
  const myOrders = await A.from("orders").select("id,status").eq("id", pend.data.id); eq("H1", "만료 상품의 기존 pending 주문이 회원 주문 내역에 그대로 보임", 1, myOrders.data?.length);
  const myMs = await A.from("memberships").select("id").eq("id", own.data.id); eq("H2", "만료 상품으로 이미 받은 수강권이 그대로 보임", 1, myMs.data?.length);
  const ful = await MA.rpc("fulfill_order", { p_order_id: pend.data.id }); eq("H3", "만료 상품의 기존 pending 주문을 fulfill_order 로 직접 확정하면 거부됨(처음부터 만료된 수강권 방지 — add_expired_order_resolution_20261031.sql 적용 상태). 이 SQL 이 없으면 기존처럼 처리됨", true, ful.error == null || /판매 기간이 지난 상품의 주문/.test(ful.error.message));
  { const rejected = ful.error != null && /판매 기간이 지난 상품의 주문/.test(ful.error.message); const stat = (await svc.from("orders").select("status").eq("id", pend.data.id).single()).data.status; const mships = (await svc.from("memberships").select("id").eq("profile_id", profA).eq("product_id", P.y)).data.length;
    // add_expired_order_resolution_20261031.sql 적용 상태: 직접 확정은 거부되고 주문은 pending·수강권 추가 없음. 미적용 상태(PR #251 단독): 기존처럼 발급됨.
    eq("H4", "확정 후 상태: (SQL 적용) 거부 → pending 유지·수강권 추가 없음 / (미적용) 발급 완료", true, rejected ? stat === "pending" && mships === 1 : stat !== "pending" && mships >= 2); }
  // 관리자 수정 가능
  const upd = await MA.from("products").update({ expiry_date: kst(5) }).eq("id", P.y).select("id"); eq("M1", "관리자가 만료 상품의 만료일을 수정할 수 있음(RLS 유지)", 1, upd.data?.length);
  eq("M2", "수정 후(미래 만료일) 목록에 다시 노출", true, mine((await anonC.rpc("fetch_public_storefront_products", { p_center_id: OP })).data).includes("어제"));
  await svc.from("products").update({ expiry_date: kst(-1) }).eq("id", P.y);   // 원복(시험 상품)
  // NICEPAY 심사 센터 격리(심사관 B 는 심사 센터만, 일반 A 는 심사 센터 상품을 못 봄) + 만료 규칙은 심사 센터에도 적용
  const revB = await B.rpc("fetch_purchasable_products", { p_center_id: REV }); eq("N1", "심사관 B: 심사 센터 상품은 보이되 어제 만료는 제외", ["심사오늘"], mine(revB.data));
  const revA = await A.rpc("fetch_purchasable_products", { p_center_id: REV }); eq("N2", "일반 회원 A: 심사 센터 상품 0건(격리 유지)", [], mine(revA.data));
  const opB = await B.rpc("fetch_purchasable_products", { p_center_id: OP }); eq("N3", "심사관 B: 운영 센터 상품 0건(격리 유지)", [], mine(opB.data));
  eq("N4", "비로그인 공개 목록에 심사 센터 상품 없음", [], mine((await anonC.rpc("fetch_public_storefront_products", { p_center_id: REV })).data));
  eq("N5", "일반 회원 A 는 심사 센터 상품 직접 주문 거부", "DENIED", (await direct(A, P.rev_t, REV)).replace(/\(.*\)/, ""));   // 심사 센터 가드 트리거(P0001) 또는 RLS(42501) 어느 쪽이든 거부
  eq("N6", "NICEPAY 게이트 off(결제 OFF 유지)", "off", psql("select mode from nicepay_checkout_gate where id"));
  // 함수·정책 형태
  eq("S1", "member_can_purchase_product 는 운영 정의 그대로(해시 d0233bd0…)", "d0233bd03772ad129db6acc90f7e0dba", psql("select md5(pg_get_functiondef('public.member_can_purchase_product(uuid,uuid)'::regprocedure))"));
  eq("S2", "상품 데이터는 자동으로 바뀌지 않음(어제 만료 상품 is_on_sale·is_active 유지)", [true, true], ((r) => [r.is_on_sale, r.is_active])((await svc.from("products").select("is_on_sale,is_active").eq("id", P.y).single()).data));
} finally {
  await svc.from("orders").delete().like("product_name", `EXP-${tag}%`); const ids = Object.values(P);
  psql(`begin; set local session_replication_role = replica; delete from payments where membership_id in (select id from memberships where product_id in ('${ids.join("','")}')); delete from admin_action_logs where membership_id in (select id from memberships where product_id in ('${ids.join("','")}')); delete from memberships where product_id in ('${ids.join("','")}'); delete from orders where product_id in ('${ids.join("','")}'); delete from products where id in ('${ids.join("','")}'); commit;`);
}
console.log(`\n${res.filter((x) => x.pass).length}/${res.length} PASS, ${fails} FAIL`); if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ fails, results: res }, null, 1)); process.exit(fails ? 1 : 0);
