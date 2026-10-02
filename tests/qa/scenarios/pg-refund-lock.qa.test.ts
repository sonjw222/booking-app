/*
  Production QA 후보(실행 금지 — 별도 승인 후에만) — PG 환불 진행 표시(pg_refund_started_at)와 예약 동시성.
  실행 후보: npm run qa:production:pg-refund-lock (QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK=1 필요). fix_pg_payment_lifecycle.sql 적용 후에만 의미가 있다.
  - 이 환경(로컬 Postgres/Docker 없음, PostgREST로는 트랜잭션을 열어 두고 기다릴 수 없음)에서는 "예약 트랜잭션이 잠금을 잡은 채 대기"하는 시나리오를 재현할 수 없어,
    순차 시나리오(결정적)와 병렬 불변식 검증(통계적)으로 대체한다: 병렬 N회 후 "환불 표시가 걸렸는데 활성 예약도 존재"하는 수강권이 단 하나도 없어야 한다.
  - QA 센터/QA 회원만 사용하고, 이번 실행이 만든 UUID(예약/수업/수강권)로만 정리한다. 토스는 호출하지 않는다(DB 함수만).
  - pg_refund_begin/release는 service_role 전용이라 fixture admin client로 호출한다(p_auth_uid = QA 회원의 auth id).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFixtureAdminClient, signOutTestSession } from "../../integration/setup";
import { bootstrapQa } from "../fixtures/bootstrap";
import { createQaClass, createQaPassMembership } from "../fixtures/catalog";
import { cleanupFixtures, createRunId, FixtureTracker, qaName, shouldKeepFailedFixtures } from "../runContext";
import type { QaFixtureState } from "../fixtures/center";

const admin = () => getFixtureAdminClient();
const tracker = new FixtureTracker(createRunId());
let state: QaFixtureState;
let authUid = "";
let failed = false;

const begin = async (membershipId: string) => {
  const { data, error } = await admin().rpc("pg_refund_begin", { p_membership_id: membershipId, p_auth_uid: authUid });
  if (error) throw new Error(error.message);
  return (data as { state: string; reason?: string });
};
const release = (membershipId: string) => admin().rpc("pg_refund_release", { p_membership_id: membershipId, p_auth_uid: authUid });

async function unlimitedMembership(): Promise<string> {
  const { data, error } = await admin().from("memberships").insert({
    profile_id: state.memberProfileId, center_id: state.centerId, product_name: qaName(tracker.runId, "무제한 수강권"), pass_type: "period",
    total_count: null, remaining_count: null, starts_at: new Date().toISOString().slice(0, 10), expires_at: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), status: "active",
  }).select("id").single();
  if (error || !data) throw new Error(`무제한 수강권 생성 실패: ${error?.message}`);
  tracker.add("memberships", data.id);
  return data.id as string;
}
async function addReservation(classId: string, membershipId: string, status: string) {
  const r = await admin().from("reservations").insert({ class_id: classId, profile_id: state.memberProfileId, membership_id: membershipId, status });
  return r;
}
async function reservationId(classId: string, membershipId: string): Promise<string> {
  const { data } = await admin().from("reservations").select("id").eq("class_id", classId).eq("membership_id", membershipId).single();
  tracker.add("reservations", (data as any).id);
  return (data as any).id as string;
}

describe("QA(후보): PG 환불 진행 표시와 예약", () => {
  beforeAll(async () => {
    ({ state } = await bootstrapQa());
    const { data, error } = await admin().from("accounts").select("auth_id").eq("id", state.memberAccountId).single();
    if (error || !(data as any)?.auth_id) throw new Error(`QA 회원 auth id 조회 실패: ${error?.message}`);
    authUid = (data as any).auth_id;
  });
  afterAll(async () => {
    const keep = shouldKeepFailedFixtures(process.env, failed);
    for (const id of tracker.list("memberships")) await release(id);   // 표시 해제(삭제 전 정리)
    const res = await cleanupFixtures(admin(), tracker, { keep });
    if (res.failures.length > 0) console.warn(`[QA] 정리 중 일부 실패: ${res.failures.join(" | ")}`);
    await signOutTestSession();
  });
  const step = (name: string, fn: () => Promise<void>) => it(name, async () => { try { await fn(); } catch (e) { failed = true; throw e; } });

  step("begin이 먼저 표시를 걸면 새 예약(INSERT)이 거부된다(횟수권/무제한권 모두), release하면 다시 가능", async () => {
    for (const make of [() => createQaPassMembership(admin(), tracker, state.centerId, state.memberProfileId, 5), unlimitedMembership]) {
      const mem = await make();
      const cls = await createQaClass(admin(), tracker, state.centerId);
      expect((await begin(mem)).state).toBe("locked");
      const blocked = await addReservation(cls, mem, "confirmed");
      expect(blocked.error?.message ?? "").toContain("환불 처리 중");
      await release(mem);
      expect((await addReservation(cls, mem, "confirmed")).error).toBeNull();
      await reservationId(cls, mem);
    }
  });

  step("표시 중에는 기존 waitlisted 예약의 확정 승격과 취소된 예약의 복구도 거부, cancelled로 가는 변경은 허용", async () => {
    const mem = await unlimitedMembership();
    const cls = await createQaClass(admin(), tracker, state.centerId);
    expect((await addReservation(cls, mem, "cancelled")).error).toBeNull();   // 취소 상태 예약은 환불을 막지 않는다
    const rid = await reservationId(cls, mem);
    expect((await begin(mem)).state).toBe("locked");
    const revive = await admin().from("reservations").update({ status: "confirmed" }).eq("id", rid);
    expect(revive.error?.message ?? "").toContain("환불 처리 중");
    await release(mem);
    // 이미 존재하던 waitlisted 행의 승격: begin은 활성 대기가 있으면 blocked라 정상 흐름에서는 공존하지 않지만, 경합으로 표시가 먼저 걸린
    // 상황을 service_role로 직접 만들어(JWT 없음 → 표시 직접 변경 허용) 트리거만 검증한다.
    const mem2 = await unlimitedMembership();
    const cls2 = await createQaClass(admin(), tracker, state.centerId);
    expect((await addReservation(cls2, mem2, "waitlisted")).error).toBeNull();
    const rid2 = await reservationId(cls2, mem2);
    await admin().from("memberships").update({ pg_refund_started_at: new Date().toISOString() }).eq("id", mem2);
    const promote = await admin().from("reservations").update({ status: "confirmed" }).eq("id", rid2);
    expect(promote.error?.message ?? "").toContain("환불 처리 중");
    const cancel = await admin().from("reservations").update({ status: "cancelled" }).eq("id", rid2);   // 취소 전환은 허용
    expect(cancel.error).toBeNull();
    await release(mem2);
  });

  step("미사용 판정: 취소 예약만 있으면 환불 가능(locked), 활성 대기/무제한 확정 예약이 있으면 blocked", async () => {
    const onlyCancelled = await createQaPassMembership(admin(), tracker, state.centerId, state.memberProfileId, 5);
    const c1 = await createQaClass(admin(), tracker, state.centerId);
    await addReservation(c1, onlyCancelled, "cancelled"); await reservationId(c1, onlyCancelled);
    expect((await begin(onlyCancelled)).state).toBe("locked");
    await release(onlyCancelled);

    const waitlisted = await createQaPassMembership(admin(), tracker, state.centerId, state.memberProfileId, 5);
    const c2 = await createQaClass(admin(), tracker, state.centerId);
    await addReservation(c2, waitlisted, "waitlisted"); await reservationId(c2, waitlisted);
    expect((await begin(waitlisted)).state).toBe("blocked");

    const unlimitedConfirmed = await unlimitedMembership();
    const c3 = await createQaClass(admin(), tracker, state.centerId);
    await addReservation(c3, unlimitedConfirmed, "confirmed"); await reservationId(c3, unlimitedConfirmed);
    const b = await begin(unlimitedConfirmed);
    expect(b.state).toBe("blocked");
    expect(b.reason).toContain("예약 중이거나 이용한");
  });

  step("병렬 경합 불변식: begin과 예약 INSERT를 동시에 N회 실행해도 '환불 표시 + 활성 예약'이 함께 존재하는 수강권은 없다", async () => {
    const N = 8;
    for (let i = 0; i < N; i++) {
      const mem = await unlimitedMembership();
      const cls = await createQaClass(admin(), tracker, state.centerId);
      await Promise.allSettled([begin(mem), addReservation(cls, mem, "confirmed")]);
      const { data: m } = await admin().from("memberships").select("pg_refund_started_at").eq("id", mem).single();
      const { data: rs } = await admin().from("reservations").select("id, status").eq("class_id", cls).eq("membership_id", mem);
      for (const r of rs ?? []) tracker.add("reservations", (r as any).id);
      const locked = (m as any).pg_refund_started_at != null;
      const active = (rs ?? []).some((r: any) => ["confirmed", "waitlisted", "attended", "no_show"].includes(r.status));
      expect(locked && active).toBe(false);
      await release(mem);
    }
  });
});
