import { describe, expect, it } from "vitest";
import {
  dispatchQueuedMessage, CLAIM_LEASE_MS, RETRY_WINDOW_MS, type DispatchDeps, type QueuedMessage, type SendOutcome,
} from "../../supabase/functions/_shared/alimtalkDispatch";

// 메모리 DB — claim은 한 번의 동기 갱신(= DB의 단일 UPDATE ... WHERE ... RETURNING)처럼 원자적이다.
function fakeWorld(opts: { targets: string[]; phones?: Record<string, string | null>; addon?: boolean; createdAt?: string; send?: (to: string, call: number) => SendOutcome | Promise<SendOutcome> }) {
  const msg = { id: "m1", center_id: "c1", content: "안내 [[x]]", target_profile_ids: opts.targets, status: "scheduled", aligo_template_code: null, created_at: opts.createdAt ?? new Date().toISOString() } as QueuedMessage;
  const row = { ...msg, claimed_at: null as string | null, sent_at: null as string | null };
  const logs: { messageId: string; profileId: string; status: string; error?: string }[] = [];
  const sends: string[] = [];
  let sendCalls = 0;
  const deps: DispatchDeps = {
    async claim(_id, nowIso, leaseCutoffIso) {
      if (row.status !== "scheduled") return null;
      if (row.claimed_at !== null && row.claimed_at >= leaseCutoffIso) return null;
      row.claimed_at = nowIso;
      return { ...msg, status: row.status };
    },
    async isAddonEnabled() { return opts.addon ?? true; },
    async loadSentProfileIds() { return new Set(logs.filter((l) => l.status === "sent").map((l) => l.profileId)); },
    async loadRecipients(ids) { return ids.map((id) => ({ id, phone: opts.phones && id in opts.phones ? opts.phones[id] : `010${id}` })); },
    async send({ to }) { sends.push(to); const n = ++sendCalls; await Promise.resolve(); return opts.send ? opts.send(to, n) : { status: "sent" }; },
    async insertLog(e) {
      if (e.status === "sent" && logs.some((l) => l.profileId === e.profileId && l.status === "sent")) return "duplicate";   // (message,profile) 'sent' 유일 인덱스
      logs.push({ messageId: e.messageId, profileId: e.profileId, status: e.status, error: e.error }); return "inserted";
    },
    async finalize(_id, patch) { if ("release" in patch) row.claimed_at = null; else { row.status = patch.status; row.sent_at = patch.sentAtIso; } },
  };
  return { deps, row, logs, sends };
}

describe("알림톡 큐 디스패치", () => {
  it("정상: 전원 발송 → sent로 확정, 수신자별 로그", async () => {
    const w = fakeWorld({ targets: ["1", "2"] });
    const r = await dispatchQueuedMessage(w.deps, "m1");
    expect(r).toMatchObject({ claimed: true, sent: 2, failed: 0, finalStatus: "sent" });
    expect(w.row.status).toBe("sent"); expect(w.logs.map((l) => l.status)).toEqual(["sent", "sent"]);
  });

  it("동시에 두 worker가 같은 메시지를 처리해도 각 수신자에게 한 번만 발송한다", async () => {
    const w = fakeWorld({ targets: ["1", "2", "3"] });
    const [a, b] = await Promise.all([dispatchQueuedMessage(w.deps, "m1"), dispatchQueuedMessage(w.deps, "m1")]);
    const claimedCount = [a, b].filter((x) => x.claimed).length;
    expect(claimedCount).toBe(1);
    expect(w.sends.sort()).toEqual(["0101", "0102", "0103"]);
    expect([a, b].find((x) => !x.claimed)).toEqual({ claimed: false, skipped: "not-claimable" });
  });

  it("이미 처리된(sent) 메시지는 다시 선점되지 않는다", async () => {
    const w = fakeWorld({ targets: ["1"] });
    await dispatchQueuedMessage(w.deps, "m1");
    expect(await dispatchQueuedMessage(w.deps, "m1")).toEqual({ claimed: false, skipped: "not-claimable" });
    expect(w.sends).toHaveLength(1);
  });

  it("타임아웃(재시도 가능 실패): 선점을 풀고 scheduled로 남겨 다음 분에 '못 보낸 사람만' 재시도 — 이미 보낸 사람은 중복 발송 없음", async () => {
    const w = fakeWorld({ targets: ["1", "2", "3"], send: (to, n) => (to === "0102" && n <= 2 ? { status: "failed", message: "timeout", retryable: true } : { status: "sent" }) });
    const first = await dispatchQueuedMessage(w.deps, "m1");
    expect(first).toMatchObject({ claimed: true, sent: 2, retryScheduled: 1, finalStatus: "retry" });
    expect(w.row.status).toBe("scheduled"); expect(w.row.claimed_at).toBeNull();
    const second = await dispatchQueuedMessage(w.deps, "m1");           // 다음 분
    expect(second).toMatchObject({ claimed: true, sent: 1, retryScheduled: 0, finalStatus: "sent" });
    expect(w.sends).toEqual(["0101", "0102", "0103", "0102"]);          // 0101/0103은 두 번째 실행에서 다시 보내지 않음
    expect(w.row.status).toBe("sent");
  });

  it("재시도 창을 넘기면 일시 실패도 확정(무한 재시도 없음): 일부 성공이면 sent, 전부 실패면 failed", async () => {
    const old = new Date(Date.now() - RETRY_WINDOW_MS - 1000).toISOString();
    const allFail = fakeWorld({ targets: ["1"], createdAt: old, send: () => ({ status: "failed", retryable: true }) });
    expect(await dispatchQueuedMessage(allFail.deps, "m1")).toMatchObject({ finalStatus: "failed", retryScheduled: 0 });
    const partial = fakeWorld({ targets: ["1", "2"], createdAt: old, send: (to) => (to === "0101" ? { status: "sent" } : { status: "failed", retryable: true }) });
    expect(await dispatchQueuedMessage(partial.deps, "m1")).toMatchObject({ finalStatus: "sent", sent: 1, failed: 1 });
  });

  it("영구 실패(전화번호 없음/제공자 거절)는 재시도하지 않고 기존 규칙으로 확정", async () => {
    const w = fakeWorld({ targets: ["1", "2"], phones: { "1": null }, send: () => ({ status: "failed", message: "bad number", retryable: false }) });
    const r = await dispatchQueuedMessage(w.deps, "m1");
    expect(r).toMatchObject({ sent: 0, failed: 2, retryScheduled: 0, finalStatus: "failed" });
    expect(w.logs.find((l) => l.status === "failed")?.error).toBe("bad number");
  });

  it("실행이 중간에 죽은 뒤 임대(10분)가 만료되면 이어서 처리하고, 이미 보낸 수신자는 건너뛴다", async () => {
    const w = fakeWorld({ targets: ["1", "2"] });
    // 첫 실행이 1번에게 보내고 로그를 남긴 뒤 finalize 전에 죽은 상태를 재현
    w.row.claimed_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    w.logs.push({ messageId: "m1", profileId: "1", status: "sent" });
    expect(await dispatchQueuedMessage(w.deps, "m1")).toEqual({ claimed: false, skipped: "not-claimable" });   // 임대 안(5분 전)이면 아직 못 잡음
    w.row.claimed_at = new Date(Date.now() - CLAIM_LEASE_MS - 1000).toISOString();                             // 임대 만료
    const r = await dispatchQueuedMessage(w.deps, "m1");
    expect(r).toMatchObject({ claimed: true, sent: 1, finalStatus: "sent" });
    expect(w.sends).toEqual(["0102"]);
  });

  it("애드온 미신청 센터는 발송 없이 failed로 확정(기존 규칙 유지)", async () => {
    const w = fakeWorld({ targets: ["1"], addon: false });
    expect(await dispatchQueuedMessage(w.deps, "m1")).toEqual({ claimed: true, skipped: "addon-disabled" });
    expect(w.sends).toHaveLength(0); expect(w.row.status).toBe("failed");
  });

  it("로그 기록이 'duplicate'(다른 실행이 이미 보냄)여도 sent로 센다", async () => {
    const w = fakeWorld({ targets: ["1"] });
    w.logs.push({ messageId: "m1", profileId: "1", status: "sent" });   // loadSentProfileIds가 건너뛰지만, 경합으로 로그가 먼저 생긴 상황은 insertLog가 duplicate로 알린다
    const r = await dispatchQueuedMessage(w.deps, "m1");
    expect(r).toMatchObject({ sent: 0, finalStatus: "sent" });         // 이미 보낸 사람 외에 남은 수신자가 없다
    expect(w.sends).toHaveLength(0);
  });
});
