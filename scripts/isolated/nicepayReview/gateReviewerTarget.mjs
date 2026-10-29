// 로컬 격리 스택 전용: NICEPAY 게이트(orders_guard_nicepay_create / nicepay_claim_order)의 reviewer 모드 — 전용 권한 + "심사 센터 주문" 검증, public·off·서버 경로·기존 대기 주문 유지. 단언(어긋나면 종료 코드 1).
// P2 의 주문 방어 트리거를 잠시 지워 "P2b 단독으로도 게이트가 막는지"를 시험하고, 끝에 P2 를 다시 적용해 원상복구한다. 사용: ISO_ENV_FILE=… node gateReviewerTarget.mjs [결과.json]
import fs from "node:fs"; import { execFileSync } from "node:child_process";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const url = env.NEXT_PUBLIC_SUPABASE_URL, anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const psql = (sql, file) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", ...(file ? [] : ["-c", sql])], { input: file ? fs.readFileSync(file) : undefined, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
let failures = 0; const results = []; const expectEq = (id, name, expected, actual, extra = "") => { const pass = expected === actual; if (!pass) failures++; results.push({ id, name, expected, actual, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${expected} / 실제 ${actual}${extra ? " · " + extra : ""}`); };
const login = async (e, p) => { const c = createClient(url, anon, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email: e, password: p }); if (error) throw new Error(error.message); const { data: pr } = await c.from("profiles").select("id").limit(1); return { c, profile: pr?.[0]?.id }; };
const A = await login(env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD), T = await login(env.TOSS_REVIEWER_EMAIL, env.TOSS_REVIEWER_PASSWORD), B = await login(env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD);
const { data: centers } = await svc.from("centers").select("id,name,is_nicepay_review"); const REV = centers.find((c) => c.is_nicepay_review).id, OP = centers.find((c) => c.name === "[QA] 심사 시험 스튜디오").id;
const { data: prods } = await svc.from("products").select("id,center_id,name"); const revProd = prods.find((p) => p.center_id === REV && p.name.includes("1회")).id, opProd = prods.find((p) => p.name === "[QA] 8회권 · 30일").id;
const setMode = (m) => psql(`update nicepay_checkout_gate set mode='${m}', updated_at=now() where id`);
const nic = (who, center, product) => ({ center_id: center, profile_id: who.profile, product_id: product, product_name: "x", amount: 1000, pay_method: "card", payment_provider: "nicepay" });
const tryIns = async (who, center, product) => { const r = await who.c.from("orders").insert(nic(who, center, product)).select("id").single(); if (!r.error) await svc.from("orders").delete().eq("id", r.data.id); return r.error ? "DENIED" : "CREATED"; };
// 시험이 만든 NICEPAY 주문 정리(로컬 전용): append-only 감사 테이블(nicepay_review_actions)이 주문을 참조하므로 복제 롤(트리거·FK 우회)로 지운다.
const cleanOrders = (ids) => psql(`begin; set local session_replication_role = replica; delete from nicepay_review_actions where order_id in (${ids.map((i) => `'${i}'`).join(",")}); delete from orders where id in (${ids.map((i) => `'${i}'`).join(",")}); commit;`);
const original = psql("select mode from nicepay_checkout_gate");
try {
  psql("drop trigger if exists trg_orders_nicepay_review_guard on orders");   // P2 의 방어를 빼고 게이트(P2b) 단독 동작을 본다
  setMode("reviewer");
  expectEq("G1", "reviewer: NICEPAY 심사관 + 심사 센터 + 심사 상품 주문 생성", "CREATED", await tryIns(B, REV, revProd));
  expectEq("G2", "reviewer: NICEPAY 심사관이 운영 센터·운영 상품으로 NICEPAY 주문(권한만 있고 대상이 심사 센터가 아님)", "DENIED", await tryIns(B, OP, opProd));
  expectEq("G3", "reviewer: 심사 센터라고 주장하지만 상품은 운영 상품(센터·상품 불일치)", "DENIED", await tryIns(B, REV, opProd));
  expectEq("G4", "reviewer: 운영 센터라고 주장하지만 상품은 심사 상품", "DENIED", await tryIns(B, OP, revProd));
  expectEq("G5", "reviewer: 토스 심사 계정(pg_checkout_override 만)은 어떤 조합도 거부", "DENIED", (await tryIns(T, REV, revProd)) === "DENIED" && (await tryIns(T, OP, opProd)) === "DENIED" ? "DENIED" : "CREATED");
  expectEq("G6", "reviewer: 일반 회원은 거부", "DENIED", (await tryIns(A, REV, revProd)) === "DENIED" && (await tryIns(A, OP, opProd)) === "DENIED" ? "DENIED" : "CREATED");
  // 서버 경로(service_role): 주문 생성은 게이트가 막지 않는다(승인 선점 단계가 막는다)
  const mk = async (who, center, product) => (await svc.from("orders").insert(nic(who, center, product)).select("id").single());
  const sBr = await mk(B, REV, revProd), sBo = await mk(B, OP, opProd), sAo = await mk(A, OP, opProd);
  expectEq("S1", "서버(service_role)가 NICEPAY 대기 주문 생성(reviewer 모드) — 기존 서버 경로 유지", "CREATED", sBr.error || sBo.error || sAo.error ? "DENIED" : "CREATED");
  const claim = async (id) => { const r = await svc.rpc("nicepay_claim_order", { p_order_id: id }); return r.error ? "ERR:" + r.error.message.slice(0, 40) : (r.data ? "CLAIMED" : "NULL"); };
  // 이미 대기 중이던 주문(서버가 먼저 만들어 둔 것)의 승인 선점
  expectEq("K1", "reviewer 승인 선점: 심사관 + 심사 센터 주문", "CLAIMED", await claim(sBr.data.id));
  expectEq("K2", "reviewer 승인 선점: 심사관이지만 운영 센터 대기 주문(새로 막히는 경로)", "NULL", await claim(sBo.data.id));
  expectEq("K3", "reviewer 승인 선점: 일반 회원 대기 주문", "NULL", await claim(sAo.data.id));
  // ── 심사 대상 조건: 상품 NULL · 판매 중지 상품 · 닫힌/비승인 센터 (reviewer 모드) ──
  const mkRaw = async (row) => (await svc.from("orders").insert(row).select("id").single());
  expectEq("N1", "reviewer: 심사관이 상품 NULL 로 심사 센터 NICEPAY 주문 직접 생성(서버 계산 금액 없음)", "DENIED", await tryIns(B, REV, null));
  const nBr = await mkRaw(nic(B, REV, null)); expectEq("N2", "reviewer: 서버가 만든 상품 NULL 대기 주문의 승인 선점", "NULL", nBr.error ? "ERR" : await claim(nBr.data.id));
  const d1 = await mk(B, REV, revProd);                                  // 판매 중일 때 만든 대기 주문
  psql(`update products set is_on_sale=false where id='${revProd}'`);
  expectEq("P1", "reviewer: 판매 중지된 심사 상품 주문 직접 생성", "DENIED", await tryIns(B, REV, revProd));
  expectEq("P2", "reviewer: 판매 중지 전에 만든 대기 주문의 승인 선점", "NULL", await claim(d1.data.id));
  psql(`update products set is_on_sale=true, is_active=false where id='${revProd}'`);
  expectEq("P3", "reviewer: 비활성(is_active=false) 심사 상품 주문 직접 생성", "DENIED", await tryIns(B, REV, revProd));
  expectEq("P4", "reviewer: 비활성 상품 대기 주문의 승인 선점", "NULL", await claim(d1.data.id));
  psql(`update products set is_active=true where id='${revProd}'`);
  expectEq("P5", "reviewer: 상품을 다시 판매 중으로 되돌리면 같은 대기 주문 승인 선점 가능(영구 차단 아님)", "CLAIMED", await claim(d1.data.id));
  await svc.rpc("nicepay_release_order", { p_order_id: d1.data.id, p_claim_id: (await svc.from("orders").select("pg_claim_id").eq("id", d1.data.id).single()).data.pg_claim_id, p_basis: "approve_rejected" });
  psql(`update centers set is_internal=true where id='${REV}'`);
  expectEq("C1", "reviewer: 비공개(is_internal) 로 닫힌 심사 센터 주문 직접 생성", "DENIED", await tryIns(B, REV, revProd));
  expectEq("C2", "reviewer: 닫힌 심사 센터의 대기 주문 승인 선점", "NULL", await claim(d1.data.id));
  psql(`update centers set is_internal=false where id='${REV}'`);
  psql(`alter table centers disable trigger trg_guard_center_status; update centers set status='pending' where id='${REV}'; alter table centers enable trigger trg_guard_center_status`);
  expectEq("C3", "reviewer: 비승인(pending) 심사 센터의 대기 주문 승인 선점", "NULL", await claim(d1.data.id));
  psql(`alter table centers disable trigger trg_guard_center_status; update centers set status='approved' where id='${REV}'; alter table centers enable trigger trg_guard_center_status`);
  expectEq("C4", "reviewer: 센터를 승인·공개로 되돌리면 정상 주문 승인 선점 가능", "CLAIMED", await claim(d1.data.id));
  const c4 = (await svc.from("orders").select("pg_claim_id").eq("id", d1.data.id).single()).data.pg_claim_id; await svc.rpc("nicepay_release_order", { p_order_id: d1.data.id, p_claim_id: c4, p_basis: "approve_rejected" });
  cleanOrders([nBr.data.id, d1.data.id].filter(Boolean));
  // 이미 approving 인 주문의 후속 처리는 게이트와 무관하게 마무리된다(off 로 전환한 뒤에도) — release 로 확인
  const { data: claimed } = await svc.from("orders").select("pg_claim_id,status").eq("id", sBr.data.id).single(); setMode("off");
  const rel = await svc.rpc("nicepay_release_order", { p_order_id: sBr.data.id, p_claim_id: claimed.pg_claim_id, p_basis: "approve_rejected" });
  expectEq("K4", "off 로 닫은 뒤에도 진행 중(approving) 주문의 release 는 가능(과거 결제 처리 유지)", "released", rel.error ? "ERR:" + rel.error.message.slice(0, 50) : "released");
  expectEq("K5", "off: 새 승인 선점은 모두 거부", "NULL", await claim(sBr.data.id));
  expectEq("G7", "off: 클라이언트 NICEPAY 주문 생성은 모두 거부(심사관 포함)", "DENIED", (await tryIns(B, REV, revProd)) === "DENIED" && (await tryIns(A, OP, opProd)) === "DENIED" ? "DENIED" : "CREATED");
  setMode("public");
  expectEq("G8", "public: 일반 회원 주문 생성(기존 동작 유지)", "CREATED", await tryIns(A, OP, opProd));
  expectEq("K6", "public: 일반 회원 대기 주문 승인 선점(기존 동작 유지)", "CLAIMED", await claim(sAo.data.id));
  expectEq("K7", "public: 심사관의 운영 센터 대기 주문도 public 에서는 선점 가능(public 은 대상 제한 없음 — 기존 동작)", "CLAIMED", await claim(sBo.data.id));
  cleanOrders([sBr.data.id, sBo.data.id, sAo.data.id]);
} finally { try { psql(`update products set is_on_sale=true, is_active=true where id in (select id from products where center_id in (select id from centers where is_nicepay_review))`); psql(`update centers set is_internal=false where is_nicepay_review`); } catch {} setMode(original); psql(null, "add_nicepay_review_center_isolation_20261028.sql"); }   // 모드 원복 + P2 트리거 복구(멱등 재적용)
expectEq("Z1", "시험 종료 후 모드 원복 및 P2 주문 방어 트리거 복구", `${original}/1`, `${psql("select mode from nicepay_checkout_gate")}/${psql("select count(*) from pg_trigger where tgname='trg_orders_nicepay_review_guard'")}`);
console.log(`\n${results.filter((x) => x.pass).length}/${results.length} PASS, ${failures} FAIL`); if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ failures, results }, null, 1)); process.exit(failures ? 1 : 0);
