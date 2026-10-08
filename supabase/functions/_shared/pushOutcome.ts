// 푸시 발송 결과 판정(순수 로직, Deno/네트워크 의존 없음 — vitest에서 직접 테스트한다).
//
// 예전에는 send-web-push가 "처리한 알림은 성공/실패와 무관하게 pushed_at을 채운다"였다. 그 결과
//  · FCM 시크릿이 없거나 access token 발급이 실패하면 네이티브 발송을 조용히 건너뛰고도 알림이 영구히 "발송됨"이 되고,
//  · 일시적 오류(5xx/타임아웃/429)로 실패해도 재시도 없이 유실됐다.
// 이제 알림별로 결과를 모아 "끝난 것(done)"만 pushed_at을 채우고, 재시도 가능한 실패는 pushed_at을 비워 둔다(다음 분 cron이 다시 집는다).
//
// 판정 규칙(알림 1건 기준):
//  · 대상(웹 구독/네이티브 토큰)이 하나도 없다            → done(nothing_to_send) — 보낼 곳이 없다(알림함에는 이미 기록됨)
//  · 하나라도 delivered                                   → done(delivered)       — 재시도하면 이미 받은 기기에 중복 발송되므로 끝낸다
//  · 전부 stale/permanent(되살릴 수 없는 실패)            → done(permanent)
//  · 그 외(일시 실패/설정 누락이 남아 있고 delivered 없음) → retry, 단 알림이 RETRY_WINDOW보다 오래되면 done(expired — 포기, 알림은 늦으면 의미 없음)

export type DeliveryResult =
  | { kind: "delivered" }
  | { kind: "stale" }                    // 구독/토큰이 사라짐(404/410, UNREGISTERED 등) — 호출부가 행을 지운다
  | { kind: "permanent"; error?: string } // 다시 보내도 성공할 수 없음(payload 과대 등) — 행은 유지
  | { kind: "transient"; error?: string } // 재시도하면 성공할 수 있음(5xx, 429, 네트워크, 타임아웃)
  | { kind: "unavailable"; reason: "fcm_not_configured" | "fcm_token_unavailable" | "fcm_auth_failed" };

export type NotificationDecision = {
  done: boolean;
  reason: "nothing_to_send" | "delivered" | "permanent" | "expired" | "retry";
};

export const RETRY_WINDOW_MS = 30 * 60 * 1000;   // 30분 안에는 재시도, 이후 포기

export function decideNotificationOutcome(
  results: DeliveryResult[],
  ageMs: number,
  retryWindowMs: number = RETRY_WINDOW_MS,
): NotificationDecision {
  if (results.length === 0) return { done: true, reason: "nothing_to_send" };
  if (results.some((r) => r.kind === "delivered")) return { done: true, reason: "delivered" };
  const retryable = results.some((r) => r.kind === "transient" || r.kind === "unavailable");
  if (!retryable) return { done: true, reason: "permanent" };
  if (ageMs > retryWindowMs) return { done: true, reason: "expired" };
  return { done: false, reason: "retry" };
}

// 웹푸시 서비스 오류 분류: 404/410 = 구독 만료(삭제), 400/413 = 다시 보내도 같은 결과, 나머지(429/5xx/네트워크/미상) = 일시 오류.
export function classifyWebPushError(statusCode: number | undefined): DeliveryResult {
  if (statusCode === 404 || statusCode === 410) return { kind: "stale" };
  if (statusCode === 400 || statusCode === 413) return { kind: "permanent", error: `HTTP ${statusCode}` };
  return { kind: "transient", error: statusCode ? `HTTP ${statusCode}` : "network" };
}

// FCM HTTP v1 응답 분류. status는 error.status 문자열(UNREGISTERED 등), httpStatus는 HTTP 코드.
const FCM_STALE = new Set(["UNREGISTERED", "NOT_FOUND", "INVALID_ARGUMENT"]);
const FCM_AUTH = new Set(["UNAUTHENTICATED", "PERMISSION_DENIED", "SENDER_ID_MISMATCH"]);
export function classifyFcmError(status: string | undefined, httpStatus: number | undefined): DeliveryResult {
  if (status && FCM_STALE.has(status)) return { kind: "stale" };
  if (status && FCM_AUTH.has(status)) return { kind: "unavailable", reason: "fcm_auth_failed" };
  // UNAVAILABLE / INTERNAL / QUOTA_EXCEEDED / 429 / 5xx / 알 수 없는 오류 → 재시도 가능
  return { kind: "transient", error: status ?? (httpStatus ? `HTTP ${httpStatus}` : "unknown") };
}

// 배치 요약(로그/응답용) — 토큰/계정/원문 없이 건수만.
export type BatchSummary = {
  processed: number; completed: number; retryScheduled: number;
  byReason: Record<NotificationDecision["reason"], number>;
  configErrors: string[];
};
export function summarizeBatch(decisions: NotificationDecision[], configErrors: Iterable<string>): BatchSummary {
  const byReason: BatchSummary["byReason"] = { nothing_to_send: 0, delivered: 0, permanent: 0, expired: 0, retry: 0 };
  for (const d of decisions) byReason[d.reason]++;
  return {
    processed: decisions.length,
    completed: decisions.filter((d) => d.done).length,
    retryScheduled: byReason.retry,
    byReason,
    configErrors: [...new Set(configErrors)],
  };
}
