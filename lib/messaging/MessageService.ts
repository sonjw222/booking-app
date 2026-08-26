/*
  MessageService - 호출부가 실제로 쓰는 단일 진입점.
  구체 Provider(Mock/AlimtalkSms/...)를 절대 직접 참조하지 않고, 생성자로 주입받은
  MessageProvider 인터페이스로만 접근한다(DIP, lib/payments/PaymentService와 동일 구조).
*/

import type { MessageProvider, SendMessageInput, SendMessageResult } from "./types";

export class MessageService {
  constructor(private readonly provider: MessageProvider) {}

  send(input: SendMessageInput): Promise<SendMessageResult> {
    return this.provider.send(input);
  }
}
