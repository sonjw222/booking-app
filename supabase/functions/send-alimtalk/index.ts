// Supabase Edge Function: 알림톡(카카오 알림톡) 발송
//
// 플랫폼(sonjw) 단일 알리고 계정으로 전 센터를 대행 발송한다(사용자 결정, 2026-09-01) — 센터
// 운영자는 각자 사업자 인증·알리고 가입을 할 필요가 없고, 승인된 발신프로필(카카오 채널)과
// 템플릿만 이 플랫폼 계정 아래 등록해서 쓴다. API 키는 여기서만 쓰고 브라우저에는 절대
// 노출하지 않는다(CLAUDE.md 5번 규칙) — lib/messaging/AlimtalkSmsProvider.ts가 클라이언트에서
// 이 함수를 supabase.functions.invoke()로 호출하는 구조.
//
// 세 가지 호출 경로:
//   1) 매니저 화면(즉시 발송) — { to, content, channel:"alimtalk", templateCode?, templateVariables? }
//      본인 세션 JWT로 호출. 발송 결과만 바로 응답, DB에 기록 안 함(즉시 발송은 이력 없음 —
//      사용자 결정. 발송 여부는 카카오톡/문자함에서 직접 확인).
//   2) add_notification_rule_evaluators.sql이 등록한 pg_cron("dispatch-alimtalk")이
//      { messageId } 로 호출 — service_role 키로 인증(비대화형, 큐 디스패치). messages 테이블에서
//      해당 행을 읽어 대상 전원에게 발송하고 status/sent_at 갱신 + notification_logs에 건당
//      비용 기록(정산 근거).
//   3) 템플릿 관리 화면(app/manager/alimtalk/templates)의 "알리고에서 불러오기" —
//      { action:"list_templates", centerId } 로 호출. 알리고 계정에 등록된 템플릿 목록을
//      그대로 반환(승인상태/코드를 수동으로 옮겨 적지 않게, 2026-09-08).
//
// 인증(2026-10-30 개정, 관리자 QA #239): 판정 로직은 ../_shared/alimtalkAuthz.ts(순수 함수, vitest 로 직접 시험). Authorization 헤더의 JWT 가 실제 로그인 사용자면
//   ① JWT 유효(만료·위조는 401) ② 계정 존재 ③ 플랫폼 운영자이거나 대상 센터의 활성 매니저 ④ 호출자 본인 JWT 로 message.alimtalk.view 권한 보유(없으면 403, 권한 조회 오류는 500 — fail-closed)
//   를 모두 만족해야 한다. 예전에는 "센터 소속"만 확인해 메뉴만 가려 둔 직원이 직접 호출로 유료 발송을 할 수 있었다. 어느 단계든 못 넘으면 알리고 프록시는 호출되지 않는다.
//   service_role 키(경로 2, dispatch-alimtalk cron 만 앎)면 내부 호출로 신뢰한다.
//
// 필요한 Edge Function 환경변수(`supabase secrets set`으로 등록, 코드/DB에 저장 안 함):
//   ALIGO_PROXY_URL                    — Oracle 고정-IP Aligo 프록시 URL
//   ALIGO_PROXY_TOKEN                  — 프록시 서버 인증용 Bearer token
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY — Supabase가 기본 주입
//
// Aligo 계정/API 키/발신프로필 키/발신번호는 Oracle 프록시 서버에만 보관하고,
// 이 Edge Function에서는 직접 보유하거나 Aligo API에 직접 접속하지 않는다.
//
// 알리고 실발송 로직(sendViaAligo)은 ../_shared/aligo.ts로 옮겨졌다 — send-phone-otp(휴대폰
// 인증번호 발송, 2026-09-05)도 같은 로직을 쓰기 때문(로그인 전 호출이라 이 함수의
// alimtalkAuthz 권한 모델과는 다른 별도 함수로 분리, Aligo 호출 부분만 공유).
//
// 배포: `supabase functions deploy send-alimtalk`

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  sendViaAligo, isAligoConfigured, fetchAligoTemplateList,
  createAligoTemplate, requestAligoTemplateApproval,
} from "../_shared/aligo.ts";
import { dispatchQueuedMessage, type DispatchDeps, type QueuedMessage } from "../_shared/alimtalkDispatch.ts";
import { authorizeAlimtalkCaller, handleImmediateSend, ALIMTALK_PERMISSION, type AuthzDeps } from "../_shared/alimtalkAuthz.ts";

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

// "현재 로그인 유저 → accounts.id"를 계정 연동(account_auth_identities) 인지하고 조회한다.
// admin(service_role) 클라이언트는 auth.uid()가 없어 RPC my_account_id()를 못 쓰므로,
// 같은 fallback 로직을 여기서 직접 반복한다(2026-09-09, 계정 연동 기능).
async function resolveAccountId(admin: ReturnType<typeof createClient>, authUserId: string): Promise<{ id: string; is_platform_admin: boolean } | null> {
  const { data: account } = await admin
    .from("accounts")
    .select("id, is_platform_admin")
    .eq("auth_id", authUserId)
    .maybeSingle();
  if (account) return account;

  const { data: linked } = await admin
    .from("account_auth_identities")
    .select("account_id")
    .eq("auth_id", authUserId)
    .maybeSingle();
  if (!linked) return null;
  const { data: mergedAccount } = await admin
    .from("accounts")
    .select("id, is_platform_admin")
    .eq("id", linked.account_id)
    .maybeSingle();
  return mergedAccount ?? null;
}

// 권한 판정 의존성(실제 Supabase 클라이언트 연결). 판정 규칙 자체는 ../_shared/alimtalkAuthz.ts.
function authzDeps(): AuthzDeps {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  return {
    serviceRoleKey: SERVICE_ROLE_KEY,
    async getUserId(authHeader) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data } = await userClient.auth.getUser();
      return data?.user?.id ?? null;
    },
    resolveAccount: (userId) => resolveAccountId(admin, userId),
    async isActiveManager(accountId, centerId) {
      const { data: mc } = await admin.from("manager_centers").select("id").eq("account_id", accountId).eq("center_id", centerId).eq("status", "active").maybeSingle();
      return !!mc;
    },
    async hasPermission(authHeader, centerId, permissionKey) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data, error } = await userClient.rpc("has_permission", { p_center_id: centerId, p_permission: permissionKey });
      return error ? null : data === true;
    },
  };
}

// 거부면 응답(401/403/500), 통과면 null. 권한 키는 ALIMTALK_PERMISSION(message.alimtalk.view).
async function denyUnlessAuthorized(authHeader: string | null, centerId: string): Promise<Response | null> {
  const r = await authorizeAlimtalkCaller(authzDeps(), authHeader, centerId);
  return r.ok ? null : json({ error: r.message, permission: r.status === 403 ? ALIMTALK_PERMISSION : undefined }, r.status);
}

// "공통"(플랫폼 전체) 템플릿 생성/신청은 센터가 없어 위 denyUnlessAuthorized로 판정할 수
// 없다 — 플랫폼 운영자만 허용.
async function isPlatformAdminCaller(authHeader: string | null): Promise<boolean> {
  if (!authHeader) return false;
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) return false;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const account = await resolveAccountId(admin, authData.user.id);
  return !!account?.is_platform_admin;
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
    title?: string;      // action:"create_template"
    tplCode?: string;    // action:"request_template_approval"
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

  // 템플릿 관리 화면(app/manager/alimtalk/templates)의 "알리고에서 불러오기" — 승인/반려
  // 상태와 코드를 수동으로 옮겨 적지 않게, 알리고 계정에 등록된 템플릿 목록을 그대로 조회.
  // 알리고는 senderkey 하나로 계정 전체를 조회해 center_id 구분이 없으므로, 호출자가
  // "이 센터"에 대한 매니저 권한이 있는지만 확인하고 목록 자체는 필터링하지 않는다
  // (여러 센터 템플릿이 섞여 나와도 매니저가 이름으로 알아보고 고르는 방식).
  if (body.action === "list_templates") {
    if (!body.centerId) return json({ error: "centerId가 필요해요" }, 400);
    { const denied = await denyUnlessAuthorized(req.headers.get("Authorization"), body.centerId); if (denied) return denied; }
    try {
      const list = await fetchAligoTemplateList();
      return json({ templates: list });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "템플릿 목록 조회에 실패했어요" }, 502);
    }
  }

  // 템플릿 관리 화면의 "카카오 승인 신청하기" 1단계 — 알리고에 신규 템플릿 생성.
  // centerId가 있으면 그 센터 소속 매니저(또는 운영자)만, 없으면("공통" 템플릿) 플랫폼
  // 운영자만 허용. 여러 센터가 같은 알리고 계정을 공유해서, 알리고 쪽 목록에서 서로
  // 구분되게 tpl_name에 센터명(또는 "공통")을 접두사로 붙인다.
  if (body.action === "create_template") {
    if (!body.title || !body.content) return json({ error: "title, content가 필요해요" }, 400);
    let prefix = "[공통]";
    if (body.centerId) {
      { const denied = await denyUnlessAuthorized(req.headers.get("Authorization"), body.centerId); if (denied) return denied; }
      const { data: center } = await admin.from("centers").select("name").eq("id", body.centerId).maybeSingle();
      prefix = `[${center?.name ?? "센터"}]`;
    } else if (!(await isPlatformAdminCaller(req.headers.get("Authorization")))) {
      return json({ error: "공통 템플릿은 플랫폼 운영자만 만들 수 있어요" }, 403);
    }
    try {
      const created = await createAligoTemplate(`${prefix} ${body.title}`, body.content);
      return json({ template: created });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "템플릿 생성에 실패했어요" }, 502);
    }
  }

  // 템플릿 관리 화면의 "카카오 승인 신청하기" 2단계 — 생성된 템플릿을 실제 카카오 심사에 제출.
  if (body.action === "request_template_approval") {
    if (!body.tplCode) return json({ error: "tplCode가 필요해요" }, 400);
    if (body.centerId) {
      { const denied = await denyUnlessAuthorized(req.headers.get("Authorization"), body.centerId); if (denied) return denied; }
    } else if (!(await isPlatformAdminCaller(req.headers.get("Authorization")))) {
      return json({ error: "공통 템플릿은 플랫폼 운영자만 신청할 수 있어요" }, 403);
    }
    try {
      await requestAligoTemplateApproval(body.tplCode);
      return json({ ok: true });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "승인 신청에 실패했어요" }, 502);
    }
  }

  // 경로 2: 큐 디스패치(dispatch-alimtalk cron) — messages 행을 읽어 대상 전원 발송
  if (body.messageId) {
    { const denied = await denyUnlessAuthorized(req.headers.get("Authorization"), ""); if (denied) return denied; }

    // 2026-10-08: 발송 전 원자적 선점 + 수신자별 'sent' 로그 기반 재개 + 외부 호출 타임아웃(_shared/alimtalkDispatch.ts, aligo.ts) —
    // 매분 cron이 겹치거나 중간에 끊겨도 같은 수신자에게 두 번 보내지 않는다. 판정 로직은 순수 모듈에서 단위 테스트된다.
    // (service_role이 messages를 읽고 claimed_at/status/sent_at을 갱신하려면 fix_alimtalk_dispatch_claim_20261008.sql의 GRANT가 필요하다.)
    const deps: DispatchDeps = {
      async claim(id, nowIso, leaseCutoffIso) {
        const { data, error } = await admin
          .from("messages")
          .update({ claimed_at: nowIso })
          .eq("id", id)
          .eq("status", "scheduled")
          .or(`claimed_at.is.null,claimed_at.lt.${leaseCutoffIso}`)
          .select("id, center_id, content, target_profile_ids, status, aligo_template_code, created_at");
        if (error) throw new Error(`claim 실패: ${error.code ?? "unknown"}`);   // 메시지 본문/수신자는 오류에 싣지 않는다
        return ((data ?? [])[0] as QueuedMessage | undefined) ?? null;
      },
      async isAddonEnabled(centerId) {
        const { data } = await admin.from("center_subscriptions").select("alimtalk_addon").eq("center_id", centerId).maybeSingle();
        return !!data?.alimtalk_addon;
      },
      async loadSentProfileIds(id) {
        const { data } = await admin.from("notification_logs").select("profile_id").eq("message_id", id).eq("status", "sent");
        return new Set((data ?? []).map((r: { profile_id: string | null }) => r.profile_id).filter((v): v is string => !!v));
      },
      async loadRecipients(profileIds) {
        const { data } = await admin.from("profiles").select("id, accounts(phone)").in("id", profileIds);
        return (data ?? []).map((p) => ({
          id: (p as { id: string }).id,
          phone: (p as unknown as { accounts?: { phone?: string | null } }).accounts?.phone ?? null,
        }));
      },
      send: (input) => sendViaAligo(input),
      async insertLog(entry) {
        const { error } = await admin.from("notification_logs").insert({
          center_id: entry.centerId,
          profile_id: entry.profileId,
          channel: "alimtalk",
          cost: entry.cost,
          status: entry.status,
          message_id: entry.messageId,
          ...(entry.error ? { error: entry.error } : {}),
        });
        if (!error) return "inserted";
        if ((error as { code?: string }).code === "23505") return "duplicate";   // 같은 (message, profile) 'sent' 로그가 이미 있음 = 다른 실행이 보냄
        console.error("[send-alimtalk]", JSON.stringify({ event: "log_insert_failed", messageId: entry.messageId, code: (error as { code?: string }).code ?? null }));
        return "inserted";
      },
      async finalize(id, patch) {
        const update = "release" in patch ? { claimed_at: null } : { status: patch.status, sent_at: patch.sentAtIso };
        const { error } = await admin.from("messages").update(update).eq("id", id);
        if (error) throw new Error(`finalize 실패: ${error.code ?? "unknown"}`);
      },
    };

    try {
      const result = await dispatchQueuedMessage(deps, body.messageId);
      if (!result.claimed) return json({ processed: 0, skipped: "already-handled" });
      if ("skipped" in result) return json({ processed: 0, skipped: result.skipped });
      if (result.retryScheduled > 0 || result.failed > 0) {
        console.error("[send-alimtalk]", JSON.stringify({ event: "dispatch_issue", messageId: body.messageId, sent: result.sent, failed: result.failed, retryScheduled: result.retryScheduled, finalStatus: result.finalStatus }));
      }
      return json({ processed: result.processed, sent: result.sent, failed: result.failed, retryScheduled: result.retryScheduled });
    } catch (e) {
      console.error("[send-alimtalk]", JSON.stringify({ event: "dispatch_error", messageId: body.messageId, error: e instanceof Error ? e.message : "unknown" }));
      return json({ error: "발송 처리에 실패했어요" }, 500);
    }
  }

  // 경로 1: 즉시 발송 — 매니저 화면에서 직접 호출. 권한 판정·애드온 확인·발송 순서는 ../_shared/alimtalkAuthz.ts(handleImmediateSend)가 고정한다.
  const outcome = await handleImmediateSend({
    authz: authzDeps(),
    async isAddonEnabled(centerId) {
      const { data: sub } = await admin.from("center_subscriptions").select("alimtalk_addon").eq("center_id", centerId).maybeSingle();
      return !!sub?.alimtalk_addon;
    },
    send: (input) => sendViaAligo(input),
  }, body, req.headers.get("Authorization"));
  return json(outcome.body, outcome.status);
});
