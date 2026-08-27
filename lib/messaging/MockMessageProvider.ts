/*
  MockMessageProvider - 개발 중 실제 동작하는 발송 시뮬레이터
  - DB에는 아직 쓰지 않는다(messages/notification_logs RLS·권한 설계 미완료, 이번 범위 밖) —
    콘솔 로그 + 가짜 성공 응답만 반환한다.
  - 과금 프리뷰는 schema.sql의 messages 테이블 주석("SMS 건당 12P/90byte, LMS 건당
    37P/2000byte")을 그대로 흉내낸다 — 실측 벤더 단가가 아니라 이 프로젝트 문서에 이미
    적혀 있던 근사치다. 실제 단가는 벤더 확정 후 그 벤더의 요금표로 교체해야 한다.
  - 알림톡(alimtalk)은 아직 실제 채널 값이 없어(types.ts 주석 참고) SMS와 동일한 바이트
    기준으로만 흉내낸다.
*/

import type { MessageProvider, SendMessageInput, SendMessageResult } from "./types";

const SMS_MAX_BYTES = 90;
const SMS_COST = 12;
const LMS_COST = 37;

function estimateCost(content: string, channel: SendMessageInput["channel"]): number {
  // 대략적인 바이트 계산(한글은 보통 2~3byte) — 정확한 과금은 벤더 API 응답을 따른다.
  const byteLength = new TextEncoder().encode(content).length;
  if (channel === "lms") return LMS_COST;
  // sms/alimtalk: 90byte 넘으면 실제로는 LMS로 자동 전환되는 벤더가 많음 — Mock도 흉내냄
  return byteLength > SMS_MAX_BYTES ? LMS_COST : SMS_COST;
}

export class MockMessageProvider implements MessageProvider {
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const cost = estimateCost(input.content, input.channel);
    console.log("(Mock) 메시지 발송", {
      to: input.to,
      channel: input.channel,
      templateCode: input.templateCode,
      contentPreview: input.content.slice(0, 30),
      estimatedCost: cost,
    });
    return {
      status: "sent",
      providerMessageId: `mock_${input.channel}_${crypto.randomUUID()}`,
      cost,
      message: "(Mock) 발송을 시뮬레이션했어요. 실제로 전송되지 않았어요.",
    };
  }
}
