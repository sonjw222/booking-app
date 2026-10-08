import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyFcmError, classifyWebPushError, decideNotificationOutcome, summarizeBatch, RETRY_WINDOW_MS, type DeliveryResult,
} from "../../supabase/functions/_shared/pushOutcome";

const MIN = 60 * 1000;
const D: DeliveryResult = { kind: "delivered" };
const T: DeliveryResult = { kind: "transient", error: "HTTP 503" };

describe("푸시 알림 1건 판정(decideNotificationOutcome)", () => {
  it("성공 → 완료(pushed_at 기록)", () => expect(decideNotificationOutcome([D], MIN)).toEqual({ done: true, reason: "delivered" }));
  it("보낼 대상이 없으면 완료(nothing_to_send)", () => expect(decideNotificationOutcome([], MIN)).toEqual({ done: true, reason: "nothing_to_send" }));
  it("영구 실패(만료 토큰/payload 과대)만 있으면 완료 — 되살릴 수 없으니 재시도하지 않는다", () => {
    expect(decideNotificationOutcome([{ kind: "stale" }], MIN).reason).toBe("permanent");
    expect(decideNotificationOutcome([{ kind: "stale" }, { kind: "permanent" }], MIN)).toEqual({ done: true, reason: "permanent" });
  });
  it("일시 실패만 있으면 재시도(pushed_at 비움)", () => expect(decideNotificationOutcome([T], MIN)).toEqual({ done: false, reason: "retry" }));
  it("설정 누락/토큰 발급 실패(unavailable)는 '발송 성공'이 아니라 재시도 대상", () => {
    for (const reason of ["fcm_not_configured", "fcm_token_unavailable", "fcm_auth_failed"] as const) {
      expect(decideNotificationOutcome([{ kind: "unavailable", reason }], MIN)).toEqual({ done: false, reason: "retry" });
    }
  });
  it("재시도 창(30분)이 지나면 포기(expired) — 영구 재시도 루프 방지", () => {
    expect(decideNotificationOutcome([T], RETRY_WINDOW_MS + 1)).toEqual({ done: true, reason: "expired" });
    expect(decideNotificationOutcome([T], RETRY_WINDOW_MS)).toEqual({ done: false, reason: "retry" });
  });
  it("일부 기기만 성공하면 완료(재시도하면 이미 받은 기기에 중복 발송) — 일부 실패는 재시도하지 않는다", () => {
    expect(decideNotificationOutcome([D, T, { kind: "unavailable", reason: "fcm_not_configured" }], MIN)).toEqual({ done: true, reason: "delivered" });
  });
  it("영구 실패 + 일시 실패 혼합(전달 0)은 재시도", () => expect(decideNotificationOutcome([{ kind: "stale" }, T], MIN).done).toBe(false));
});

describe("오류 분류", () => {
  it("웹푸시: 404/410=만료, 400/413=영구, 429/5xx/네트워크=일시", () => {
    expect(classifyWebPushError(410).kind).toBe("stale"); expect(classifyWebPushError(404).kind).toBe("stale");
    expect(classifyWebPushError(413).kind).toBe("permanent"); expect(classifyWebPushError(400).kind).toBe("permanent");
    expect(classifyWebPushError(429).kind).toBe("transient"); expect(classifyWebPushError(503).kind).toBe("transient");
    expect(classifyWebPushError(undefined)).toEqual({ kind: "transient", error: "network" });
  });
  it("FCM: UNREGISTERED/NOT_FOUND만 stale(토큰 삭제 대상)", () => {
    expect(classifyFcmError("UNREGISTERED", 404)).toEqual({ kind: "stale" });
    expect(classifyFcmError("NOT_FOUND", 404)).toEqual({ kind: "stale" });
  });
  it("FCM: INVALID_ARGUMENT는 stale이 아니다 — payload 오류일 수 있으므로 정상 토큰을 지우지 않고 permanent(재시도 없음)", () => {
    expect(classifyFcmError("INVALID_ARGUMENT", 400)).toEqual({ kind: "permanent", error: "INVALID_ARGUMENT" });
    expect(classifyFcmError("INVALID_ARGUMENT", 400).kind).not.toBe("stale");
  });
  it("FCM: 인증계열(UNAUTHENTICATED/PERMISSION_DENIED/SENDER_ID_MISMATCH)=unavailable", () => {
    for (const s of ["UNAUTHENTICATED", "PERMISSION_DENIED", "SENDER_ID_MISMATCH"]) expect(classifyFcmError(s, 403)).toEqual({ kind: "unavailable", reason: "fcm_auth_failed" });
  });
  it("FCM: 429/5xx/UNAVAILABLE/INTERNAL/QUOTA_EXCEEDED/미상=transient", () => {
    for (const s of ["UNAVAILABLE", "INTERNAL", "QUOTA_EXCEEDED", undefined]) expect(classifyFcmError(s, 503).kind).toBe("transient");
    expect(classifyFcmError(undefined, 429)).toEqual({ kind: "transient", error: "HTTP 429" });
  });
  it("INVALID_ARGUMENT만 있는 알림은 done(permanent) — 매분 재시도하지 않는다", () => {
    expect(decideNotificationOutcome([classifyFcmError("INVALID_ARGUMENT", 400)], MIN)).toEqual({ done: true, reason: "permanent" });
  });
  it("INVALID_ARGUMENT + delivered 혼합은 done(delivered)", () => {
    expect(decideNotificationOutcome([classifyFcmError("INVALID_ARGUMENT", 400), D], MIN)).toEqual({ done: true, reason: "delivered" });
  });
  it("호출부: native_push_tokens 삭제 대상은 kind === 'stale'일 때만 추가된다(INVALID_ARGUMENT는 permanent라 제외)", () => {
    const src = readFileSync(resolve(__dirname, "../../supabase/functions/send-web-push/index.ts"), "utf8");
    expect(src).toMatch(/else if \(r\.kind === "stale"\) staleNativeTokenIds\.add\(t\.id\)/);
    expect(src.match(/staleNativeTokenIds\.add\(/g)?.length).toBe(2); // 탈퇴 계정 정리 + stale 판정, 그 외 경로 없음
    expect(readFileSync(resolve(__dirname, "../../supabase/functions/_shared/pushOutcome.ts"), "utf8"))
      .toMatch(/const FCM_STALE = new Set\(\["UNREGISTERED", "NOT_FOUND"\]\)/);
  });
});

describe("배치 요약(부분 배치)", () => {
  it("알림별로 독립 판정하고, 끝난 것만 completed로 센다", () => {
    const decisions = [
      decideNotificationOutcome([D], MIN),                                         // 완료
      decideNotificationOutcome([T], MIN),                                         // 재시도
      decideNotificationOutcome([{ kind: "stale" }], MIN),                         // 영구 → 완료
      decideNotificationOutcome([{ kind: "unavailable", reason: "fcm_not_configured" }], RETRY_WINDOW_MS + 1),  // 만료 → 완료
    ];
    const s = summarizeBatch(decisions, ["fcm_not_configured", "fcm_not_configured"]);
    expect(s).toMatchObject({ processed: 4, completed: 3, retryScheduled: 1, configErrors: ["fcm_not_configured"] });
    expect(s.byReason).toEqual({ nothing_to_send: 0, delivered: 1, permanent: 1, expired: 1, retry: 1 });
  });
  it("요약에는 토큰/계정/본문 같은 값이 없다(건수와 사유 코드뿐)", () => {
    expect(JSON.stringify(summarizeBatch([{ done: true, reason: "delivered" }], []))).not.toMatch(/token|account|endpoint|@|\d{6,}/i);
  });
});
