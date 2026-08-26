/*
  MessageProviderFactory가 NEXT_PUBLIC_MESSAGE_PROVIDER 값에 따라
  올바른 구현체를 반환하는지만 검증한다(각 Provider의 실제 동작은 별개로 테스트됨).
*/
import { afterEach, describe, expect, it } from "vitest";
import { getMessageProvider } from "../../lib/messaging/MessageProviderFactory";
import { MockMessageProvider } from "../../lib/messaging/MockMessageProvider";
import { AlimtalkSmsProvider } from "../../lib/messaging/AlimtalkSmsProvider";

const ORIGINAL = process.env.NEXT_PUBLIC_MESSAGE_PROVIDER;

afterEach(() => {
  process.env.NEXT_PUBLIC_MESSAGE_PROVIDER = ORIGINAL;
});

describe("getMessageProvider", () => {
  it("환경변수가 없으면 MockMessageProvider를 반환한다(기본값)", () => {
    delete process.env.NEXT_PUBLIC_MESSAGE_PROVIDER;
    expect(getMessageProvider()).toBeInstanceOf(MockMessageProvider);
  });

  it("NEXT_PUBLIC_MESSAGE_PROVIDER=mock이면 MockMessageProvider를 반환한다", () => {
    process.env.NEXT_PUBLIC_MESSAGE_PROVIDER = "mock";
    expect(getMessageProvider()).toBeInstanceOf(MockMessageProvider);
  });

  it("NEXT_PUBLIC_MESSAGE_PROVIDER=alimtalk이면 AlimtalkSmsProvider를 반환한다", () => {
    process.env.NEXT_PUBLIC_MESSAGE_PROVIDER = "alimtalk";
    expect(getMessageProvider()).toBeInstanceOf(AlimtalkSmsProvider);
  });

  it("알 수 없는 값이면 안전하게 MockMessageProvider로 폴백한다", () => {
    process.env.NEXT_PUBLIC_MESSAGE_PROVIDER = "unknown-provider";
    expect(getMessageProvider()).toBeInstanceOf(MockMessageProvider);
  });
});
