// 결함 재현/회귀: 직접 REST 로 상품 id 와 센터 id 를 어긋나게 넣은 주문·장바구니·구매신청·수강권을 시도한다. 로컬 일회용 스택 전용(ISO_ENV_FILE). 분리 SQL 적용 후에는 모두 DENY 여야 한다.
// 결함 재현: 직접 REST(PostgREST)로 orders/cart_items/purchase_requests/memberships/reservations 를 상품 id 와 센터 id 를 어긋나게 넣는다.
import { createRequire } from "node:module"; import fs from "node:fs";
const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE);   // 어떤 요청보다 먼저 일회용 로컬 스택 확인
const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: centers } = await svc.from("centers").select("id,name,is_nicepay_review"); const REV = centers.find((c) => c.is_nicepay_review), OP = centers.find((c) => c.name === "[QA] 심사 시험 스튜디오");
const { data: prods } = await svc.from("products").select("id,center_id,name,price"); const revProd = prods.find((p) => p.center_id === REV.id && p.name.includes("1회")), opProd = prods.find((p) => p.name === "[QA] 8회권 · 30일");
const { data: cls } = await svc.from("classes").select("id,center_id"); const revCls = cls.find((c) => c.center_id === REV.id), opCls = cls.find((c) => c.center_id === OP.id);
const login = async (e, p) => { const c = createClient(url, anon, { auth: { persistSession: false } }); await c.auth.signInWithPassword({ email: e, password: p }); const { data: pr } = await c.from("profiles").select("id").limit(1); return [c, pr?.[0]?.id]; };
const [A, pa] = await login(env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD), [B, pb] = await login(env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD);
const [MA] = await login(env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD);
const out = {};
const tryIns = async (label, c, table, row) => { const r = await c.from(table).insert(row).select("id"); out[label] = r.error ? "DENY: " + r.error.message.slice(0, 60) : "** INSERTED **"; if (!r.error) await svc.from(table).delete().eq("id", r.data[0].id); };
// 직접 REST 주문: 일반 회원 → 심사 상품 (센터는 운영 센터로 위장 / 정직하게 심사 센터 / 센터 생략 불가)
await tryIns("A→심사상품 (center=심사, 정직)", A, "orders", { center_id: REV.id, profile_id: pa, product_id: revProd.id, product_name: "x", amount: revProd.price, pay_method: "direct", payment_provider: null });
await tryIns("A→심사상품 (center=운영으로 위장)", A, "orders", { center_id: OP.id, profile_id: pa, product_id: revProd.id, product_name: "x", amount: revProd.price, pay_method: "direct", payment_provider: null });
await tryIns("B(심사관)→운영상품 (center=운영, 정직)", B, "orders", { center_id: OP.id, profile_id: pb, product_id: opProd.id, product_name: "x", amount: opProd.price, pay_method: "direct", payment_provider: null });
await tryIns("B(심사관)→운영상품 (center=심사로 위장)", B, "orders", { center_id: REV.id, profile_id: pb, product_id: opProd.id, product_name: "x", amount: opProd.price, pay_method: "direct", payment_provider: null });
await tryIns("A cart→심사상품 (center=운영 위장)", A, "cart_items", { profile_id: pa, center_id: OP.id, product_id: revProd.id, product_name: "x", price: 1 });
await tryIns("A purchase_requests→심사상품 (center=운영 위장)", A, "purchase_requests", { center_id: OP.id, profile_id: pa, product_id: revProd.id, product_name: "x" });
await tryIns("A purchase_requests→심사상품 (center=심사)", A, "purchase_requests", { center_id: REV.id, profile_id: pa, product_id: revProd.id, product_name: "x" });
await tryIns("운영 매니저(MA) 수강권 발급: center=운영, product=심사 상품", MA, "memberships", { profile_id: pa, center_id: OP.id, product_id: revProd.id, product_name: "x", pass_type: "count", total_count: 1, remaining_count: 1 });
// UPDATE 경로: 정상 예약의 class_id 를 심사 수업으로 옮기기 / 주문 취소 갱신에 product 바꿔치기
await svc.from("reservations").insert({ class_id: opCls.id, profile_id: pa, status: "confirmed" });
const { data: myRes } = await A.from("reservations").select("id,class_id").limit(1);
if (myRes?.length) { const r = await A.from("reservations").update({ class_id: revCls.id }).eq("id", myRes[0].id).select("id"); out["A 예약을 심사 수업으로 이동(UPDATE class_id)"] = r.error ? "DENY: " + r.error.message.slice(0, 60) : (r.data?.length ? "** UPDATED **" : "0행(RLS)"); if (r.data?.length) await svc.from("reservations").update({ class_id: myRes[0].class_id }).eq("id", myRes[0].id); }
const o = await svc.from("orders").insert({ center_id: OP.id, profile_id: pa, product_id: opProd.id, product_name: "x", amount: 1, pay_method: "direct", status: "pending" }).select("id").single();
const u = await A.from("orders").update({ status: "cancelled", product_id: revProd.id, center_id: REV.id }).eq("id", o.data.id).select("id,product_id,center_id"); out["A 취소 UPDATE 에 product/center 바꿔치기"] = u.error ? "DENY: " + u.error.message.slice(0, 60) : (u.data?.length ? "** UPDATED ** (주문이 심사 상품/센터를 가리킴)" : "0행"); await svc.from("orders").delete().eq("id", o.data.id);
console.log(JSON.stringify(out, null, 1));
