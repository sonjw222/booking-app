import { describe, expect, it } from "vitest";
import { sanitizeNextPath } from "../../lib/postLoginReturn";

describe("sanitizeNextPath — 로그인 후 이동 대상 검증", () => {
  it("정상 내부 경로는 그대로 허용", () => {
    for (const ok of [
      "/checkout?center=11111111-1111-1111-1111-111111111111&product=22222222-2222-2222-2222-222222222222",
      "/reservation?openClassId=abc&openDate=2026-10-09", "/", "/center/abc?buy=1", "/mypage#profile", "/search?q=%ED%95%84%EB%9D%BC%ED%85%8C%EC%8A%A4",
    ]) expect(sanitizeNextPath(ok), ok).toBe(ok);
  });
  it("프로토콜 상대/절대 외부 URL 차단", () => {
    for (const bad of ["//evil.com", "//evil.com/path", "https://evil.com", "http://evil.com", "javascript:alert(1)", "data:text/html,x", "evil.com", ""]) expect(sanitizeNextPath(bad), bad).toBeNull();
  });
  it("백슬래시 변형 차단", () => {
    for (const bad of ["/\\evil.com", "/\\\\evil.com", "/path\\..\\evil", "\\evil.com"]) expect(sanitizeNextPath(bad), bad).toBeNull();
  });
  it("탭/개행/제어문자 변형 차단", () => {
    for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\u0000/evil.com", "/ok\u0007", "/ /evil.com"]) expect(sanitizeNextPath(bad), JSON.stringify(bad)).toBeNull();
  });
  it("인코딩 변형 차단(1~2회 디코드해도 외부/프로토콜 상대/백슬래시가 되면 거부)", () => {
    for (const bad of ["/%2F%2Fevil.com", "/%2f%2fevil.com", "/%5Cevil.com", "/%5cevil.com", "/%252F%252Fevil.com", "/%255Cevil.com", "/%09/evil.com", "/%0a/evil.com", "/%E0%A4%A"]) expect(sanitizeNextPath(bad), bad).toBeNull();
  });
  it("null/undefined/비문자열/너무 긴 값은 null", () => {
    expect(sanitizeNextPath(null)).toBeNull(); expect(sanitizeNextPath(undefined)).toBeNull();
    expect(sanitizeNextPath("/" + "a".repeat(2100))).toBeNull();
    expect(sanitizeNextPath(123 as unknown as string)).toBeNull();
  });
  it("저장(stash)과 소비(consume) 양쪽에서 검증한다", async () => {
    const store = new Map<string, string>();
    (globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const m = await import("../../lib/postLoginReturn");
    m.stashPostLoginNext("/\\evil.com"); expect(m.consumePostLoginNext()).toBeNull();
    m.stashPostLoginNext("/checkout?x=1"); expect(m.consumePostLoginNext()).toBe("/checkout?x=1");
    store.set("post_login_next", "https://evil.com");   // 저장소가 오염돼 있어도 이동 직전에 차단
    expect(m.consumePostLoginNext()).toBeNull();
  });
});
