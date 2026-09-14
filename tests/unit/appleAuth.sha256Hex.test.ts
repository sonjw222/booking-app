/*
  lib/appleAuth.ts의 sha256Hex() 단위 테스트. Apple Sign In의 nonce 처리는 원본을 JS가
  만들고 SHA-256 해시만 Apple에 보내야 하는 공식 요구사항이라(Apple/Supabase 공식 문서),
  이 해시 함수가 틀리면 "Apple에 보낸 해시"와 "Supabase에 보낼 원본"이 어긋나
  signInWithIdToken()이 항상 실패한다 — 알려진 SHA-256 테스트 벡터로 정확성을 고정한다.
*/
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/appleAuth";

describe("sha256Hex", () => {
  it("빈 문자열의 SHA-256 (표준 테스트 벡터)", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("\"abc\"의 SHA-256 (NIST 표준 테스트 벡터)", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("같은 입력은 항상 같은 해시를 낸다(결정적)", async () => {
    const a = await sha256Hex("mwhabit-nonce-test");
    const b = await sha256Hex("mwhabit-nonce-test");
    expect(a).toBe(b);
  });

  it("다른 입력은 다른 해시를 낸다", async () => {
    const a = await sha256Hex("nonce-1");
    const b = await sha256Hex("nonce-2");
    expect(a).not.toBe(b);
  });

  it("결과는 64자 소문자 16진수 문자열이다", async () => {
    const hash = await sha256Hex("mwhabit");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
