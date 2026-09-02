/*
  AlimtalkSmsProvider - 실제 발송 (supabase/functions/send-alimtalk 경유)

  API 키·발신프로필 키 같은 비밀값은 여기(브라우저에서 실행되는 코드)에 절대 두지 않는다 —
  Edge Function(supabase/functions/send-alimtalk)이 시크릿을 갖고 있고, 이 클래스는 그 함수를
  supabase.functions.invoke()로 호출만 한다(payments 결제 흐름과 동일하게 시크릿이 필요한
  호출은 서버 쪽에서만).

  카카오 알림톡은 사전 승인된 템플릿(templateCode)만 자유 발송이 가능하다 — templateCode 없이
  호출하면 Edge Function이 SMS로 바로 보낸다(문자 요금 발생, 알림톡 아님). 자동 발송 규칙은
  add_notification_rule_evaluators.sql이 이미 승인된 템플릿만 골라 큐잉하므로 이 문제가 없지만,
  회원탭/알림톡 메뉴의 "즉시 발송"은 매니저가 템플릿 없이 자유 문장을 보낼 수도 있어서(그때는
  SMS로 나감) 화면 쪽에서 이 사실을 안내해야 한다(app/manager/alimtalk/send).
*/

import { supabase } from "../supabaseClient";
import type { MessageProvider, SendMessageInput, SendMessageResult } from "./types";

export class AlimtalkSmsProvider implements MessageProvider {
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (!input.centerId) {
      return { status: "failed", message: "발송 권한 확인에 필요한 센터 정보가 없어요" };
    }

    const { data, error } = await supabase.functions.invoke<{
      status: "sent" | "failed";
      providerMessageId?: string;
      message?: string;
    }>("send-alimtalk", {
      body: {
        to: input.to,
        content: input.content,
        centerId: input.centerId,
        templateCode: input.templateCode,
        templateVariables: input.templateVariables,
      },
    });

    if (error || !data) {
      return { status: "failed", message: error?.message ?? "발송 요청에 실패했어요" };
    }
    return data;
  }
}
