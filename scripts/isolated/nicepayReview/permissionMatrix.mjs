// 로컬 격리 스택 전용(ISO_ENV_FILE = bootstrapEphemeral 가 쓴 환경 파일, 0600·커밋 금지). 운영/공유 DEV 로 실행하지 않는다. 사용법: docs/payments/NICEPAY_REVIEW_CENTER_20261028.md §6

import { createRequire } from "node:module"; import fs from "node:fs";
const require = createRequire(process.cwd() + "/package.json");
const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE);   // 어떤 네트워크 요청보다 먼저: 일회용 로컬 스택이 아니면 여기서 throw
const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tag = process.argv[2];
// 로컬 전용 플랫폼 관리자 페르소나(격리 DB)
const adminEmail = "ci-admin@isolated.test", adminPw = "Adm1n!" + Math.random().toString(36).slice(2, 12);
const ex = (await svc.auth.admin.listUsers()).data.users.find((u) => u.email === adminEmail);
let adminId = ex?.id; if (!ex) { const r = await svc.auth.admin.createUser({ email: adminEmail, password: adminPw, email_confirm: true }); adminId = r.data.user.id; } else await svc.auth.admin.updateUserById(adminId, { password: adminPw });
await new Promise((r) => setTimeout(r, 800));
const { data: accs } = await svc.from("accounts").select("id,auth_id").eq("auth_id", adminId);
if (!accs?.length) await svc.from("accounts").insert({ auth_id: adminId, name: "CI Admin" });
await svc.from("accounts").update({ is_platform_admin: true }).eq("auth_id", adminId);
const { data: centers } = await svc.from("centers").select("id,name,is_nicepay_review");
const REV = centers.find((c) => c.is_nicepay_review), OP = centers.find((c) => c.name === "[QA] 심사 시험 스튜디오");
const { data: prods } = await svc.from("products").select("id,center_id,name");
const revProd = prods.find((p) => p.center_id === REV.id && p.name.includes("1회")), opProd = prods.find((p) => p.name === "[QA] 8회권 · 30일");
const { data: cls } = await svc.from("classes").select("id,center_id"); const revCls = cls.find((c) => c.center_id === REV.id), opCls = cls.find((c) => c.center_id === OP.id);
const personas = { anon: null, "일반회원(A)": [env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD], "심사관(B)": [env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD], "운영센터 매니저(MA)": [env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD], "심사센터 매니저(MB)": [env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD], "플랫폼 관리자": [adminEmail, adminPw] };
const out = {};
for (const [name, cred] of Object.entries(personas)) {
  const c = createClient(url, anon, { auth: { persistSession: false } });
  if (cred) { const { error } = await c.auth.signInWithPassword({ email: cred[0], password: cred[1] }); if (error) { out[name] = { login: "FAIL " + error.message }; continue; } }
  const r = {};
  const { data: cs } = await c.from("centers").select("id,name"); r.centersList = (cs ?? []).map((x) => x.name).filter((n) => /심사|CI Fixture/.test(n) || true).sort();
  r.directReviewCenter = !!(await c.from("centers").select("id").eq("id", REV.id).maybeSingle()).data;
  r.directOpCenter = !!(await c.from("centers").select("id").eq("id", OP.id).maybeSingle()).data;
  r.revProductsDirect = ((await c.from("products").select("id").eq("center_id", REV.id)).data ?? []).length;
  r.opProductsDirect = ((await c.from("products").select("id").eq("center_id", OP.id)).data ?? []).length;
  r.revClassesDirect = ((await c.from("classes").select("id").eq("center_id", REV.id)).data ?? []).length;
  r.opClassesDirect = ((await c.from("classes").select("id").eq("center_id", OP.id)).data ?? []).length;
  const pub = (await c.rpc("fetch_public_storefront_products", {})).data ?? []; r.publicRpcCenters = [...new Set(pub.map((p) => p.center_name))].sort(); r.publicRpcRevById = ((await c.rpc("fetch_public_storefront_products", { p_center_id: REV.id })).data ?? []).length;
  const per = (await c.rpc("fetch_public_storefront_product_periods", {})).data ?? []; r.periodsRev = per.filter((p) => prods.find((x) => x.id === p.product_id)?.center_id === REV.id).length; r.periodsOp = per.filter((p) => prods.find((x) => x.id === p.product_id)?.center_id === OP.id).length;
  if (cred) { r.purchasableRev = ((await c.rpc("fetch_purchasable_products", { p_center_id: REV.id })).data ?? []).length; r.purchasableOp = ((await c.rpc("fetch_purchasable_products", { p_center_id: OP.id })).data ?? []).length;
    const o1 = await c.rpc("create_order_secure", { p_product_id: revProd.id, p_pay_method: "direct", p_selected_size: null, p_point_used: 0, p_auto_book: false, p_provider: null }); r.orderRev = o1.error ? "DENY: " + o1.error.message.slice(0, 50) : "OK";
    const o2 = await c.rpc("create_order_secure", { p_product_id: opProd.id, p_pay_method: "direct", p_selected_size: null, p_point_used: 0, p_auto_book: false, p_provider: null }); r.orderOp = o2.error ? "DENY: " + o2.error.message.slice(0, 50) : "OK";
    const { data: pid } = await c.from("profiles").select("id").limit(1);
    const p = pid?.[0]?.id;
    const x1 = p ? await c.rpc("reserve_class", { p_class_id: revCls.id, p_profile_id: p }) : { error: { message: "no profile" } }; r.reserveRev = x1.error ? "ERR: " + x1.error.message.slice(0, 50) : "OK";
    const x2 = p ? await c.rpc("reserve_class", { p_class_id: opCls.id, p_profile_id: p }) : { error: { message: "no profile" } }; r.reserveOp = x2.error ? "ERR: " + x2.error.message.slice(0, 50) : "OK";
    r.myMemberships = ((await c.from("memberships").select("id")).data ?? []).length; r.myOrders = ((await c.from("orders").select("id")).data ?? []).length; r.myReservations = ((await c.from("reservations").select("id")).data ?? []).length;
  }
  out[name] = r;
}
fs.writeFileSync((process.env.OUT_DIR ?? ".") + `/matrix-${tag}.json`, JSON.stringify(out, null, 1));
for (const [n, r] of Object.entries(out)) console.log(n, JSON.stringify(r));
