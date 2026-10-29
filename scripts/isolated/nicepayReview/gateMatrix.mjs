// 로컬 격리 DB 전용: NICEPAY 주문 생성 게이트(mode off/reviewer/public) × 페르소나. B안 — reviewer 모드는 nicepay_review_access 계정만 통과하고 토스 심사 계정(pg_checkout_override)은 거부돼야 한다.
import { execFileSync } from "node:child_process"; import fs from "node:fs";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE);
const sql = (q) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: prods } = await svc.from("products").select("id,center_id,name"); const { data: centers } = await svc.from("centers").select("id,name,is_nicepay_review");
const REV = centers.find((c) => c.is_nicepay_review).id; const revProd = prods.find((p) => p.center_id === REV && p.name.includes("1회")).id, opProd = prods.find((p) => p.name === "[QA] 8회권 · 30일").id;
const WHO = { "일반회원(A)": [env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD], "토스 심사관(T, override만)": [env.TOSS_REVIEWER_EMAIL, env.TOSS_REVIEWER_PASSWORD], "NICEPAY 심사관(B, 전용 권한만)": [env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD], "NICEPAY 심사관+토스센터 매니저+is_member=false(S)": [env.SONJW_LIKE_EMAIL, env.SONJW_LIKE_PASSWORD] };
const out = [];
const original = sql("select mode from nicepay_checkout_gate");
try {
  for (const mode of (process.env.MODES ?? "off,reviewer,public").split(",")) {
    sql(`update nicepay_checkout_gate set mode='${mode}', updated_at=now() where id`);
    for (const [name, [e, p]] of Object.entries(WHO)) {
      const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } }); await c.auth.signInWithPassword({ email: e, password: p });
      const row = { mode, who: name };
      for (const [lbl, pid] of [["심사상품", revProd], ["운영상품", opProd]]) { const r = await c.rpc("create_order_secure", { p_product_id: pid, p_pay_method: "card", p_selected_size: null, p_point_used: 0, p_auto_book: false, p_provider: "nicepay" }); row[lbl] = r.error ? "DENY(" + r.error.message.slice(0, 28) + ")" : "ORDER_CREATED"; if (!r.error && r.data) { const id = typeof r.data === "string" ? r.data : r.data?.id ?? r.data?.order_id; if (id) sql(`update orders set status='cancelled' where id='${id}' and status='pending'`); } }
      out.push(row);
    }
  }
} finally { sql(`update nicepay_checkout_gate set mode='${original}', updated_at=now() where id`); }
for (const r of out) console.log(JSON.stringify(r));
fs.writeFileSync(process.argv[2] ?? "gate-matrix.json", JSON.stringify(out, null, 1));
