/*
  MessageProviderFactory - MessageService가 구체 Provider를 직접 생성하지 않도록
  선택/조립 책임을 전담하는 곳 (DIP 유지의 핵심, lib/payments/PaymentProviderFactory와
  동일한 구조)

  NEXT_PUBLIC_MESSAGE_PROVIDER 값만 바꾸면 mock → alimtalk 전환. 벤더가 늘어나면
  이 파일에 case만 추가하면 된다(호출부는 변경 불필요).
*/

import type { MessageProvider } from "./types";
import { MockMessageProvider } from "./MockMessageProvider";
import { AlimtalkSmsProvider } from "./AlimtalkSmsProvider";

export type MessageProviderName = "mock" | "alimtalk";

function resolveProviderName(): MessageProviderName {
  const raw = process.env.NEXT_PUBLIC_MESSAGE_PROVIDER;
  if (raw === "alimtalk") return raw;
  return "mock";
}

export function getMessageProvider(): MessageProvider {
  const name = resolveProviderName();
  switch (name) {
    case "alimtalk":
      return new AlimtalkSmsProvider();
    case "mock":
    default:
      return new MockMessageProvider();
  }
}
