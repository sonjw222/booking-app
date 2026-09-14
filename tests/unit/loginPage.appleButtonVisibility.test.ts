/*
  Android UX 정리(2026-09-14) — Apple 버튼만 조건부로 숨기고 Google/Kakao/Naver는 그대로
  둬야 한다(로그인/회원가입 두 모드가 공유하는 같은 .social-list 블록 하나뿐이라 한 곳만
  확인하면 양쪽 다 커버됨). 소스 구조를 직접 확인해 회귀를 막는다 — 이 프로젝트엔 컴포넌트
  렌더링 테스트 도구가 없어(@testing-library/react 등) 순수 로직/소스 구조 확인 방식을
  그대로 재사용한다(tests/unit/appleAuth.noOAuthFallback.test.ts와 동일 패턴).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/login/page.tsx"), "utf-8");

describe("app/login/page.tsx — Apple 버튼 노출 정책", () => {
  it("Apple 버튼은 showAppleButton && (...)로 감싸져 있다(조건부 렌더링)", () => {
    const idx = source.indexOf('className="social-btn apple"');
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 100), idx);
    expect(before).toContain("showAppleButton && (");
  });

  it("showAppleButton은 isAppleNativeSignInSupported()로만 결정된다(새 web OAuth 경로 없음)", () => {
    expect(source).toContain("setShowAppleButton(isAppleNativeSignInSupported())");
  });

  it("Google/Kakao/Naver 버튼은 조건부 렌더링으로 감싸져 있지 않다(항상 노출)", () => {
    for (const cls of ["social-btn google", "social-btn kakao", "social-btn naver"]) {
      const idx = source.indexOf(`className="${cls}"`);
      expect(idx).toBeGreaterThan(-1);
      const before = source.slice(Math.max(0, idx - 40), idx);
      expect(before).not.toContain("&&");
    }
  });

  it("Apple 네이티브 로그인 호출부(signInWithAppleNative)는 그대로 남아있다(제거 금지 확인)", () => {
    expect(source).toContain("signInWithAppleNative");
    expect(source).toContain('if (provider === "apple")');
  });
});
