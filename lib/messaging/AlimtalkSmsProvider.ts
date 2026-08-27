/*
  AlimtalkSmsProvider - 구조만 준비 (벤더 미확정, 실제 구현하지 않음)

  실제 벤더(알리고/NHN Cloud/Solapi 등) 확정 후 채워야 할 것:
  - 발신프로필(카카오 채널) 등록 — 벤더 콘솔에서 사업자 인증 + 카카오 채널 연결 필요
  - 알림톡 메시지 템플릿 사전 등록 후 카카오 승인 대기(수 영업일 소요) — 승인 전에는
    발송 자체가 불가능하므로, MessageProvider.send()에 넘길 templateCode는 승인된
    템플릿 코드여야 한다
  - 생성자에서 벤더 API 키/시크릿을 env에서 읽음(서버 전용 값 — 결제와 마찬가지로
    이 프로젝트가 app/api 서버 라우트 없이 100% 클라이언트 컴포넌트 구조라면, 문자
    발송처럼 시크릿이 필요한 호출은 클라이언트에서 직접 하면 안 되고 서버 라우트나
    Edge Function을 거쳐야 한다 — lib/webPush.ts가 이미 이 구조로 되어 있으니 참고)
  - send(): 벤더 발송 API 호출 — channel='alimtalk'이면 템플릿 발송 시도 후 실패 시
    content(SMS 대체발송 본문)로 자동 폴백하는 벤더 옵션을 켜는 것이 일반적
  - 발송 결과 콜백(수신 성공/실패) 처리 — 대부분 벤더가 비동기 웹훅으로 결과를 알려줌
  - 발송 비용을 실제 벤더 단가로 계산해 SendMessageResult.cost에 반영
  - notification_logs에 발송 기록을 남기는 저장 로직(RLS/권한 설계 이후, 이번 범위 밖)
*/

import type { MessageProvider, SendMessageInput, SendMessageResult } from "./types";

export class AlimtalkSmsProvider implements MessageProvider {
  async send(_input: SendMessageInput): Promise<SendMessageResult> {
    throw new Error("AlimtalkSmsProvider는 아직 구현되지 않았어요 (벤더 미확정)");
  }
}
