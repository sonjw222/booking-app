import { describe, expect, it } from "vitest";
// @ts-expect-error mjs 모듈
import { checkCiDevEnv, REQUIRED_SECRET_NAMES } from "../../scripts/ci-dev/requiredEnv.mjs";

const full = (over: Record<string, string> = {}) => {
  const e: Record<string, string> = { NEXT_PUBLIC_SUPABASE_URL: "https://devproj123.supabase.co" };
  for (const n of REQUIRED_SECRET_NAMES) e[n] ??= "x";
  return { ...e, ...over };
};
describe("ci-dev env guard", () => {
  it("비-production + 전부 존재 → ok", () => expect(checkCiDevEnv(full()).ok).toBe(true));
  it("Production URL → 거부", () => expect(checkCiDevEnv(full({ NEXT_PUBLIC_SUPABASE_URL: "https://bxntqggkfwnhcczsbqtj.supabase.co" })).ok).toBe(false));
  it("필수 이름 누락 → 이름만 보고(값 없음)", () => {
    const r = checkCiDevEnv(full({ TEST_CENTER_ID: "" }));
    expect(r.problems).toContain("TEST_CENTER_ID 누락");
  });
  it("seed 진입점은 assertSeedAllowed(네트워크 이전)를 먼저 호출하고, verify/secret-map은 변경 호출이 없다", async () => {
    const { readFileSync } = await import("node:fs");
    const seed = readFileSync("scripts/ci-dev/seed.mjs", "utf8");
    expect(seed.indexOf("assertSeedAllowed(env)")).toBeLessThan(seed.indexOf("ensureFixtures("));
    expect(readFileSync("scripts/ci-dev/lib.mjs", "utf8")).toContain('CI_DEV_SEED_ACK !== "1"');
    expect(readFileSync("scripts/ci-dev/verify.mjs", "utf8")).not.toMatch(/method:\s*"(POST|PATCH|DELETE|PUT)"/);
  });
});
