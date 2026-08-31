/*
  로그인 후 원래 화면으로 돌아가는 lib/postLoginReturn.ts 회귀 테스트.
  핵심은 오픈 리다이렉트 방지 — "/login?next=https://evil.com" 같은 외부 주소로
  절대 리다이렉트되면 안 된다.
*/
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumePostLoginNext, stashPostLoginNext } from "../../lib/postLoginReturn";

beforeEach(() => {
  (globalThis as any).sessionStorage = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
  })();
});

afterEach(() => {
  delete (globalThis as any).sessionStorage;
});

describe("stashPostLoginNext / consumePostLoginNext", () => {
  it("내부 상대경로는 저장됐다가 한 번만 꺼내진다", () => {
    stashPostLoginNext("/checkout?center=1&product=2");
    expect(consumePostLoginNext()).toBe("/checkout?center=1&product=2");
    expect(consumePostLoginNext()).toBeNull(); // 소비 후엔 비워짐
  });

  it("외부 절대 URL은 저장하지 않는다(오픈 리다이렉트 방지)", () => {
    stashPostLoginNext("https://evil.com/phishing");
    expect(consumePostLoginNext()).toBeNull();
  });

  it("프로토콜 상대 URL(//evil.com)도 저장하지 않는다", () => {
    stashPostLoginNext("//evil.com");
    expect(consumePostLoginNext()).toBeNull();
  });

  it("null/undefined/빈 문자열은 조용히 무시한다", () => {
    stashPostLoginNext(null);
    stashPostLoginNext(undefined);
    stashPostLoginNext("");
    expect(consumePostLoginNext()).toBeNull();
  });
});
