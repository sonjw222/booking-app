/*
  lib/authAccount.ts의 isSocialProvider 순수 predicate 단위 테스트. 구글/애플은
  signInWithOAuth를 그대로 쓰므로 app_metadata.provider가 실제 provider 이름으로 들어오고,
  카카오/네이버는 매직링크로 세션을 받아 app_metadata.provider가 "email"로 남기 때문에
  user_metadata.provider를 대신 본다(2026-09-01 실사용자 계정에서 확인된 버그의 회귀 방지).
*/
import { describe, expect, it } from "vitest";
import { isSocialProvider } from "../../lib/authAccount";

describe("isSocialProvider", () => {
  it("이메일 가입은 소셜이 아니다", () => {
    expect(isSocialProvider({ app_metadata: { provider: "email" } })).toBe(false);
  });
  it("구글은 app_metadata.provider로 판정된다", () => {
    expect(isSocialProvider({ app_metadata: { provider: "google" } })).toBe(true);
  });
  it("애플은 app_metadata.provider로 판정된다(구글과 동일한 signInWithOAuth 경로)", () => {
    expect(isSocialProvider({ app_metadata: { provider: "apple" } })).toBe(true);
  });
  it("카카오는 app_metadata.provider가 email로 남아도 user_metadata.provider로 판정된다", () => {
    expect(isSocialProvider({ app_metadata: { provider: "email" }, user_metadata: { provider: "kakao" } })).toBe(true);
  });
  it("네이버는 app_metadata.provider가 email로 남아도 user_metadata.provider로 판정된다", () => {
    expect(isSocialProvider({ app_metadata: { provider: "email" }, user_metadata: { provider: "naver" } })).toBe(true);
  });
  it("app_metadata 자체가 없으면(방어적 케이스) 소셜이 아니다", () => {
    expect(isSocialProvider({})).toBe(false);
  });
});
