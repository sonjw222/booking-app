// Supabase Edge Function: 알림톡(카카오 알림톡) 발송
//
// 플랫폼(sonjw) 단일 알리고 계정으로 전 센터를 대행 발송한다(사용자 결정, 2026-09-01) — 센터
// 운영자는 각자 사업자 인증·알리고 가입을 할 필요가 없고, 승인된 발신프로필(카카오 채널)과
// 템플릿만 이 플랫폼 계정 아래 등록해서 쓴다. API 키는 여기서만 쓰고 브라우저에는 절대
// 노출하지 않는다(CLAUDE.md 5번 규칙) — lib/messaging/AlimtalkSmsProvider.ts가 클라이언트에서
// 이 함수를 supabase.functions.invoke()로 호출하는 구조.
//
// 두 가지 호출 경로:
//   1) 매니저 화면(즉시 발송) — { to, content, channel:"alimtalk", templateCode?, templateVariables? }
//      본인 세션 JWT로 호출. 발송 결과만 바로 응답, DB에 기록 안 함(즉시 발송은 이력 없음 —
//      사용자 결정. 발송 여부는 카카오톡/문자함에서 직접 확인).
//   2) add_notification_rule_evaluators.sql이 등록한 pg_cron("dispatch-alimtalk")이
//      { messageId } 로 호출 — service_role 키로 인증(비대화형, 큐 디스패치). messages 테이블에서
//      해당 행을 읽어 대상 전원에게 발송하고 status/sent_at 갱신 + notification_logs에 건당
//      비용 기록(정산 근거).
//
// 인증: Authorization 헤더의 JWT가 실제 로그인 사용자(경로 1)면 그 계정이 대상 센터의 활성
//   매니저인지 확인(add_alimtalk_integration.sql의 RLS와 동일하게 센터소속 여부만 확인 —
//   화면단 메뉴 노출은 message.alimtalk.view 권한으로 이미 가려져 있음). service_role 키(경로 2,
//   dispatch-alimtalk cron만 앎)면 내부 호출로 신뢰한다.
//
// 필요한 Edge Function 환경변수(`supabase secrets set`으로 등록, 코드/DB에 저장 안 함):
//   ALIGO_USER_ID, ALIGO_API_KEY       — 알리고 가입 후 발급
//   ALIGO_SENDER_KEY                   — 카카오 알림톡 발신프로필 키(카카오 채널 연결 후 발급)
//   ALIGO_SENDER_PHONE                 — SMS 대체발송용 발신번호(사전 등록된 번호)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY — Supabase가 기본 주입
//
// 알리고 실발송 로직(sendViaAligo)은 ../_shared/aligo.ts로 옮겨졌다 — send-phone-otp(휴대폰
// 인증번호 발송, 2026-09-05)도 같은 로직을 쓰기 때문(로그인 전 호출이라 이 함수의
// isAuthorizedCaller 권한 모델과는 다른 별도 함수로 분리, Aligo 호출 부분만 공유).
//
// 배포: `supabase functions deploy send-alimtalk`

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendViaAligo, isAligoConfigured } from "../_shared/aligo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// 호출자가 실제 로그인 사용자면 대상 센터의 활성 매니저인지 확인. service_role 호출(cron)이면 통과.
async function isAuthorizedCaller(authHeader: string | null, centerId: string): Promise<boolean> {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token === SERVICE_ROLE_KEY) return true; // dispatch-alimtalk cron (신뢰된 내부 호출)

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) return false;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: account } = await admin
    .from("accounts")
    .select("id, is_platform_admin")
    .eq("auth_id", authData.user.id)
    .maybeSingle();
  if (!account) return false;
  if (account.is_platform_admin) return true;

  const { data: mc } = await admin
    .from("manager_centers")
    .select("id")
    .eq("account_id", account.id)
    .eq("center_id", centerId)
    .eq("status", "active")
    .maybeSingle();
  return !!mc;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: {
    action?: string;
    messageId?: string;
    to?: string;
    content?: string;
    templateCode?: string;
    templateVariables?: Record<string, string>;
    centerId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "요청 본문을 읽을 수 없어요" }, 400);
  }

  // 발신 설정 화면(app/manager/alimtalk/settings)의 연결 상태 조회 — 로그인만 하면 누구나
  // 물어볼 수 있게 열어둠(true/false만 응답, 키 값 자체는 절대 노출 안 함).
  if (body.action === "status") {
    return json({ connected: isAligoConfigured() });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 경로 2: 큐 디스패치(dispatch-alimtalk cron) — messages 행을 읽어 대상 전원 발송
  if (body.messageId) {
    if (!(await isAuthorizedCaller(req.headers.get("Authorization"), ""))) {
      // messageId 경로는 항상 service_role(cron)로만 호출되므로 centerId 없이도 판정 가능
      return json({ error: "권한이 없어요" }, 403);
    }

    const { data: msg, error: msgErr } = await admin
      .from("messages")
      .select("id, center_id, content, target_profile_ids, status")
      .eq("id", body.messageId)
      .maybeSingle();
    if (msgErr || !msg) return json({ error: "메시지를 찾을 수 없어요" }, 404);
    if (msg.status !== "scheduled") return json({ processed: 0, skipped: "already-handled" });

    const { data: profiles } = await admin
      .from("profiles")
      .select("id, name, accounts(phone)")
      .in("id", msg.target_profile_ids);

    let sent = 0;
    let failed = 0;
    for (const p of profiles ?? []) {
      const phone = (p as unknown as { accounts?: { phone?: string | null } }).accounts?.phone;
      if (!phone) { failed++; continue; }
      const result = await sendViaAligo({ to: phone, content: msg.content });
      await admin.from("notification_logs").insert({
        center_id: msg.center_id,
        profile_id: p.id,
        channel: "alimtalk",
        cost: result.status === "sent" ? 9 : 0, // 알림톡 건당 단가(원) — 실제 알리고 단가 확정 후 조정
        status: result.status,
      });
      if (result.status === "sent") sent++; else failed++;
    }

    await admin
      .from("messages")
      .update({ status: failed > 0 && sent === 0 ? "failed" : "sent", sent_at: new Date().toISOString() })
      .eq("id", msg.id);

    return json({ processed: (profiles ?? []).length, sent, failed });
  }

  // 경로 1: 즉시 발송 — 매니저 화면에서 직접 호출
  if (!body.to || !body.content || !body.centerId) {
    return json({ error: "to, content, centerId가 필요해요" }, 400);
  }
  if (!(await isAuthorizedCaller(req.headers.get("Authorization"), body.centerId))) {
    return json({ error: "이 센터에 대한 발송 권한이 없어요" }, 403);
  }

  const result = await sendViaAligo({
    to: body.to,
    content: body.content,
    templateCode: body.templateCode,
    templateVariables: body.templateVariables,
  });
  return json(result, result.status === "sent" ? 200 : 502);
});
