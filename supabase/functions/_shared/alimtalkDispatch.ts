// 알림톡 큐 디스패치 로직(순수, Deno/네트워크 의존 없음 — 의존성은 deps로 주입해 vitest에서 직접 테스트한다).
//
// 문제(2026-10-08 감사): pg_cron이 매분 같은 messages 행(status='scheduled')을 다시 호출하는데, 예전 구현은
//  · 발송 전에 행을 선점하지 않았고(상태는 수신자 루프가 전부 끝난 뒤에야 바뀜),
//  · 수신자별 발송 기록에 message 연결이 없어 중간에 끊긴 실행을 재개할 수 없었으며,
//  · 외부 요청에 타임아웃이 없어 한 번의 지연이 다음 분 실행과 겹쳐 전체 재발송(건당 비용 + 사용자 스팸)으로 이어질 수 있었다.
//
// 지금 구조:
//  1) claim — "status='scheduled' AND (claimed_at IS NULL OR claimed_at < 임대 만료)"인 행을 한 번의 UPDATE로 선점한다.
//     두 실행이 겹쳐도 한쪽만 행을 돌려받는다(나머지는 skipped).
//  2) 이미 'sent' 로그가 있는 수신자는 건너뛴다(notification_logs.message_id + (message_id, profile_id) 'sent' 유일 인덱스) →
//     충돌 후 재시도/임대 만료 후 재개해도 같은 수신자에게 두 번 보내지 않는다.
//  3) 마무리 — 재시도 가능한 실패(타임아웃/5xx)가 남았고 아직 재시도 창 안이면 선점만 풀어 다음 분에 남은 수신자만 재시도,
//     아니면 sent/failed로 확정한다(기존 규칙: 한 건도 못 보냈고 실패가 있으면 failed, 아니면 sent).

export type QueuedMessage = {
  id: string;
  center_id: string;
  content: string;
  target_profile_ids: string[];
  status: string;
  aligo_template_code: string | null;
  created_at: string;
};

export type SendOutcome = { status: "sent" | "failed"; message?: string; retryable?: boolean };

export interface DispatchDeps {
  /** 원자적 선점: 선점에 성공한 행을 돌려주고, 이미 다른 실행이 잡았거나 처리됐으면 null. */
  claim(messageId: string, nowIso: string, leaseCutoffIso: string): Promise<QueuedMessage | null>;
  isAddonEnabled(centerId: string): Promise<boolean>;
  loadSentProfileIds(messageId: string): Promise<Set<string>>;
  loadRecipients(profileIds: string[]): Promise<{ id: string; phone: string | null }[]>;
  send(input: { to: string; content: string; templateCode?: string }): Promise<SendOutcome>;
  insertLog(entry: { messageId: string; centerId: string; profileId: string; status: "sent" | "failed"; cost: number; error?: string }): Promise<"inserted" | "duplicate">;
  finalize(messageId: string, patch: { status: "sent" | "failed"; sentAtIso: string } | { release: true }): Promise<void>;
}

export type DispatchResult =
  | { claimed: false; skipped: "not-claimable" }
  | { claimed: true; skipped: "addon-disabled" }
  | { claimed: true; processed: number; sent: number; failed: number; retryScheduled: number; finalStatus: "sent" | "failed" | "retry" };

export const CLAIM_LEASE_MS = 10 * 60 * 1000;     // 선점 임대: 이 시간 안에는 다른 실행이 같은 행을 잡지 못한다(실행이 죽었다면 이후 재개)
export const RETRY_WINDOW_MS = 30 * 60 * 1000;    // 메시지 생성 후 이 시간 안에서만 일시 실패를 재시도, 이후 확정
export const ALIMTALK_UNIT_COST = 9;              // 건당 단가(원) — send-alimtalk 기존 값 유지

export async function dispatchQueuedMessage(
  deps: DispatchDeps,
  messageId: string,
  opts: { now?: () => Date; leaseMs?: number; retryWindowMs?: number } = {},
): Promise<DispatchResult> {
  const now = opts.now ?? (() => new Date());
  const t0 = now();
  const msg = await deps.claim(messageId, t0.toISOString(), new Date(t0.getTime() - (opts.leaseMs ?? CLAIM_LEASE_MS)).toISOString());
  if (!msg) return { claimed: false, skipped: "not-claimable" };

  // 알림톡 애드온 미신청 센터는 자동 발송도 막는다(기존 규칙) — 'scheduled'로 두면 매분 다시 집으므로 failed로 확정한다.
  if (!(await deps.isAddonEnabled(msg.center_id))) {
    await deps.finalize(msg.id, { status: "failed", sentAtIso: now().toISOString() });
    return { claimed: true, skipped: "addon-disabled" };
  }

  const alreadySent = await deps.loadSentProfileIds(msg.id);
  const remainingIds = msg.target_profile_ids.filter((id) => !alreadySent.has(id));
  const recipients = remainingIds.length > 0 ? await deps.loadRecipients(remainingIds) : [];

  let sent = 0;
  let permanentFailed = 0;
  let transientFailed = 0;
  for (const r of recipients) {
    if (!r.phone) { permanentFailed++; continue; }
    const result = await deps.send({ to: r.phone, content: msg.content, templateCode: msg.aligo_template_code ?? undefined });
    const logStatus = result.status === "sent" ? "sent" : "failed";
    // 로그 기록 실패(DB 오류)는 발송 결과를 바꾸지 않는다 — 단, 'sent' 유일 인덱스 충돌은 다른 실행이 이미 보낸 것이므로 sent로 센다.
    await deps.insertLog({
      messageId: msg.id, centerId: msg.center_id, profileId: r.id, status: logStatus,
      cost: result.status === "sent" ? ALIMTALK_UNIT_COST : 0,
      ...(result.status === "failed" ? { error: (result.message ?? "").slice(0, 200) } : {}),
    }).catch(() => "inserted" as const);
    if (result.status === "sent") sent++;
    else if (result.retryable) transientFailed++;
    else permanentFailed++;
  }

  const totalSent = alreadySent.size + sent;
  const withinRetryWindow = now().getTime() - Date.parse(msg.created_at) <= (opts.retryWindowMs ?? RETRY_WINDOW_MS);
  if (transientFailed > 0 && withinRetryWindow) {
    // 선점만 풀고 status는 'scheduled' 그대로 — 다음 분 실행이 아직 못 보낸 수신자만 이어서 보낸다(이미 보낸 사람은 로그로 건너뜀).
    await deps.finalize(msg.id, { release: true });
    return { claimed: true, processed: recipients.length, sent, failed: permanentFailed, retryScheduled: transientFailed, finalStatus: "retry" };
  }

  const failed = permanentFailed + transientFailed;
  const finalStatus: "sent" | "failed" = failed > 0 && totalSent === 0 ? "failed" : "sent";
  await deps.finalize(msg.id, { status: finalStatus, sentAtIso: now().toISOString() });
  return { claimed: true, processed: recipients.length, sent, failed, retryScheduled: 0, finalStatus };
}
