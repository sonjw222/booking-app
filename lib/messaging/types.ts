/*
  Message Adapter Pattern - 공용 타입 + Provider 인터페이스
  (lib/payments의 Payment Adapter Pattern과 동일한 구조를 그대로 따름)

  이 파일만 보고도 Provider를 하나 새로 만들 수 있어야 한다.
  MessageService/호출부는 이 인터페이스만 알고, 구체 구현(Mock/실제 벤더)은 모른다(DIP).

  카카오 알림톡/SMS는 결제(Toss)와 달리 "발신프로필 등록 + 메시지 템플릿 사전 심사(카카오
  승인)"가 필요해 벤더가 정해지고 심사가 끝나야 실제 연동이 가능하다 — 그 전까지는 이
  구조(인터페이스 + Mock + 벤더 자리만 잡아둔 스텁)만 준비해둔다(사용자 결정, 2026-08-26).
  이메일은 이번 범위 밖(사용자 결정).
*/

// ⚠ schema.sql의 messages.channel CHECK 제약은 실제로 'sms' | 'lms' | 'push' 3개뿐이고
// 'alimtalk'은 없다(schema.sql 13-8절 실측 확인, 2026-08-26). push는 이미 lib/webPush.ts +
// push_subscriptions 테이블로 완전히 별개 구현(pg_cron이 호출하는 Edge Function)이 있어
// 이 어댑터의 관심사가 아니므로 제외한다. 'alimtalk'은 발송 채널로서는 이 어댑터가 다뤄야
// 하지만 messages 테이블에 그대로 저장할 값은 아니다 — 이 타입은 "무엇으로 보낼지"를
// 표현하는 요청 채널이고, 실제 DB 영속화(이번 배치 범위 밖, Mock도 DB에 안 씀)를 구현할
// 때는 alimtalk 발송을 messages.channel='sms'로 기록(SendMessageInput.content가 이미
// 알림톡 실패 시 대체발송용 SMS 본문을 겸하도록 설계됨)하거나, 'alimtalk'을 새 허용값으로
// 추가하는 별도 SQL migration이 필요하다 — 어느 쪽이든 벤더 확정 후 결정할 사안.
export type MessageChannel = "sms" | "lms" | "alimtalk";

export type SendMessageInput = {
  to: string; // 수신 전화번호
  content: string; // SMS/LMS 본문, 알림톡이면 알림톡 실패 시 대체발송(SMS)용 본문
  channel: MessageChannel;
  // 알림톡 전용 — 카카오에 사전 등록·승인된 템플릿 코드와 치환 변수
  templateCode?: string;
  templateVariables?: Record<string, string>;
};

export type SendMessageResult = {
  status: "sent" | "failed";
  providerMessageId?: string; // 벤더가 반환하는 자체 발송 식별자
  cost?: number; // 건당 비용(원) — notification_logs.cost와 대응
  message?: string;
};

// 호출부(향후 알림 규칙 스케줄러/수동 발송 화면)는 이 인터페이스만 참조한다.
// 실제 벤더(알리고/NHN Cloud/Solapi 등)로 교체해도 이 계약(메서드 1개)은 그대로 유지된다.
export interface MessageProvider {
  send(input: SendMessageInput): Promise<SendMessageResult>;
}
