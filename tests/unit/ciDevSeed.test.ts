// @ts-nocheck — mjs 모듈 + 가짜 서버
import { describe, expect, it } from "vitest";
import { assertSeedAllowed, ensureFixtures, makeClient, projectRefFromUrl, scanUsage } from "../../scripts/ci-dev/lib.mjs";
import { runSeed, secretMapText } from "../../scripts/ci-dev/seed.mjs";
import { makeReporter, verifyFixtures, verifySchema, SEED_COLUMNS, CORE_TABLES } from "../../scripts/ci-dev/verify.mjs";
import { REQUIRED_SECRET_NAMES } from "../../scripts/ci-dev/requiredEnv.mjs";

const DEV = "https://devprojref123.supabase.co";
const env = (o = {}) => { const e: any = { NEXT_PUBLIC_SUPABASE_URL: DEV, CI_DEV_TARGET_PROJECT_REF: "devprojref123", CI_DEV_SEED_ACK: "1", SUPABASE_SERVICE_ROLE_KEY: "svc" }; for (const n of REQUIRED_SECRET_NAMES) e[n] ??= n.endsWith("EMAIL") ? `${n.toLowerCase()}@example.com` : "x"; delete e.TEST_CENTER_ID; delete e.TEST_PRODUCT_ID; return { ...e, ...o }; };

// 최소 가짜 Supabase: auth admin + PostgREST(eq 필터, insert) + openapi
function fakeServer({ failOn = null, schema = true } = {}) {
  const db = { users: [], accounts: [], profiles: [], centers: [], products: [], center_members: [] }; const calls: string[] = []; let n = 0; const id = () => `id-${++n}`;
  const f = async (url: string, init: any = {}) => {
    const u = new URL(url), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null; calls.push(`${method} ${u.pathname}`);
    const res = (status: number, json: any) => ({ status, ok: status < 400, json: async () => json });
    if (failOn && `${method} ${u.pathname}` === failOn) { failOn = null; return res(500, { message: "boom" }); }
    if (u.pathname === "/auth/v1/admin/users" && method === "GET") return res(200, { users: db.users });
    if (u.pathname === "/auth/v1/admin/users" && method === "POST") { const x = { id: id(), email: body.email, email_confirmed_at: "now" }; db.users.push(x); return res(200, x); }
    if (u.pathname.startsWith("/auth/v1/admin/users/") && method === "PUT") return res(200, {});
    if (u.pathname === "/storage/v1/bucket") return res(200, [{ name: "avatars" }]);
    if (u.pathname === "/rest/v1/") return res(200, { definitions: schema ? Object.fromEntries([...CORE_TABLES, "x"].map((t) => [t, { properties: Object.fromEntries((SEED_COLUMNS[t] ?? ["id"]).map((c) => [c, {}])) }])) : {}, paths: {} });
    const table = u.pathname.replace("/rest/v1/", "");
    if (method === "GET") { let rows = db[table] ?? []; for (const [k, v] of u.searchParams) { if (k === "select") continue; const m = String(v).match(/^eq\.(.*)$/); if (m) rows = rows.filter((r) => String(r[k]) === (m[1] === "true" ? "true" : m[1])); } return res(200, rows.map((r) => ({ ...r }))); }
    if (method === "POST") { const row = { id: id(), ...body }; db[table].push(row); return res(201, [{ id: row.id }]); }
    if (method === "PATCH") { const eq = [...u.searchParams].find(([k]) => k === "id"); const row = (db[table] ?? []).find((r) => `eq.${r.id}` === eq?.[1]); if (row) Object.assign(row, body); return res(200, row ? [{ id: row.id }] : []); }
    return res(404, {});
  };
  return { f, db, calls };
}

describe("assertSeedAllowed (네트워크 이전 3중 가드)", () => {
  it("정상 dev → ref 반환", () => expect(assertSeedAllowed(env()).ref).toBe("devprojref123"));
  it("Production URL", () => expect(() => assertSeedAllowed(env({ NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co", CI_DEV_TARGET_PROJECT_REF: "bxntqggkfwnhcczsbqtj" }))).toThrow(/Production/));
  it("명시 ref 누락/불일치", () => { expect(() => assertSeedAllowed(env({ CI_DEV_TARGET_PROJECT_REF: "" }))).toThrow(/CI_DEV_TARGET_PROJECT_REF/); expect(() => assertSeedAllowed(env({ CI_DEV_TARGET_PROJECT_REF: "other" }))).toThrow(/다름/); });
  it("ACK 누락", () => expect(() => assertSeedAllowed(env({ CI_DEV_SEED_ACK: "" }))).toThrow(/ACK/));
  it("비표준 URL(localhost/커스텀 도메인) 거부", () => expect(() => assertSeedAllowed(env({ NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" }))).toThrow(/형식/));
  it("Production 키(JWT ref)도 거부", () => { const jwt = "h." + Buffer.from(JSON.stringify({ ref: "bxntqggkfwnhcczsbqtj" })).toString("base64url") + ".s"; expect(() => assertSeedAllowed(env({ SUPABASE_SERVICE_ROLE_KEY: jwt }))).toThrow(/Production/); });
  it("TEST_CENTER_ID/PRODUCT_ID는 seed 단계 필수가 아니다", () => expect(() => assertSeedAllowed(env())).not.toThrow());
  it("projectRefFromUrl", () => { expect(projectRefFromUrl(DEV)).toBe("devprojref123"); expect(projectRefFromUrl("nope")).toBeNull(); });
});

describe("runSeed", () => {
  it("가드 위반이면 fetch가 한 번도 호출되지 않는다", async () => {
    const s = fakeServer();
    await expect(runSeed(env({ NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co", CI_DEV_TARGET_PROJECT_REF: "bxntqggkfwnhcczsbqtj" }), { fetchImpl: s.f, writeMap: false, log: () => {} })).rejects.toThrow();
    await expect(runSeed(env({ CI_DEV_SEED_ACK: "0" }), { fetchImpl: s.f, writeMap: false, log: () => {} })).rejects.toThrow();
    expect(s.calls).toEqual([]);
  });
  it("처음 실행: 사용자 4 + accounts 4 + profiles 4 + 센터 1 + 상품 1", async () => {
    const s = fakeServer(); const { ids } = await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} });
    expect([s.db.users.length, s.db.accounts.length, s.db.profiles.length, s.db.centers.length, s.db.products.length]).toEqual([4, 4, 4, 1, 1]);
    expect(s.db.centers[0]).toMatchObject({ status: "approved", is_internal: true }); expect(s.db.center_members.length).toBe(2); expect(s.db.products[0]).toMatchObject({ center_id: ids.TEST_CENTER_ID, product_kind: "pass", is_active: true, is_on_sale: true });
    expect(s.db.accounts.filter((a) => a.is_manager).length).toBe(2);
  });
  it("재실행: 중복 생성 없음, 같은 ID 반환", async () => {
    const s = fakeServer(); const a = await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} }); const b = await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} });
    expect([s.db.users.length, s.db.accounts.length, s.db.profiles.length, s.db.centers.length, s.db.products.length]).toEqual([4, 4, 4, 1, 1]); expect(b.ids.TEST_CENTER_ID).toBe(a.ids.TEST_CENTER_ID); expect(b.ids.TEST_PRODUCT_ID).toBe(a.ids.TEST_PRODUCT_ID);
  });
  it("중간 실패 후 재실행으로 복구(센터 생성 직전 실패 → 이어서 완료, 중복 없음)", async () => {
    const s = fakeServer({ failOn: "POST /rest/v1/centers" });
    await expect(runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} })).rejects.toThrow(/centers 생성 실패/);
    expect(s.db.users.length).toBe(4); expect(s.db.centers.length).toBe(0);
    await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} });
    expect([s.db.users.length, s.db.centers.length, s.db.products.length]).toEqual([4, 1, 1]);
  });
  it("기존 센터가 internal이 아니면 보정(PATCH)하고 멤버를 추가한다", async () => {
    const s = fakeServer(); await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} });
    s.db.centers[0].is_internal = false; s.db.center_members.length = 0;
    await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} });
    expect(s.db.centers[0].is_internal).toBe(true); expect(s.db.center_members.length).toBe(2); expect(s.db.centers.length).toBe(1);
    await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} }); expect(s.db.center_members.length).toBe(2);
  });
  it("fixture 센터가 중복이면 자동 삭제하지 않고 중단", async () => {
    const s = fakeServer(); await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} }); s.db.centers.push({ id: "dup", name: s.db.centers[0].name, status: "approved" });
    await expect(runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} })).rejects.toThrow(/2개/);
  });
  it("ID 매핑 텍스트에는 비밀번호/키가 없다", async () => {
    const s = fakeServer(); const { text } = await runSeed(env({ TEST_USER_A_PASSWORD: "p@ss-SECRET", SUPABASE_SERVICE_ROLE_KEY: "svc-SECRET" }), { fetchImpl: s.f, writeMap: false, log: () => {} });
    expect(text).toMatch(/^TEST_CENTER_ID=id-\d+$/m); expect(text).not.toMatch(/SECRET|PASSWORD|svc/);
  });
  it("seed 로그에도 비밀이 없다", async () => {
    const logs: string[] = []; const s = fakeServer(); await runSeed(env({ TEST_USER_A_PASSWORD: "p@ss-SECRET" }), { fetchImpl: s.f, writeMap: false, log: (m) => logs.push(m) });
    expect(logs.join("\n")).not.toContain("SECRET");
  });
});

describe("verify", () => {
  it("seed 후 fixture 검증 전부 PASS, seed 전에는 MISSING", async () => {
    const s = fakeServer(); const client = makeClient(env(), s.f);
    const before = makeReporter(() => {}); await verifyFixtures({ client, env: env({ TEST_CENTER_ID: "x", TEST_PRODUCT_ID: "y" }), report: before.report }); expect(before.failed()).toBe(true);
    const { ids } = await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} });
    const after = makeReporter(() => {}); await verifyFixtures({ client, env: env({ TEST_CENTER_ID: ids.TEST_CENTER_ID, TEST_PRODUCT_ID: ids.TEST_PRODUCT_ID }), report: after.report });
    expect(after.failed()).toBe(false);
  });
  it("센터가 approved가 아니면 MISMATCH", async () => {
    const s = fakeServer(); const { ids } = await runSeed(env(), { fetchImpl: s.f, writeMap: false, log: () => {} }); s.db.centers[0].status = "pending";
    const r = makeReporter(() => {}); await verifyFixtures({ client: makeClient(env(), s.f), env: env({ TEST_CENTER_ID: ids.TEST_CENTER_ID, TEST_PRODUCT_ID: ids.TEST_PRODUCT_ID }), report: r.report });
    expect(r.rows.some((x) => x.status === "MISMATCH")).toBe(true);
  });
  it("스키마가 비어 있으면 MISSING(→ bootstrap은 seed 전에 중단)", async () => {
    const r = makeReporter(() => {}); await verifySchema({ client: makeClient(env(), fakeServer({ schema: false }).f), root: process.cwd(), report: r.report });
    expect(r.failed()).toBe(true);
  });
  it("verify/secret-map/schema 단계는 GET만 사용(변경 없음)", async () => {
    const s = fakeServer(); await verifySchema({ client: makeClient(env(), s.f), root: process.cwd(), report: () => {} });
    expect(s.calls.every((c) => c.startsWith("GET "))).toBe(true);
    const { readFileSync } = await import("node:fs"); for (const f of ["verify", "secret-map"]) expect(readFileSync(`scripts/ci-dev/${f}.mjs`, "utf8")).not.toMatch(/\.insert\(|createUser|updateUser|method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });
  it("스캐너는 storage.from(버킷)을 테이블로 오인하지 않고 버킷으로 분류한다", () => { const u = scanUsage(process.cwd(), ["tests/integration"]); expect(u.tables).not.toContain("avatars"); expect(u.buckets).toContain("avatars"); });
  it("정적 스캔이 테스트의 rpc/table을 찾는다", () => { const u = scanUsage(process.cwd(), ["tests/integration"]); expect(u.tables).toContain("manager_centers"); expect(u.rpcs.length).toBeGreaterThan(3); });
  it("bootstrap은 스키마 실패 시 seed 호출 이전에 중단하도록 구성돼 있다", async () => {
    const { readFileSync } = await import("node:fs"); const b = readFileSync("scripts/ci-dev/bootstrap.mjs", "utf8");
    expect(b.indexOf("schema baseline must be applied first")).toBeLessThan(b.indexOf("await runSeed"));
    expect(b).not.toMatch(/\.sql|psql|db push/);
  });
});
