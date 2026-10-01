/*
  Production QA runner 기반(2026-10-02) — 실제 Production 접근 없이 검증 가능한 순수 helper / 소스 계약 / SQL 계약 / 가시성 모델.
  이 테스트는 Supabase에 연결하지 않는다.
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_PROJECT_REF, QaGuardError, QA_REQUIRED_ENV_NAMES, assertProductionQaAllowed, missingQaEnvNames, projectRefFromUrl,
} from "../qa/guard";
import { CLEANUP_ORDER, FixtureTracker, QA_CENTER_NAME, cleanupFixtures, createRunId, isQaRunName, qaName, shouldKeepFailedFixtures } from "../qa/runContext";
import { ensureQaCenter, ensureQaMember } from "../qa/fixtures/center";
import { stateForFile } from "../qa/fixtures/state";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const noSqlComments = (s: string) => s.replace(/--.*$/gm, "");

const URL_OK = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;
const okEnv = { NEXT_PUBLIC_SUPABASE_URL: URL_OK, QA_TARGET_PROJECT_REF: PRODUCTION_PROJECT_REF, QA_PRODUCTION_ACK: "1" };

describe("Production safety guard", () => {
  it("URL에서 project ref를 뽑고 형식이 아니면 null", () => {
    expect(projectRefFromUrl(URL_OK)).toBe(PRODUCTION_PROJECT_REF);
    expect(projectRefFromUrl("https://example.com")).toBeNull();
    expect(projectRefFromUrl("not a url")).toBeNull();
    expect(projectRefFromUrl(undefined)).toBeNull();
  });
  it("세 조건(URL ref 일치 + QA_TARGET_PROJECT_REF + QA_PRODUCTION_ACK=1)을 모두 만족해야 통과", () => {
    expect(assertProductionQaAllowed(okEnv).projectRef).toBe(PRODUCTION_PROJECT_REF);
  });
  it("opt-in(QA_PRODUCTION_ACK=1)이 없으면 즉시 중단", () => {
    expect(() => assertProductionQaAllowed({ ...okEnv, QA_PRODUCTION_ACK: undefined })).toThrow(QaGuardError);
    expect(() => assertProductionQaAllowed({ ...okEnv, QA_PRODUCTION_ACK: "true" })).toThrow("QA_PRODUCTION_ACK=1");
  });
  it("대상 ref 미설정/불일치/다른 프로젝트면 중단(다른 프로젝트 오조작 방지)", () => {
    expect(() => assertProductionQaAllowed({ ...okEnv, QA_TARGET_PROJECT_REF: undefined })).toThrow("QA_TARGET_PROJECT_REF");
    expect(() => assertProductionQaAllowed({ ...okEnv, QA_TARGET_PROJECT_REF: "aaaaaaaaaaaaaaaaaaaa" })).toThrow("달라");
    const other = "https://aaaaaaaaaaaaaaaaaaaa.supabase.co";
    expect(() => assertProductionQaAllowed({ ...okEnv, NEXT_PUBLIC_SUPABASE_URL: other, QA_TARGET_PROJECT_REF: "aaaaaaaaaaaaaaaaaaaa" })).toThrow("Production 프로젝트에만");
    expect(() => assertProductionQaAllowed({ ...okEnv, NEXT_PUBLIC_SUPABASE_URL: undefined })).toThrow("project ref");
  });
  it("누락된 env는 이름만 알려주고 값은 어디에도 없다", () => {
    const missing = missingQaEnvNames({ NEXT_PUBLIC_SUPABASE_URL: "x" });
    expect(missing).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(missing).toContain("QA_PRODUCTION_ACK");
    expect(missing).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(QA_REQUIRED_ENV_NAMES).toContain("TEST_MANAGER_A_PASSWORD");
  });
});

describe("실행 단위 / 정리 범위", () => {
  it("runId와 이름 규칙: 항상 [QA <runId>] prefix", () => {
    const id = createRunId(new Date("2026-10-02T03:04:05Z"), () => 0.5);
    expect(id).toMatch(/^qa202610020304-[0-9a-z]{4}$/);
    expect(qaName(id, "피겨화 대여")).toBe(`[QA ${id}] 피겨화 대여`);
    expect(isQaRunName(qaName(id, "x"), id)).toBe(true);
    expect(isQaRunName("실제 상품", id)).toBe(false);
    expect(QA_CENTER_NAME.startsWith("[QA]")).toBe(true);
  });
  it("tracker는 UUID만 기록(중복 제거), 정리 순서는 예약→수업→수강권→상품", () => {
    const t = new FixtureTracker("qa-test");
    const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    t.add("products", u(1)); t.add("memberships", u(2)); t.add("classes", u(3)); t.add("reservations", u(4)); t.add("reservations", u(4));
    t.add("payments", u(5)); t.add("orders", u(6)); t.add("coupons", u(7)); t.add("member_coupons", u(8)); t.add("coupon_products", u(9)); t.add("admin_action_logs", u(10)); t.add("manager_centers", u(11)); t.add("center_roles", u(12));
    t.add("classes", "not-a-uuid"); t.add("classes", null); t.add("classes", "'; drop table classes; --");
    expect(t.total()).toBe(12);
    const order = ["reservations", "classes", "payments", "admin_action_logs", "memberships", "orders", "member_coupons", "coupon_products", "coupons", "products", "manager_centers", "center_roles"];
    expect(t.plan().map((s) => s.kind)).toEqual(order);
    expect(CLEANUP_ORDER).toEqual(order);
    expect(new FixtureTracker("empty").plan()).toEqual([]);
  });
  it("cleanup은 이번 실행의 UUID 목록으로만 삭제(.in(id, ids)), 한 단계 실패가 나머지를 막지 않고, keep이면 아무것도 안 지운다", async () => {
    const calls: { table: string; ids: string[] }[] = [];
    const fake: any = {
      from: (table: string) => ({
        delete: () => ({ in: (col: string, ids: string[]) => ({ select: async () => {
          expect(col).toBe("id");
          calls.push({ table, ids });
          return table === "classes" ? { data: null, error: { message: "boom" } } : { data: ids.map((id) => ({ id })), error: null };
        } }) }),
      }),
    };
    const t = new FixtureTracker("qa-test");
    const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    t.add("reservations", u(1)); t.add("classes", u(2)); t.add("memberships", u(3)); t.add("products", u(4));
    const res = await cleanupFixtures(fake, t);
    expect(calls.map((c) => c.table)).toEqual(["reservations", "classes", "memberships", "products"]);
    expect(calls.every((c) => c.ids.length === 1)).toBe(true);
    expect(res.failures).toEqual(["classes: boom"]);
    expect(res.deleted.memberships).toBe(1);
    calls.length = 0;
    expect((await cleanupFixtures(fake, t, { keep: true })).kept).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("실패 fixture 보존 옵션: QA_KEEP_FAILED_FIXTURES=1 이고 실패했을 때만 보존(기본은 정리)", () => {
    expect(shouldKeepFailedFixtures({ QA_KEEP_FAILED_FIXTURES: "1" }, true)).toBe(true);
    expect(shouldKeepFailedFixtures({ QA_KEEP_FAILED_FIXTURES: "1" }, false)).toBe(false);
    expect(shouldKeepFailedFixtures({}, true)).toBe(false);
  });
});

// 최소한의 PostgREST 체인 fake: from(table)가 호출되면 그 table의 동작별 응답을 반환
function fakeAdmin(script: Record<string, any>) {
  const log: { table: string; op: string; args?: unknown }[] = [];
  const builder = (table: string) => {
    const state: any = { op: "select" };
    const b: any = {
      select: () => { return b; }, eq: () => b, order: () => b, limit: () => b, in: () => b,
      insert: (row: unknown) => { state.op = "insert"; log.push({ table, op: "insert", args: row }); return b; },
      update: (row: unknown) => { state.op = "update"; log.push({ table, op: "update", args: row }); return b; },
      upsert: (row: unknown) => { state.op = "upsert"; log.push({ table, op: "upsert", args: row }); return b; },
      single: async () => script[`${table}.${state.op}.single`] ?? script[`${table}.${state.op}`] ?? { data: null, error: null },
      maybeSingle: async () => script[`${table}.${state.op}.maybe`] ?? script[`${table}.${state.op}`] ?? { data: null, error: null },
      then: (res: any) => res(script[`${table}.${state.op}`] ?? { data: [], error: null }),
    };
    return b;
  };
  return { admin: { from: (t: string) => builder(t) } as any, log };
}

describe("ensureQaCenter / ensureQaMember (fake admin, 네트워크 없음)", () => {
  const MGR = "00000000-0000-4000-8000-0000000000aa";
  it("센터가 없으면 approved + is_internal=true로 만들고 기존 owner role로 매니저를 연결한다(role 중복 생성 없음)", async () => {
    const { admin, log } = fakeAdmin({
      "centers.select": { data: [], error: null },
      "centers.insert.single": { data: { id: "c1" }, error: null },
      "center_roles.select.maybe": { data: { id: "role1" }, error: null },
      "manager_centers.select.maybe": { data: null, error: null },
    });
    const id = await ensureQaCenter(admin, MGR);
    expect(id).toBe("c1");
    const created = log.find((l) => l.table === "centers" && l.op === "insert")!.args as any;
    expect(created).toMatchObject({ name: QA_CENTER_NAME, status: "approved", is_internal: true });
    expect(log.some((l) => l.table === "center_roles" && l.op === "insert")).toBe(false);
    expect(log.find((l) => l.table === "manager_centers" && l.op === "insert")!.args).toMatchObject({ account_id: MGR, role_id: "role1", status: "active" });
    expect(log.find((l) => l.table === "centers" && l.op === "update")!.args).toMatchObject({ status: "approved", is_internal: true });
  });
  it("같은 이름 센터의 오너가 QA 매니저가 아니면(실제 센터일 수 있음) 아무것도 수정하지 않고 중단", async () => {
    const { admin, log } = fakeAdmin({
      "centers.select": { data: [{ id: "real" }], error: null },
      "manager_centers.select": { data: [{ account_id: "someone-else", center_roles: { is_owner: true } }], error: null },
    });
    await expect(ensureQaCenter(admin, MGR)).rejects.toThrow("실제 센터");
    expect(log.some((l) => l.op === "update" || l.op === "insert")).toBe(false);
  });
  it("is_internal 컬럼이 없으면(SQL 미적용) 명확한 안내와 함께 중단 — SQL을 대신 실행하지 않는다", async () => {
    const { admin } = fakeAdmin({ "centers.select": { data: null, error: { code: "42703", message: "column does not exist" } } });
    await expect(ensureQaCenter(admin, MGR)).rejects.toThrow("add_internal_qa_center_flag.sql");
  });
  it("QA 회원은 이미 있으면 재사용, 없을 때만 QA 센터에 center_members 생성", async () => {
    const a = fakeAdmin({ "center_members.select.maybe": { data: { id: "m" }, error: null } });
    await ensureQaMember(a.admin, "c1", "p1");
    expect(a.log.some((l) => l.op === "insert")).toBe(false);
    const b = fakeAdmin({ "center_members.select.maybe": { data: null, error: null } });
    await ensureQaMember(b.admin, "c1", "p1");
    expect(b.log.find((l) => l.op === "insert")!.args).toMatchObject({ center_id: "c1", profile_id: "p1" });
  });
  it("상태 파일에는 id만 저장(비밀번호/토큰/키 없음)", () => {
    const f = stateForFile({ centerId: "c", managerAccountId: "m", memberAccountId: "a", memberProfileId: "p" }, new Date("2026-10-02T00:00:00Z"));
    expect(Object.keys(f).sort()).toEqual(["centerId", "managerAccountId", "memberAccountId", "memberProfileId", "updatedAt"]);
    expect(read(".gitignore")).toContain(".qa-state/");
  });
});

describe("일반 test / integration 실행과 분리", () => {
  it("unit/integration 설정은 tests/qa를 포함하지 않고, QA 설정은 *.qa.test.ts만 포함", () => {
    expect(read("vitest.config.ts")).toContain('include: ["tests/unit/**/*.test.ts"]');
    expect(read("vitest.integration.config.ts")).toContain('include: ["tests/integration/**/*.test.ts"]');
    const qa = read("vitest.qa-production.config.ts");
    expect(qa).toContain('include: ["tests/qa/**/*.qa.test.ts"]');
    expect(qa).toContain('setupFiles: ["tests/qa/qaEnv.ts"]');
  });
  it("Production QA는 별도 npm script에서만 실행되고 기본 test/test:all/integration script와 연결되지 않는다", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["qa:production:goods"]).toContain("--config vitest.qa-production.config.ts");
    expect(scripts["qa:production:visibility"]).toContain("--config vitest.qa-production.config.ts");
    for (const k of ["test", "test:integration", "test:all", "qa:business:all"]) expect(scripts[k]).not.toContain("tests/qa");
  });
  it("env 로더가 안전장치를 첫 단계에서 호출한다", () => {
    const env = read("tests/qa/qaEnv.ts");
    expect(env.indexOf("missingQaEnvNames")).toBeGreaterThan(-1);
    expect(env.indexOf("assertProductionQaAllowed(process.env)")).toBeGreaterThan(env.indexOf("missingQaEnvNames"));
    expect(env).toContain("QA_ENV_FILE");
  });
});

describe("비밀 값 하드코딩/출력 금지", () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(join(root, dir))) { const p = `${dir}/${f}`; statSync(join(root, p)).isDirectory() ? walk(p) : files.push(p); } };
  walk("tests/qa");
  it("tests/qa 코드에 JWT/이메일/실제 UUID/비밀번호 리터럴이 없다", () => {
    for (const f of files) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(code, f).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
      expect(code, f).not.toMatch(/service_role\s*[:=]\s*["'`]/);
      // QA 센터 UUID 등 실제 id를 코드에 박지 않는다(자리표시 000… UUID와 테스트 fixture만 허용)
      const uuids = code.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) ?? [];
      for (const u of uuids) expect(u.startsWith("00000000-0000-4000-8000-"), `${f}: ${u}`).toBe(true);
    }
  });
  it("env 값을 console로 출력하지 않는다(이름만)", () => {
    for (const f of files) {
      const code = read(f);
      expect(code, f).not.toMatch(/console\.(log|warn|error)\([^)]*process\.env\.[A-Z_]*(PASSWORD|KEY|SERVICE)/);
    }
  });
});

describe("시나리오 계약: 대여상품 차감/복원", () => {
  const sc = read("tests/qa/scenarios/reservation-goods-usage.qa.test.ts");
  it("앱이 실제로 쓰는 경로(reserveWithGoods → reserve_with_goods, cancelReservation → cancel_reservation)를 호출", () => {
    expect(sc).toContain('import { cancelReservation, reserveWithGoods } from "../../../lib/reservations"');
    expect(read("lib/reservations.ts")).toContain('rpc("reserve_with_goods"');
    expect(read("lib/reservations.ts")).toContain('rpc("cancel_reservation"');
  });
  it("검증 순서: 4 → 3 → 4, 사용 기록 deducted → restored, 재호출 과복원 없음, 알림은 QA 계정만", () => {
    for (const s of ["toBe(4)", "toBe(3)", "deducted", "restored", "과복원", "rejects.toThrow", "recipient_account_id"]) expect(sc).toContain(s);
    expect(sc.indexOf("expect(await remaining(goodsId)).toBe(3)")).toBeLessThan(sc.indexOf('.status).toBe("restored")'));
  });
  it("정리는 tracker(이번 실행 UUID)로만, 실패 보존 옵션을 존중", () => {
    expect(sc).toContain("cleanupFixtures(admin(), tracker, { keep })");
    expect(sc).toContain("shouldKeepFailedFixtures(process.env, failed)");
    expect(sc).not.toMatch(/\.delete\(\)\.eq\("center_id"/);
  });
});

// ── QA 센터 숨김: SQL 계약 + 가시성 모델 ─────────────────────────────────────────────────────────────
const sql = noSqlComments(read("add_internal_qa_center_flag.sql"));

describe("add_internal_qa_center_flag.sql 계약", () => {
  it("flag 컬럼은 default false(기존 센터 불변), 어떤 센터도 자동으로 internal로 바꾸지 않고 데이터를 지우지 않는다", () => {
    expect(sql).toContain("add column if not exists is_internal boolean not null default false");
    expect(sql).not.toMatch(/update centers/i);
    expect(sql).not.toMatch(/delete from|drop table|truncate/i);
    expect(sql).not.toMatch(/name\s+(not\s+)?(i?like)\s+'\[QA/i);   // 이름 기반 숨김 금지
  });
  it("centers / classes / products 조회 정책이 internal 센터를 그 센터의 회원·관리자에게만 보여준다", () => {
    expect(sql).toContain("(status = 'approved' and (not is_internal or id in (select my_member_center_ids())))");
    expect(sql.match(/c\.status = 'approved' and \(not c\.is_internal or c\.id in \(select my_member_center_ids\(\)\)\)/g)?.length).toBe(2);
    expect(sql).toContain("or id in (select my_managed_center_ids())");
    expect(sql).toContain("or is_platform_admin()");
  });
  it("공개 storefront RPC는 internal 센터를 제외하고 anon 허용은 그 RPC 하나, 회원 RPC는 anon 차단 유지", () => {
    expect(sql).toContain("and not c.is_internal");
    expect(sql).toContain("grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;");
    expect(sql).toContain("revoke all on function public.fetch_purchasable_products(uuid) from public, anon;");
    expect(sql).toContain("grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;");
  });
  it("회원용 구매 상품 RPC도 internal 센터는 회원/관리자만(UUID를 알아도 일반 계정은 빈 목록)", () => {
    expect(sql).toContain("not exists (select 1 from centers c where c.id = p.center_id and c.is_internal)");
    expect(sql).toContain("or p.center_id in (select my_member_center_ids())");
  });
  it("helper는 SECURITY DEFINER + search_path 고정(RLS 재귀 방지), 정책 평가에 필요해 anon 실행은 유지", () => {
    const h = sql.slice(sql.indexOf("create or replace function my_member_center_ids"), sql.indexOf('drop policy if exists "승인된 센터 조회"'));
    expect(h).toContain("security definer");
    expect(h).toContain("set search_path = public");
    expect(h).toContain("grant execute on function my_member_center_ids() to anon, authenticated, service_role;");
  });
  it("롤백은 정책/RPC를 적용 전 정의로 복원하고 helper를 제거하며 컬럼은 보존", () => {
    const rb = read("rollback_add_internal_qa_center_flag.sql");
    expect(rb).toContain("status = 'approved'\n        or id in (select my_managed_center_ids())");
    expect(rb).toContain("drop function if exists my_member_center_ids();");
    expect(rb).toContain("-- alter table centers drop column if exists is_internal;");
    expect(rb).not.toMatch(/^alter table centers drop column/m);
  });
  it("클라이언트 코드는 is_internal 컬럼에 의존하지 않는다 → SQL 적용 전에도 기존 화면이 깨지지 않는다(숨김은 서버 RLS)", () => {
    for (const f of ["lib/home.ts", "lib/center.ts", "lib/inquiries.ts", "lib/mypage.ts", "lib/manager.ts"]) expect(read(f), f).not.toContain("is_internal");
  });
});

// 위 정책 predicate를 그대로 옮긴 순수 모델 — 요구된 시나리오(일반 공개 / QA 숨김 / QA 매니저·회원 접근)를 확인한다.
type Viewer = { kind: "anon" } | { kind: "user"; joined: string[]; managed: string[]; admin?: boolean };
type Center = { id: string; status: "pending" | "approved"; isInternal: boolean };
const centerVisible = (c: Center, v: Viewer): boolean => {
  if (v.kind === "anon") return c.status === "approved" && !c.isInternal;
  return (c.status === "approved" && (!c.isInternal || v.joined.includes(c.id))) || v.managed.includes(c.id) || !!v.admin;
};
const publicStorefront = (centers: Center[]) => centers.filter((c) => c.status === "approved" && !c.isInternal).map((c) => c.id);

describe("가시성 모델(요구 시나리오 1·2·7·8·9·10·11·12)", () => {
  const normal: Center = { id: "normal", status: "approved", isInternal: false };
  const qa: Center = { id: "qa", status: "approved", isInternal: true };
  const stranger: Viewer = { kind: "user", joined: [], managed: [] };
  it("일반 approved 센터(is_internal=false)는 기존처럼 공개(anon/일반 사용자 모두)", () => {
    expect(centerVisible(normal, { kind: "anon" })).toBe(true);
    expect(centerVisible(normal, stranger)).toBe(true);
  });
  it("QA 센터(approved + is_internal)는 anon/일반 로그인 사용자에게 숨겨진다(홈·검색·카테고리·문의 검색·직접 URL 모두 같은 centers 정책)", () => {
    expect(centerVisible(qa, { kind: "anon" })).toBe(false);
    expect(centerVisible(qa, stranger)).toBe(false);
  });
  it("공개 storefront에는 QA 센터 상품이 나오지 않는다(상품 개별 판매중지에 의존하지 않음)", () => {
    expect(publicStorefront([normal, qa])).toEqual(["normal"]);
  });
  it("QA 매니저(managed)와 QA 회원(joined)은 QA 센터에 정상 접근, 플랫폼 관리자도 가능", () => {
    expect(centerVisible(qa, { kind: "user", joined: [], managed: ["qa"] })).toBe(true);
    expect(centerVisible(qa, { kind: "user", joined: ["qa"], managed: [] })).toBe(true);
    expect(centerVisible(qa, { kind: "user", joined: [], managed: [], admin: true })).toBe(true);
  });
  it("QA 센터가 approved라 예약 RPC(status='approved' 요구)는 그대로 동작한다 — pending으로 숨기지 않는다", () => {
    expect(qa.status).toBe("approved");
    expect(read("tests/qa/fixtures/center.ts")).toContain('{ status: "approved", is_internal: true }');
    expect(read("tests/qa/fixtures/center.ts")).not.toContain('status: "pending"');
  });
});
