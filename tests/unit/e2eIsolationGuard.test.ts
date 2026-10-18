// E2E 격리 DB 가드(#229)와 new-class-creation.spec.ts 정적 안전 확인 — 오프라인(DB 접속 없음).
// 수강권 정리 로직 자체의 검증은 runOwnedProductCleanup.test.ts / runOwnedProductCleanup.pglite.test.ts(#231).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ownsClass } from "../e2e/fixtures/runOwnedProductCleanup";
import { assertIsolatedTestDb, ISOLATED_DB_ACK_PHRASE, IsolatedTestDbGuardError } from "../e2e/fixtures/isolatedTestDbGuard";

describe("ownsClass", () => {
  it("수업 소유권은 제목의 실행 UUID 조각과 센터가 모두 맞아야 한다", () => {
    expect(ownsClass({ id: "1", title: "NEWCLASS-BUY-ab12cd34-1760", center_id: "c" }, { runShort: "ab12cd34", centerId: "c" })).toBe(true);
    expect(ownsClass({ id: "1", title: "NEWCLASS-BUY-ab12cd34-1760", center_id: "other" }, { runShort: "ab12cd34", centerId: "c" })).toBe(false);
    expect(ownsClass({ id: "1", title: "정규 수업", center_id: "c" }, { runShort: "ab12cd34", centerId: "c" })).toBe(false);
  });
});

describe("격리 DB 가드(assertIsolatedTestDb) — 공유 DEV/Production에서 파괴적 E2E 차단", () => {
  const REF = "abcdefghij0123456789"; // 형식만 맞춘 가짜 ref
  const ok = (): Record<string, string> => ({ ISOLATED_TEST_DB_PROJECT_REF: REF, ISOLATED_TEST_DB_ACK: ISOLATED_DB_ACK_PHRASE, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` });
  const fails = (env: Record<string, string | undefined>, re?: RegExp) => { try { assertIsolatedTestDb(env); } catch (e) { expect(e).toBeInstanceOf(IsolatedTestDbGuardError); if (re) expect((e as Error).message).toMatch(re); return; } throw new Error("가드가 통과함"); };
  const jwt = (ref: string) => `h.${Buffer.from(JSON.stringify({ ref })).toString("base64url")}.s`;

  it("아무 선언이 없으면(공유 DEV 기본 상태) 차단", () => fails({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` }, /미선언/));
  it("ref만 선언하고 확인 문구가 없으면 차단", () => fails({ ...ok(), ISOLATED_TEST_DB_ACK: "1" }, /확인 문구/));
  it("정확히 선언·확인·URL 일치하면 통과", () => expect(() => assertIsolatedTestDb(ok())).not.toThrow());
  it("URL의 프로젝트가 선언과 다르면 차단(공유 DEV를 가리킨 채 다른 ref만 선언)", () => fails({ ...ok(), NEXT_PUBLIC_SUPABASE_URL: "https://zzzzzzzzzz0123456789.supabase.co" }, /일치하지 않음/));
  it("선언한 ref가 Production이면 차단", () => fails({ ...ok(), ISOLATED_TEST_DB_PROJECT_REF: "bxntqggkfwnhcczsbqtj", NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co" }, /Production/));
  it("선언한 ref가 공유 DEV 목록에 있으면 차단", () => fails({ ...ok(), SHARED_DEV_PROJECT_REFS: `foo, ${REF}` }, /공유 DEV/));
  it("URL 우회(userinfo·경로·부분 일치·http 호스트 변형)는 모두 차단", () => {
    for (const u of [`https://${REF}.supabase.co.evil.example`, `https://x@${REF}.supabase.co`, `https://${REF}.supabase.co/rest/v1`, `https://evil.example/${REF}.supabase.co`, ""]) fails({ ...ok(), NEXT_PUBLIC_SUPABASE_URL: u });
  });
  it("service/anon 키의 project ref가 선언과 다르면 차단", () => {
    fails({ ...ok(), SUPABASE_SERVICE_ROLE_KEY: jwt("zzzzzzzzzz0123456789") }, /SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => assertIsolatedTestDb({ ...ok(), SUPABASE_SERVICE_ROLE_KEY: jwt(REF) })).not.toThrow();
  });
  it("오류 메시지에 URL/키 값을 넣지 않는다", () => {
    try { assertIsolatedTestDb({ NEXT_PUBLIC_SUPABASE_URL: "https://secretsecretsecret12.supabase.co", SUPABASE_SERVICE_ROLE_KEY: jwt("secretsecretsecret12") }); } catch (e) { expect((e as Error).message).not.toContain("secretsecretsecret12"); return; }
    throw new Error("통과하면 안 됨");
  });
});

describe("new-class-creation.spec.ts 정적 안전 확인 (#231 정리 모듈 + #229 격리 가드)", () => {
  const spec = readFileSync("tests/e2e/admin/new-class-creation.spec.ts", "utf8");
  it("조건 없이 memberships/payments/reservations를 직접 지우는 코드가 없다(소유권 모듈만 사용)", () => {
    expect(spec).not.toMatch(/from\("(memberships|payments|reservations)"\)[\s\S]{0,80}\.delete\(/);
    expect(spec).not.toMatch(/cleanupBuyProductMemberships\(/);
    expect(spec).toContain("executeRunOwnedCleanup");
  });
  it("beforeAll은 어떤 DB 접근보다 먼저 격리 DB 가드를 확인하고, 실패하면 BLOCKED로 건너뛴다", () => {
    const before = spec.slice(spec.indexOf("test.beforeAll"));
    expect(before.indexOf("assertIsolatedTestDb")).toBeGreaterThan(-1);
    expect(before.indexOf("assertIsolatedTestDb")).toBeLessThan(before.indexOf("loadTestAccountMeta"));
    expect(before).toMatch(/test\.skip\(true, `BLOCKED:/);
  });
  it("afterAll은 격리 확인 전에는 아무 것도 하지 않고, 소유 증명 계획 → 수업 삭제 → 증명된 데이터 삭제 순서를 지킨다", () => {
    const after = spec.slice(spec.indexOf("test.afterAll"), spec.indexOf("test.beforeAll"));
    expect(after.indexOf("if (!isolatedDbConfirmed) return;")).toBeGreaterThan(-1);
    const iPrep = after.indexOf("prepareRunOwnedCleanup(");
    const iClasses = after.indexOf("cleanupOwnedClasses()");
    const iExec = after.indexOf("executeRunOwnedCleanup(");
    expect(iPrep).toBeGreaterThan(-1); expect(iPrep).toBeLessThan(iClasses); expect(iClasses).toBeLessThan(iExec);
  });
  it("beforeAll은 아무 것도 지우지 않고(실행별 새 상품), 모든 신규 수업 제목에 실행별 UUID 조각이 들어간다", () => {
    expect(spec).toContain("신규구매전용패스 ${RUN_SHORT}");
    expect(spec).not.toContain("preexistingBuyMembershipIds");
    for (const k of ["ALL", "SPECIFIC", "BUY", "GOODSCHK", "CONTROL"]) expect(spec).toContain(`NEWCLASS-${k}-\${RUN_SHORT}`);
  });
});
