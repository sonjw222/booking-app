// Supabase Edge Function: 웹 푸시 발송 (P1-3 일부)
//
// add_web_push.sql이 등록한 pg_cron 작업("dispatch-web-push")이 1분마다 이 함수를
// 호출한다(요청 본문 없음, service_role 키로 인증). 이 함수는:
//   1) notifications 테이블에서 아직 웹 푸시로 내보내지 않은 행(pushed_at is null)을 찾고
//   2) 각 수신자(recipient_account_id)의 push_subscriptions을 조회해
//   3) VAPID로 서명한 Web Push 메시지를 브라우저 푸시 서비스(FCM/Mozilla 등)로 보낸다
//   4) 구독이 만료/취소됐으면(404/410) 그 구독 행을 지운다(다음에 다시 시도하지 않도록)
//   5) 처리한 알림은 성공/실패 여부와 무관하게 pushed_at을 채운다(재시도 없음 — 최선 노력
//      전달. 실패해도 알림함(/notifications)에는 이미 기록이 남아 있어 앱을 열면 확인 가능)
//
// 이미 로그인/화면을 보고 있는 사용자에게는 실시간 팝업(NotificationToaster, Realtime
// 구독)이 따로 동작하므로, 이 웹 푸시는 "앱을 안 보고 있을 때"를 위한 보완 채널이다.
//
// 필요한 환경변수(add_web_push.sql 상단 안내 참고, `supabase secrets set`으로 등록):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Edge Function에 기본 주입되거나 프로젝트 설정에서 확인
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY     — `npx web-push generate-vapid-keys`로 생성
//   VAPID_SUBJECT                            — 예: mailto:admin@example.com (푸시 서비스가 발신자
//                                               확인용으로 요구, 실제 발송에는 영향 없음)
// 배포: `supabase functions deploy send-web-push`

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";

const BATCH_SIZE = 200;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST만 지원합니다" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: pending, error: pendingErr } = await admin
    .from("notifications")
    .select("id, recipient_account_id, kind, title, body, link")
    .is("pushed_at", null)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (pendingErr) return json({ error: pendingErr.message }, 500);
  if (!pending || pending.length === 0) return json({ processed: 0, sent: 0 });

  const accountIds = [...new Set(pending.map((n) => n.recipient_account_id))];
  const { data: subs, error: subsErr } = await admin
    .from("push_subscriptions")
    .select("id, account_id, endpoint, p256dh, auth")
    .in("account_id", accountIds);

  if (subsErr) return json({ error: subsErr.message }, 500);

  const subsByAccount = new Map<string, typeof subs>();
  for (const s of subs ?? []) {
    const list = subsByAccount.get(s.account_id) ?? [];
    list.push(s);
    subsByAccount.set(s.account_id, list);
  }

  let sent = 0;
  const staleSubscriptionIds = new Set<string>();

  for (const n of pending) {
    const targets = subsByAccount.get(n.recipient_account_id) ?? [];
    const payload = JSON.stringify({
      title: n.title,
      body: n.body ?? "",
      link: n.link ?? "/notifications",
      kind: n.kind,
    });

    for (const s of targets) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
        sent++;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          staleSubscriptionIds.add(s.id);
        }
        // 그 외 실패(일시적 오류 등)는 재시도하지 않고 넘어간다 — 알림함에는 이미 기록됨
      }
    }
  }

  if (staleSubscriptionIds.size > 0) {
    await admin.from("push_subscriptions").delete().in("id", [...staleSubscriptionIds]);
  }

  await admin
    .from("notifications")
    .update({ pushed_at: new Date().toISOString() })
    .in("id", pending.map((n) => n.id));

  return json({ processed: pending.length, sent, staleRemoved: staleSubscriptionIds.size });
});
