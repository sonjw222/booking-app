import { checkIsolatedTarget, refOfUrl } from "../../scripts/ci/isolatedTargetGuard.mjs";
import { describe, expect, it } from "vitest";

const PROD = "bxntqggkfwnhcczsbqtj", SHARED = "jdglfvwdnkjnraqdxuuj", ISO = "abcdefghij0123456789";
const jwt = (ref: string) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ref })).toString("base64url")}.sig`;
const good = () => ({ ISOLATED_SUPABASE_URL: `https://${ISO}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: ISO, ISOLATED_SUPABASE_ANON_KEY: jwt(ISO), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(ISO), NEXT_PUBLIC_SUPABASE_URL: `https://${SHARED}.supabase.co` });

describe("격리 대상 가드(#240)", () => {
  it("정상 격리 프로젝트는 OK", () => expect(checkIsolatedTarget(good()).status).toBe("OK"));
  it("설정이 없으면 BLOCKED(쓰기 전에 중단, 값 출력 없음)", () => {
    const r = checkIsolatedTarget({}); expect(r.status).toBe("BLOCKED"); expect(r.problems.join()).toContain("ISOLATED_SUPABASE_URL");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: "" }).status).toBe("BLOCKED");
  });
  it("Production 은 격리로 선언할 수 없다(URL·선언 ref·키 어느 쪽이든)", () => {
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: `https://${PROD}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: PROD, ISOLATED_SUPABASE_ANON_KEY: jwt(PROD), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(PROD) }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(PROD) }).status).toBe("FAILED");
  });
  it("공유 DEV 는 격리로 선언할 수 없다(고정 ref·CI 의 NEXT_PUBLIC_SUPABASE_URL 둘 다)", () => {
    const shared = { ISOLATED_SUPABASE_URL: `https://${SHARED}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: SHARED, ISOLATED_SUPABASE_ANON_KEY: jwt(SHARED), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(SHARED) };
    expect(checkIsolatedTarget(shared).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ...shared, NEXT_PUBLIC_SUPABASE_URL: `https://${SHARED}.supabase.co` }).problems.join()).toContain("공유 DEV");
    // 고정 ref 목록을 몰라도(다른 DEV 로 바뀌어도) CI 가 쓰는 공유 DEV URL 과 같으면 차단
    const other = "zzzzzzzzzz0123456789";
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: `https://${other}.supabase.co`, ISOLATED_SUPABASE_PROJECT_REF: other, ISOLATED_SUPABASE_ANON_KEY: jwt(other), ISOLATED_SUPABASE_SERVICE_ROLE_KEY: jwt(other), NEXT_PUBLIC_SUPABASE_URL: `https://${other}.supabase.co` }).status).toBe("FAILED");
  });
  it("URL·선언 ref·키 ref 불일치는 FAILED", () => {
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_PROJECT_REF: "bbbbbbbbbb0123456789" }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_ANON_KEY: jwt("bbbbbbbbbb0123456789") }).status).toBe("FAILED");
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_ANON_KEY: "not-a-jwt" }).status).toBe("FAILED");
  });
  it("프록시/임의 호스트는 격리 프로젝트로 인정하지 않는다", () => {
    expect(checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: "https://db.example.test" }).status).toBe("FAILED");
  });
  it("로컬 대체는 PARTIAL — 전체 통합 검증으로 보고하면 안 된다", () => {
    const r = checkIsolatedTarget({ ...good(), ISOLATED_SUPABASE_URL: "http://127.0.0.1:3203" });
    expect(r.status).toBe("PARTIAL"); expect(r.problems.join()).toContain("Auth/Storage/Realtime");
  });
  it("refOfUrl", () => { expect(refOfUrl(`https://${ISO}.supabase.co/`)).toBe(ISO); expect(refOfUrl("http://127.0.0.1:3203")).toBeNull(); });
});
