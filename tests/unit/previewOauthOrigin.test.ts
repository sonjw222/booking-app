/*
  Issue #198: Preview 소셜 로그인 도메인 유지 회귀 테스트.
  모든 소셜 로그인 redirect는 하드코딩된 운영 도메인이 아니라 현재 origin에서 계산돼야 하고,
  카카오·네이버는 state(OAuth CSRF)를 저장/검증해야 하며, post-login next는 Open Redirect를 막아야 한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeNextPath } from "../../lib/postLoginReturn";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

describe("소셜 로그인 redirect는 현재 origin 기반(운영 도메인 하드코딩 금지)", () => {
  it("로그인 페이지의 signInWithOAuth redirectTo는 window.location.origin", () => {
    const c = read("app/login/page.tsx");
    expect(c).toContain("redirectTo: `${window.location.origin}/`");
    expect(c).not.toMatch(/redirectTo:\s*["'`]https?:\/\/mwhabit\.com/);
  });

  it("카카오/네이버 authorize redirect_uri와 콜백의 redirectUri는 window.location.origin", () => {
    expect(read("lib/kakaoAuth.ts")).toContain("`${window.location.origin}/login/kakao-callback`");
    expect(read("lib/naverAuth.ts")).toContain("`${window.location.origin}/login/naver-callback`");
    expect(read("app/login/kakao-callback/page.tsx")).toContain("redirectUri: `${window.location.origin}/login/kakao-callback`");
    expect(read("app/login/naver-callback/page.tsx")).toContain("redirectUri: `${window.location.origin}/login/naver-callback`");
  });

  it("로그인 관련 파일에 mwhabit.com 하드코딩이 없다", () => {
    for (const f of ["app/login/page.tsx", "lib/kakaoAuth.ts", "lib/naverAuth.ts", "app/login/kakao-callback/page.tsx", "app/login/naver-callback/page.tsx"]) {
      expect(read(f), f).not.toContain("mwhabit.com");
    }
  });
});

describe("OAuth CSRF(state) 유지", () => {
  it.each([
    ["kakao", "KAKAO_OAUTH_STATE_KEY", "lib/kakaoAuth.ts", "app/login/kakao-callback/page.tsx"],
    ["naver", "NAVER_OAUTH_STATE_KEY", "lib/naverAuth.ts", "app/login/naver-callback/page.tsx"],
  ])("%s: 시작 시 randomUUID state 저장, 콜백에서 불일치/누락이면 거부", (_n, key, lib, cb) => {
    const l = read(lib);
    expect(l).toContain("crypto.randomUUID()");
    expect(l).toContain(`sessionStorage.setItem(${key}, state)`);
    expect(read(cb)).toContain("state !== savedState");
  });
});

describe("Open Redirect 방어 유지", () => {
  it("외부/프로토콜 상대/백슬래시/인코딩 변형 next는 거부, 내부 경로는 허용", () => {
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "/%2F%2Fevil.com", "/%5Cevil.com", "/\t/evil.com"]) {
      expect(sanitizeNextPath(bad), bad).toBeNull();
    }
    expect(sanitizeNextPath("/checkout?center=a&product=b")).toBe("/checkout?center=a&product=b");
  });
});
