import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(f, "utf8");
const strip = (s: string) => s.replace(/^\s*--.*$/gm, "");
const push = read("supabase/functions/send-web-push/index.ts");
const alimtalk = read("supabase/functions/send-alimtalk/index.ts");
const aligo = read("supabase/functions/_shared/aligo.ts");

describe("send-web-push 배선", () => {
  it("판정 모듈을 쓰고, pushed_at은 '끝난 알림'에만 기록한다(전체 pending에 일괄 기록하지 않음)", () => {
    expect(push).toContain('from "../_shared/pushOutcome.ts"');
    expect(push).toContain("decideNotificationOutcome(results");
    expect(push).toMatch(/\.update\(\{ pushed_at: new Date\(\)\.toISOString\(\) \}\)\s*\.in\("id", completedIds\)/);
    expect(push).not.toMatch(/\.in\("id", pending\.map\(/);
  });
  it("FCM 설정 누락/토큰 발급 실패는 unavailable로 모으고 응답 500 + 구조화 로그로 드러낸다", () => {
    expect(push).toContain('reason: "fcm_not_configured"'); expect(push).toContain('reason: "fcm_token_unavailable"');
    expect(push).toContain("summary.configErrors.length > 0 ? 500 : 200");
    expect(push).toContain('console.error("[send-web-push]"');
  });
  it("외부 호출에 타임아웃이 있고 FCM 네트워크 예외가 배치를 죽이지 않는다", () => {
    expect(push).toContain("AbortSignal.timeout(FETCH_TIMEOUT_MS)"); expect(push).toContain("timeout: FETCH_TIMEOUT_MS");
    expect(push).toMatch(/catch \{\s*\/\/ 네트워크\/타임아웃[\s\S]*return \{ kind: "transient", error: "network" \}/);
  });
  it("로그에는 토큰/계정/endpoint/본문이 들어가지 않는다", () => {
    const logs = [...push.matchAll(/console\.(?:error|warn|log)\(([^;]*)\);/g)].map((m) => m[1]).join("\n");
    expect(logs).not.toMatch(/\.token|endpoint|recipient_account_id|account_id|\.body|p256dh|auth\b/);
  });
});

describe("send-alimtalk / aligo 배선", () => {
  it("큐 디스패치는 선점 모듈을 쓰고, 선점은 단일 UPDATE(status=scheduled + 임대 조건)다", () => {
    expect(alimtalk).toContain('from "../_shared/alimtalkDispatch.ts"');
    expect(alimtalk).toContain("dispatchQueuedMessage(deps, body.messageId)");
    expect(alimtalk).toMatch(/\.update\(\{ claimed_at: nowIso \}\)\s*\.eq\("id", id\)\s*\.eq\("status", "scheduled"\)\s*\.or\(`claimed_at\.is\.null,claimed_at\.lt\.\$\{leaseCutoffIso\}`\)/);
    expect(alimtalk).toContain('.eq("message_id", id)');   // 수신자별 'sent' 로그로 재개/중복 방지
  });
  it("예전의 '읽고 → 루프 → 마지막에 상태 변경' 구조가 남아있지 않다", () => {
    expect(alimtalk).not.toContain('if (msg.status !== "scheduled") return json({ processed: 0, skipped: "already-handled" })');
    expect(alimtalk).not.toMatch(/failed > 0 && sent === 0 \? "failed" : "sent"/);
  });
  it("Aligo 프록시 fetch에 타임아웃이 있고, 재시도 가능 실패만 retryable로 표시한다(제공자 거절은 아님)", () => {
    expect(aligo).toContain("signal: AbortSignal.timeout(ALIGO_TIMEOUT_MS)");
    expect(aligo).toContain("retryable: err instanceof AligoTransientError");
    expect(aligo).toContain("res.status >= 500 || res.status === 429");
    // 프록시 구조/비밀 이름은 그대로
    expect(aligo).toContain('Deno.env.get("ALIGO_PROXY_URL")'); expect(aligo).toContain('Deno.env.get("ALIGO_PROXY_TOKEN")');
  });
  it("send-alimtalk 로그에는 수신자 번호/본문이 없다", () => {
    const logs = [...alimtalk.matchAll(/console\.(?:error|warn|log)\(([^;]*)\);/g)].map((m) => m[1]).join("\n");
    expect(logs).not.toMatch(/phone|\.content|to:/);
  });
});

describe("마이그레이션 계약", () => {
  const fwd = strip(read("fix_alimtalk_dispatch_claim_20261008.sql"));
  it("새 status 값을 추가하지 않고(CHECK 불변), RLS/정책/데이터를 바꾸지 않는다", () => {
    expect(fwd).not.toMatch(/messages_status_check|create policy|drop policy|row level security|\bdelete from\b|\bupdate public\.\w+ set\b/i);
  });
  it("service_role에만 최소 권한(SELECT + 3개 컬럼 UPDATE)을 준다", () => {
    expect(fwd).toContain("grant select on public.messages to service_role;");
    expect(fwd).toContain("grant update (status, sent_at, claimed_at) on public.messages to service_role;");
    expect(fwd).not.toMatch(/to (anon|authenticated|public)/i);
  });
  it("(message_id, profile_id) sent 부분 유일 인덱스", () => {
    expect(fwd).toMatch(/create unique index if not exists uq_notification_logs_message_profile_sent\s+on public\.notification_logs \(message_id, profile_id\)\s+where status = 'sent' and message_id is not null;/);
  });
  it("rollback은 추가분만 되돌린다", () => {
    const rb = strip(read("rollback_fix_alimtalk_dispatch_claim_20261008.sql"));
    for (const line of ["drop column if exists claimed_at", "drop column if exists message_id", "drop column if exists error", "drop index if exists public.uq_notification_logs_message_profile_sent"]) expect(rb).toContain(line);
    expect(rb).not.toMatch(/\bcreate\b|\bgrant\b|policy/i);
  });
  it("verify는 SELECT만(문자열 리터럴 제외)", () => {
    expect(strip(read("verify_fix_alimtalk_dispatch_claim_20261008.sql")).replace(/'[^']*'/g, "''")).not.toMatch(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i);
  });
});

describe("오류 화면 배선", () => {
  it("app/error.tsx와 app/global-error.tsx가 단일 helper로 기록한다", () => {
    for (const f of ["app/error.tsx", "app/global-error.tsx"]) {
      const src = read(f);
      expect(src).toContain('from "../lib/errorReporting"'); expect(src).toContain("reportClientError(error");
    }
  });
});
