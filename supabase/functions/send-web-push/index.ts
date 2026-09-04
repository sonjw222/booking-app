// Supabase Edge Function: 웹 푸시 + 네이티브(FCM) 푸시 발송 (P1-3 일부 + Capacitor 배치)
//
// add_web_push.sql이 등록한 pg_cron 작업("dispatch-web-push")이 1분마다 이 함수를
// 호출한다(요청 본문 없음, service_role 키로 인증). 이 함수는:
//   1) notifications 테이블에서 아직 발송하지 않은 행(pushed_at is null)을 찾고
//   2) 각 수신자(recipient_account_id)의 push_subscriptions(웹, VAPID)과
//      native_push_tokens(iOS/Android 네이티브 앱, FCM)를 모두 조회해
//   3a) 웹은 VAPID로 서명한 Web Push 메시지를 브라우저 푸시 서비스로 보내고
//   3b) 네이티브는 FCM HTTP v1 API로 보낸다(add_native_push_tokens.sql 참고 — iOS
//       WKWebView는 VAPID 웹푸시 구독 자체를 지원하지 않아 네이티브 앱엔 이 경로가 필수)
//   4) 만료/무효 구독·토큰(404/410, FCM UNREGISTERED 등)은 해당 행을 지운다
//   5) 처리한 알림은 성공/실패 여부와 무관하게 pushed_at을 채운다(재시도 없음 — 최선 노력
//      전달. 실패해도 알림함(/notifications)에는 이미 기록이 남아 있어 앱을 열면 확인 가능)
//
// 이미 로그인/화면을 보고 있는 사용자에게는 실시간 팝업(NotificationToaster, Realtime
// 구독)이 따로 동작하므로, 이 푸시는 "앱을 안 보고 있을 때"를 위한 보완 채널이다.
//
// 필요한 환경변수(add_web_push.sql 상단 안내 참고, `supabase secrets set`으로 등록):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — Edge Function에 기본 주입되거나 프로젝트 설정에서 확인
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY     — `npx web-push generate-vapid-keys`로 생성
//   VAPID_SUBJECT                            — 예: mailto:admin@example.com (푸시 서비스가 발신자
//                                               확인용으로 요구, 실제 발송에는 영향 없음)
//   FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY — Firebase 콘솔의 서비스 계정 키
//                                               (JSON 파일의 project_id/client_email/private_key
//                                               3개 필드를 각각 등록. private_key는 개행이 포함된
//                                               문자열이라 `supabase secrets set`에 그대로 붙여넣기)
// 배포: `supabase functions deploy send-web-push`

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { SignJWT, importPKCS8 } from "npm:jose@5.9.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";
const FCM_PROJECT_ID = Deno.env.get("FCM_PROJECT_ID") ?? "";
const FCM_CLIENT_EMAIL = Deno.env.get("FCM_CLIENT_EMAIL") ?? "";
const FCM_PRIVATE_KEY = Deno.env.get("FCM_PRIVATE_KEY") ?? "";

const BATCH_SIZE = 200;
const FCM_TOKEN_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// FCM_* 시크릿이 아직 등록 안 됐으면(Firebase 미연동 상태) 네이티브 발송을 조용히
// 건너뛴다 — 웹푸시는 그대로 동작해야 하므로 이 함수 전체를 실패시키지 않는다.
const fcmConfigured = !!(FCM_PROJECT_ID && FCM_CLIENT_EMAIL && FCM_PRIVATE_KEY);

// FCM HTTP v1은 서비스 계정 JWT를 access token으로 교환해야 한다(OAuth2 Server-to-Server
// 흐름) — firebase-admin SDK는 Deno Edge 런타임 호환이 불안정해 jose로 직접 서명한다.
// 매 실행(1분 주기)마다 새로 발급 — access token은 1시간 유효하지만 재사용 캐싱은
// 이 함수의 짧은 실행 수명을 고려해 생략(단순함 우선, 트래픽이 커지면 재검토).
async function getFcmAccessToken(): Promise<string | null> {
  if (!fcmConfigured) return null;
  try {
    const privateKey = await importPKCS8(FCM_PRIVATE_KEY.replace(/\\n/g, "\n"), "RS256");
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({
      scope: FCM_TOKEN_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(FCM_CLIENT_EMAIL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

// FCM UNREGISTERED/NOT_FOUND면 토큰이 무효하다는 뜻 — 해당 native_push_tokens 행을 지운다.
async function sendFcm(accessToken: string, token: string, payload: {
  title: string; body: string; link: string;
}): Promise<{ ok: boolean; stale: boolean }> {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: payload.title, body: payload.body },
          data: { link: payload.link },
        },
      }),
    },
  );
  if (res.ok) return { ok: true, stale: false };
  const errBody = await res.json().catch(() => ({}));
  const status = errBody?.error?.status;
  return { ok: false, stale: status === "UNREGISTERED" || status === "NOT_FOUND" };
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

  const { data: nativeTokens, error: nativeErr } = await admin
    .from("native_push_tokens")
    .select("id, account_id, token")
    .in("account_id", accountIds);

  if (nativeErr) return json({ error: nativeErr.message }, 500);

  const subsByAccount = new Map<string, typeof subs>();
  for (const s of subs ?? []) {
    const list = subsByAccount.get(s.account_id) ?? [];
    list.push(s);
    subsByAccount.set(s.account_id, list);
  }

  const nativeByAccount = new Map<string, typeof nativeTokens>();
  for (const t of nativeTokens ?? []) {
    const list = nativeByAccount.get(t.account_id) ?? [];
    list.push(t);
    nativeByAccount.set(t.account_id, list);
  }

  // FCM 시크릿 미등록이면 fcmAccessToken이 null — 아래 네이티브 발송 루프가 자동으로
  // 건너뛰어진다(웹푸시만 계속 정상 동작).
  const fcmAccessToken = await getFcmAccessToken();

  let sent = 0;
  const staleSubscriptionIds = new Set<string>();
  const staleNativeTokenIds = new Set<string>();

  for (const n of pending) {
    const targets = subsByAccount.get(n.recipient_account_id) ?? [];
    const nativeTargets = nativeByAccount.get(n.recipient_account_id) ?? [];
    const link = n.link ?? "/notifications";
    const payload = JSON.stringify({
      title: n.title,
      body: n.body ?? "",
      link,
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

    if (fcmAccessToken) {
      for (const t of nativeTargets) {
        const result = await sendFcm(fcmAccessToken, t.token, {
          title: n.title,
          body: n.body ?? "",
          link,
        });
        if (result.ok) sent++;
        else if (result.stale) staleNativeTokenIds.add(t.id);
      }
    }
  }

  if (staleSubscriptionIds.size > 0) {
    await admin.from("push_subscriptions").delete().in("id", [...staleSubscriptionIds]);
  }
  if (staleNativeTokenIds.size > 0) {
    await admin.from("native_push_tokens").delete().in("id", [...staleNativeTokenIds]);
  }

  await admin
    .from("notifications")
    .update({ pushed_at: new Date().toISOString() })
    .in("id", pending.map((n) => n.id));

  return json({
    processed: pending.length,
    sent,
    staleRemoved: staleSubscriptionIds.size,
    staleNativeTokensRemoved: staleNativeTokenIds.size,
  });
});
