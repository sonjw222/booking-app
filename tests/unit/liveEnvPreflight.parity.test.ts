// @ts-expect-error — 순수 JS(.mjs) 모듈
import { checkLiveEnv, productionRefInUrl, projectRefFromSupabaseKey } from "../../scripts/ci/liveEnvPreflight.mjs";
import { describe, expect, it } from "vitest";
import { assertIntegrationTargetIsNotProduction, productionRefInUrl as tsRefInUrl, projectRefFromSupabaseKey as tsRefFromKey } from "../integration/productionGuard";

const PROD = "bxntqggkfwnhcczsbqtj";
const jwt = (payload: object) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const CASES: Record<string, string>[] = [
  { NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` }, { NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co/` }, { NEXT_PUBLIC_SUPABASE_URL: `HTTPS://${PROD.toUpperCase()}.SUPABASE.CO` },
  { NEXT_PUBLIC_SUPABASE_URL: `user:pw@${PROD}.supabase.co:443/x` }, { NEXT_PUBLIC_SUPABASE_URL: `http://[${PROD}` }, { NEXT_PUBLIC_SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co" },
  { NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: PROD }) }, { NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ ref: "aaaaaaaaaaaaaaaaaaaa" }) },
  { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", PRODUCTION_SUPABASE_URL: "https://x.supabase.co/" }, { SUPABASE_URL: `https://${PROD}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co" },
  { NEXT_PUBLIC_SUPABASE_URL: "%%%", SUPABASE_SERVICE_ROLE_KEY: "###.###.###" }, { NEXT_PUBLIC_SUPABASE_URL: "" }, {},
];
describe("live-env preflight(JS) ↔ productionGuard(TS) parity", () => {
  it("Production 판정(= 차단 여부)이 모든 입력에서 같다(URL이 빈 경우만 preflight가 추가로 실패)", () => {
    for (const env of CASES) {
      let tsBlocks = false; try { assertIntegrationTargetIsNotProduction(env); } catch { tsBlocks = true; }
      const r = checkLiveEnv(env);
      const prodProblems = r.problems.filter((p: string) => !p.includes("비어 있어"));
      expect(prodProblems.length > 0, JSON.stringify(Object.keys(env)) + " " + (env.NEXT_PUBLIC_SUPABASE_URL ?? "")).toBe(tsBlocks);
    }
  });
  it("보조 함수도 같은 결과, 출력 문자열에 URL/키 원문이 들어가지 않는다", () => {
    for (const v of [`https://${PROD}.supabase.co`, `x${PROD}y`, "https://other.supabase.co", "", undefined]) expect(productionRefInUrl(v)).toBe(tsRefInUrl(v as never));
    for (const k of [jwt({ ref: PROD }), "a.b", "", undefined]) expect(projectRefFromSupabaseKey(k)).toBe(tsRefFromKey(k as never));
    const r = checkLiveEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: PROD }) });
    expect(r.ok).toBe(false); expect(JSON.stringify(r.problems)).not.toContain("https://"); expect(JSON.stringify(r.problems)).not.toContain(jwt({ ref: PROD }));
  });
  it("정상 dev 값이면 ok", () => { expect(checkLiveEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc" }).ok).toBe(true); });
});
