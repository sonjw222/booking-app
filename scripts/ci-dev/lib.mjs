// CI/dev Supabase 공용 라이브러리 — 가드, REST 클라이언트, fixture 계획(ensure*), 정적 스캔.
// 모든 네트워크 호출은 주입 가능한 fetch를 쓴다(테스트에서 가짜 서버로 검증). 비밀 값(키/비밀번호)은 어디에도 출력하지 않는다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { KNOWN_PRODUCTION_PROJECT_REFS } from "../ci/liveEnvPreflight.mjs";
import { checkCiDevEnv, FIXTURE_ACCOUNTS } from "./requiredEnv.mjs";

export const FIXTURE_CENTER_NAME = "CI Fixture Center (do not delete)";
export const FIXTURE_PRODUCT_NAME = "CI Fixture Pass 10";
const ACCOUNT_DISPLAY = { USER_A: "CI User A", USER_B: "CI User B", MANAGER_A: "CI Manager A", MANAGER_B: "CI Manager B" };
const MANAGER_LIKE = new Set(["MANAGER_A", "MANAGER_B"]);

export function projectRefFromUrl(url) {
  try { const h = new URL(String(url).trim()).hostname.toLowerCase(); const m = h.match(/^([a-z0-9]+)\.supabase\.co$/); return m ? m[1] : null; } catch { return null; }
}

// 변경 작업(seed)용 3중 조건: ① Production 아님(+필수 env) ② CI_DEV_TARGET_PROJECT_REF == URL의 ref ③ CI_DEV_SEED_ACK=1.
// 네트워크 호출 이전에 호출해야 한다. 위반 시 Error(비밀 값 미포함).
export function assertSeedAllowed(env) {
  const { ok, problems } = checkCiDevEnv(env, { forSeed: true });
  if (!ok) throw new Error("안전하지 않거나 불완전한 환경:\n  - " + problems.join("\n  - "));
  const urlRef = projectRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!urlRef) throw new Error("NEXT_PUBLIC_SUPABASE_URL이 https://<ref>.supabase.co 형식이 아님(로컬/커스텀 도메인은 거부)");
  if (KNOWN_PRODUCTION_PROJECT_REFS.includes(urlRef)) throw new Error("대상이 Production project임");
  const expected = String(env.CI_DEV_TARGET_PROJECT_REF ?? "").trim().toLowerCase();
  if (!expected) throw new Error("CI_DEV_TARGET_PROJECT_REF가 필요함(작업 대상 dev project ref를 직접 입력)");
  if (expected !== urlRef) throw new Error("CI_DEV_TARGET_PROJECT_REF가 NEXT_PUBLIC_SUPABASE_URL의 project ref와 다름");
  if (env.CI_DEV_SEED_ACK !== "1") throw new Error("CI_DEV_SEED_ACK=1 이 필요함");
  return { ref: urlRef };
}

export function makeClient(env, fetchImpl = fetch) {
  const base = String(env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = (extra = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, ...extra });
  async function call(method, url, body, extra) {
    const res = await fetchImpl(url, { method, headers: headers(body ? { "Content-Type": "application/json", ...extra } : extra), body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* 본문 없음 */ }
    return { status: res.status, ok: res.ok, json };
  }
  return {
    select: (table, query) => call("GET", `${base}/rest/v1/${table}?${query}`),
    insert: (table, row) => call("POST", `${base}/rest/v1/${table}?select=id`, row, { Prefer: "return=representation" }),
    openapi: () => call("GET", `${base}/rest/v1/`, undefined, { Accept: "application/openapi+json" }),
    listUsers: () => call("GET", `${base}/auth/v1/admin/users?per_page=1000`),
    createUser: (email, password) => call("POST", `${base}/auth/v1/admin/users`, { email, password, email_confirm: true }),
    updateUser: (id, patch) => call("PUT", `${base}/auth/v1/admin/users/${id}`, patch),
  };
}

const enc = encodeURIComponent;
function fail(step, r) { throw new Error(`${step} 실패(HTTP ${r.status}${r.json?.code ? ` ${r.json.code}` : ""}): ${r.json?.message ?? r.json?.msg ?? "응답 없음"}`); }

// 멱등 fixture 보장. 실패하면 throw — 재실행하면 이미 만든 것은 재사용하고 이어서 진행한다. 반환: 비밀이 아닌 ID 매핑.
export async function ensureFixtures(client, env, log = () => {}) {
  const users = await client.listUsers(); if (!users.ok) fail("Auth 사용자 목록", users);
  const byEmail = new Map((users.json?.users ?? []).map((u) => [String(u.email).toLowerCase(), u]));
  const ids = { accounts: {}, profiles: {} };
  for (const a of FIXTURE_ACCOUNTS) {
    const email = env[`TEST_${a}_EMAIL`], password = env[`TEST_${a}_PASSWORD`];
    let user = byEmail.get(String(email).toLowerCase());
    if (!user) { const c = await client.createUser(email, password); if (!c.ok) fail(`Auth 사용자 ${a} 생성`, c); user = c.json; log(`${a}: auth user created`); }
    else { const u = await client.updateUser(user.id, { password, email_confirm: true }); if (!u.ok) fail(`Auth 사용자 ${a} 갱신`, u); log(`${a}: auth user reused (password/confirm 동기화)`); }
    let acc = await client.select("accounts", `select=id&auth_id=eq.${enc(user.id)}`); if (!acc.ok) fail(`accounts ${a} 조회`, acc);
    let accountId = acc.json?.[0]?.id;
    if (!accountId) { const i = await client.insert("accounts", { auth_id: user.id, name: ACCOUNT_DISPLAY[a], is_member: true, is_manager: MANAGER_LIKE.has(a) }); if (!i.ok) fail(`accounts ${a} 생성`, i); accountId = i.json[0].id; log(`${a}: account created`); }
    let prof = await client.select("profiles", `select=id&account_id=eq.${enc(accountId)}&is_primary=eq.true`); if (!prof.ok) fail(`profiles ${a} 조회`, prof);
    let profileId = prof.json?.[0]?.id;
    if (!profileId) { const i = await client.insert("profiles", { account_id: accountId, name: ACCOUNT_DISPLAY[a], is_primary: true }); if (!i.ok) fail(`profiles ${a} 생성`, i); profileId = i.json[0].id; log(`${a}: primary profile created`); }
    ids.accounts[a] = accountId; ids.profiles[a] = profileId;
  }
  const ce = await client.select("centers", `select=id,status&name=eq.${enc(FIXTURE_CENTER_NAME)}`); if (!ce.ok) fail("centers 조회", ce);
  if ((ce.json?.length ?? 0) > 1) throw new Error(`fixture 센터("${FIXTURE_CENTER_NAME}")가 ${ce.json.length}개 — 수동 정리 후 재실행(자동 삭제 안 함)`);
  let centerId = ce.json?.[0]?.id;
  if (!centerId) { const i = await client.insert("centers", { name: FIXTURE_CENTER_NAME, status: "approved" }); if (!i.ok) fail("centers 생성", i); centerId = i.json[0].id; log("center created"); } else log("center reused");
  const pr = await client.select("products", `select=id&center_id=eq.${enc(centerId)}&name=eq.${enc(FIXTURE_PRODUCT_NAME)}`); if (!pr.ok) fail("products 조회", pr);
  if ((pr.json?.length ?? 0) > 1) throw new Error(`fixture 상품("${FIXTURE_PRODUCT_NAME}")이 ${pr.json.length}개 — 수동 정리 후 재실행`);
  let productId = pr.json?.[0]?.id;
  if (!productId) { const i = await client.insert("products", { center_id: centerId, name: FIXTURE_PRODUCT_NAME, price: 10000, product_kind: "pass", pass_type: "count", total_count: 10, is_on_sale: true, is_active: true }); if (!i.ok) fail("products 생성", i); productId = i.json[0].id; log("product created"); } else log("product reused");
  return { ...ids, TEST_CENTER_ID: centerId, TEST_PRODUCT_ID: productId };
}

// 테스트/라이브러리가 실제로 쓰는 table·rpc 이름을 정적 스캔(요구 목록을 코드와 항상 일치시킨다).
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) { if (n === "node_modules" || n.startsWith(".")) continue; const p = path.join(dir, n); const s = statSync(p); if (s.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p); }
  return out;
}
export function scanUsage(root, subdirs) {
  const tables = new Set(), rpcs = new Set();
  for (const d of subdirs) { let files = []; try { files = walk(path.join(root, d)); } catch { continue; }
    for (const f of files) { const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g)) tables.add(m[1]);
      for (const m of src.matchAll(/\.rpc\(\s*["'`]([a-z_][a-z0-9_]*)["'`]/g)) rpcs.add(m[1]); } }
  return { tables: [...tables].sort(), rpcs: [...rpcs].sort() };
}
