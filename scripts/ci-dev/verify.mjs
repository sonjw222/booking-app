#!/usr/bin/env node
// READ-ONLY 검증(SELECT/GET만). Production이면 네트워크 호출 전에 중단. 출력은 PASS / MISSING / MISMATCH / SKIP.
//   npm run ci:dev:verify            전체(스키마 + fixture)
//   node scripts/ci-dev/verify.mjs --schema   스키마 단계만
import { pathToFileURL } from "node:url";
import { requireNonProductionOrExit, FIXTURE_ACCOUNTS } from "./requiredEnv.mjs";
import { FIXTURE_CENTER_NAME, FIXTURE_PRODUCT_NAME, makeClient, projectRefFromUrl, scanUsage } from "./lib.mjs";

// seed가 쓰는 컬럼(없으면 스키마가 다르다는 뜻 → seed 전에 중단해야 함)
export const SEED_COLUMNS = {
  accounts: ["id", "auth_id", "name", "is_member", "is_manager"], profiles: ["id", "account_id", "name", "is_primary"],
  centers: ["id", "name", "status", "is_internal"], center_members: ["id", "center_id", "profile_id", "status"], products: ["id", "center_id", "name", "price", "product_kind", "pass_type", "total_count", "is_on_sale", "is_active"],
};
// 이름이 코드 규약으로 고정된 핵심 테이블(+테스트가 직접 쓰는 테이블은 정적 스캔으로 추가)
export const CORE_TABLES = ["accounts", "profiles", "centers", "center_roles", "manager_centers", "center_members", "products", "memberships", "orders", "payments", "classes", "reservations", "center_settings", "notifications"];

export async function verifySchema({ client, root = process.cwd(), report }) {
  const o = await client.openapi();
  if (!o.ok || !o.json?.definitions) { report("MISMATCH", "PostgREST OpenAPI 조회", `HTTP ${o.status} — service role 키/URL 확인`); return false; }
  const defs = o.json.definitions, paths = Object.keys(o.json.paths ?? {});
  const tests = scanUsage(root, ["tests/integration", "tests/e2e"]);
  for (const t of [...new Set([...CORE_TABLES, ...tests.tables])]) report(defs[t] ? "PASS" : "MISSING", `table ${t}`, defs[t] ? "" : "schema baseline 필요");
  for (const [t, cols] of Object.entries(SEED_COLUMNS)) if (defs[t]) for (const c of cols) if (!defs[t].properties?.[c]) report("MISMATCH", `column ${t}.${c}`, "seed가 쓰는 컬럼이 없음");
  for (const r of tests.rpcs) report(paths.includes(`/rpc/${r}`) ? "PASS" : "MISSING", `rpc ${r}`, "테스트가 호출하는 함수");
  const b = await client.buckets();
  const have = new Set(Array.isArray(b.json) ? b.json.map((x) => x.name) : []);
  for (const name of tests.buckets) report(have.has(name) ? "PASS" : "MISSING", `storage bucket ${name}`, have.has(name) ? "" : "테스트가 쓰는 버킷 — Production 설정을 읽어 dev에 생성(설정은 DB 데이터가 아니라 구성)");
  report("SKIP", "RLS 활성 여부 / GRANT", "PostgREST로 조회 불가 — SQL 편집기에서 별도 확인(docs/CI_DEV_SUPABASE_SETUP.md)");
  return true;
}

export async function verifyCatalog({ client, report }) {
  const perms = await client.count("permissions");
  report(perms.n > 0 ? "PASS" : "MISSING", `catalog permissions (${perms.n ?? "?"}행)`, "참조 데이터 적재 필요(ci:dev:seed + prod-catalog.json)");
  const plan = await client.select("subscription_plans", "select=id,is_default,is_active&is_default=eq.true&is_active=eq.true");
  report(plan.json?.length === 1 ? "PASS" : plan.json?.length ? "MISMATCH" : "MISSING", "catalog 기본 요금제(is_default & is_active 1개)", "센터 생성 트리거/구독 테스트가 필요로 함");
}

export async function verifyFixtures({ client, env, report }) {
  const users = await client.listUsers(); const byEmail = new Map((users.json?.users ?? []).map((u) => [String(u.email).toLowerCase(), u]));
  for (const a of FIXTURE_ACCOUNTS) {
    const u = byEmail.get(String(env[`TEST_${a}_EMAIL`]).toLowerCase());
    if (!u) { report("MISSING", `auth user ${a}`, "ci:dev:seed"); continue; }
    report(u.email_confirmed_at ? "PASS" : "MISMATCH", `auth user ${a}${u.email_confirmed_at ? "" : " (이메일 미확인)"}`);
    const acc = await client.select("accounts", `select=id&auth_id=eq.${u.id}`); const accountId = acc.json?.[0]?.id;
    report(accountId ? "PASS" : "MISSING", `account ${a}`);
    if (accountId) { const p = await client.select("profiles", `select=id&account_id=eq.${accountId}&is_primary=eq.true`); report(p.json?.length === 1 ? "PASS" : p.json?.length ? "MISMATCH" : "MISSING", `primary profile ${a}`); }
  }
  const c = await client.select("centers", `select=id,status,is_internal&id=eq.${encodeURIComponent(env.TEST_CENTER_ID)}`);
  const center = c.json?.[0];
  report(center ? (center.status === "approved" && center.is_internal === true ? "PASS" : "MISMATCH") : "MISSING", "TEST_CENTER_ID 센터(approved + is_internal=true: mock 결제 조건)" + (center && !(center.status === "approved" && center.is_internal === true) ? ` (status=${center.status}, is_internal=${center.is_internal})` : ""));
  for (const a of ["USER_A", "USER_B"]) {
    const u = byEmail.get(String(env[`TEST_${a}_EMAIL`]).toLowerCase()); const acc = u && (await client.select("accounts", `select=id&auth_id=eq.${u.id}`)).json?.[0]?.id;
    const prof = acc && (await client.select("profiles", `select=id&account_id=eq.${acc}&is_primary=eq.true`)).json?.[0]?.id;
    const cm = prof && (await client.select("center_members", `select=id&center_id=eq.${encodeURIComponent(env.TEST_CENTER_ID)}&profile_id=eq.${prof}`)).json;
    report(cm?.length === 1 ? "PASS" : cm?.length ? "MISMATCH" : "MISSING", `${a} center_members(internal 센터 가시성)`);
  }
  const p = await client.select("products", `select=id,center_id,price,is_active,is_on_sale,product_kind&id=eq.${encodeURIComponent(env.TEST_PRODUCT_ID)}`);
  const prod = p.json?.[0];
  if (!prod) report("MISSING", "TEST_PRODUCT_ID 상품");
  else report(prod.center_id === env.TEST_CENTER_ID && prod.is_active && prod.is_on_sale && prod.product_kind === "pass" ? "PASS" : "MISMATCH", "TEST_PRODUCT_ID 상품(TEST_CENTER_ID 소속·활성·판매중·pass)");
  report("SKIP", "매니저/스태프 센터 연결", "테스트가 직접 만들고 정리함(getOrCreateOwnedTestCenter/inviteStaff) — fixture 불필요");
}

export function makeReporter(print = console.log) {
  const rows = [];
  return { rows, report: (status, name, hint = "") => { rows.push({ status, name }); if (status !== "PASS" || process.env.CI_DEV_VERBOSE === "1") print(`${status.padEnd(8)} ${name}${hint ? `  → ${hint}` : ""}`); },
    summary: () => { const n = (s) => rows.filter((r) => r.status === s).length; return `PASS ${n("PASS")} · MISSING ${n("MISSING")} · MISMATCH ${n("MISMATCH")} · SKIP ${n("SKIP")}`; }, failed: () => rows.some((r) => r.status === "MISSING" || r.status === "MISMATCH") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireNonProductionOrExit(process.env, { forSeed: process.argv.includes("--schema") });
  if (!projectRefFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) { console.error("ci-dev verify: URL 형식 오류"); process.exit(1); }
  const client = makeClient(process.env), r = makeReporter();
  await verifySchema({ client, report: r.report });
  if (!process.argv.includes("--schema")) await verifyCatalog({ client, report: r.report });
  if (!process.argv.includes("--schema")) await verifyFixtures({ client, env: process.env, report: r.report });
  console.log("\n" + r.summary()); console.log("(PASS 항목은 CI_DEV_VERBOSE=1 로 모두 출력)");
  process.exit(r.failed() ? 1 : 0);
}
