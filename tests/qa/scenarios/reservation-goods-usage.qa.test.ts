/*
  QA 시나리오 1 — 예약 시 대여상품 1회 차감 → 예약 취소 시 1회 복원(add_reservation_goods_usage.sql의 실제 Production 동작).
  - 반드시 별도 명령으로만 실행된다: npm run qa:production:goods (QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK=1 필요).
  - QA 센터([QA] MWHABIT 자동테스트) 안에서만 임시 데이터를 만들고, 이번 실행이 만든 UUID 목록으로만 정리한다.
  - 앱이 실제로 쓰는 경로를 그대로 호출한다: lib/reservations.ts reserveWithGoods → RPC reserve_with_goods, cancelReservation → RPC cancel_reservation.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelReservation, reserveWithGoods } from "../../../lib/reservations";
import { getFixtureAdminClient, signOutTestSession } from "../../integration/setup";
import { bootstrapQa } from "../fixtures/bootstrap";
import { createQaClass, createQaGoodsMembership, createQaPassMembership } from "../fixtures/catalog";
import { cleanupFixtures, createRunId, FixtureTracker, shouldKeepFailedFixtures } from "../runContext";
import type { QaFixtureState } from "../fixtures/center";

const admin = () => getFixtureAdminClient();
const tracker = new FixtureTracker(createRunId());
let state: QaFixtureState;
let classId = "";
let passId = "";
let goodsId = "";
let reservationId = "";
let failed = false;

async function remaining(membershipId: string): Promise<number | null> {
  const { data, error } = await admin().from("memberships").select("remaining_count").eq("id", membershipId).single();
  if (error) throw new Error(`수강권 조회 실패: ${error.message}`);
  return (data as any).remaining_count;
}
async function usageRows() {
  const { data, error } = await admin().from("reservation_goods_usages")
    .select("id, status, goods_membership_id, size_snapshot, product_name_snapshot, restored_at, deducted_at").eq("reservation_id", reservationId);
  if (error) throw new Error(`대여 사용 기록 조회 실패(add_reservation_goods_usage.sql 적용 필요): ${error.message}`);
  return data ?? [];
}

describe("QA: 예약 → 대여상품 차감 → 취소 → 복원", () => {
  beforeAll(async () => {
    ({ state } = await bootstrapQa());   // QA 회원 세션으로 로그인된 상태로 돌아온다
    classId = await createQaClass(admin(), tracker, state.centerId);
    passId = await createQaPassMembership(admin(), tracker, state.centerId, state.memberProfileId, 5);
    ({ membershipId: goodsId } = await createQaGoodsMembership(admin(), tracker, state.centerId, state.memberProfileId, { count: 4, size: "240" }));
  });

  afterAll(async () => {
    const keep = shouldKeepFailedFixtures(process.env, failed);
    const res = await cleanupFixtures(admin(), tracker, { keep });
    if (keep) console.warn(`[QA] QA_KEEP_FAILED_FIXTURES=1 — 실패한 fixture를 보존했어요(runId ${tracker.runId}, ${tracker.total()}개)`);
    if (res.failures.length > 0) console.warn(`[QA] 정리 중 일부 실패: ${res.failures.join(" | ")}`);
    await signOutTestSession();
  });

  const step = (name: string, fn: () => Promise<void>) => it(name, async () => {
    try { await fn(); } catch (e) { failed = true; throw e; }
  });

  step("1. 시작 상태: 대여상품 4회(사이즈 240), 수강권 5회", async () => {
    expect(await remaining(goodsId)).toBe(4);
    expect(await remaining(passId)).toBe(5);
    const { data } = await admin().from("memberships").select("selected_size").eq("id", goodsId).single();
    expect((data as any).selected_size).toBe("240");
  });

  step("2~3. QA 회원 세션으로 수강권 + 대여상품을 함께 선택해 예약(reserve_with_goods)", async () => {
    const status = await reserveWithGoods(classId, state.memberProfileId, passId, goodsId);
    expect(status).toBe("confirmed");
    const { data, error } = await admin().from("reservations").select("id, status")
      .eq("class_id", classId).eq("profile_id", state.memberProfileId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    reservationId = (data as any[])[0].id;
    tracker.add("reservations", reservationId);
    expect((data as any[])[0].status).toBe("confirmed");
  });

  step("4. reservation_goods_usages에 사용 기록(상품명/사이즈 스냅샷, deducted) 생성", async () => {
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "deducted", goods_membership_id: goodsId, size_snapshot: "240" });
    expect(rows[0].deducted_at).not.toBeNull();
  });

  step("5. 대여상품 4 → 3 (수강권도 5 → 4: 기존 수강권 차감 정책 유지)", async () => {
    expect(await remaining(goodsId)).toBe(3);
    expect(await remaining(passId)).toBe(4);
  });

  step("6~8. 같은 QA 회원 세션으로 cancel_reservation → 취소 확인, 대여상품 3 → 4 복원, 수강권 4 → 5", async () => {
    const res = await cancelReservation(reservationId);
    expect(res.deducted).toBe(false);
    const { data } = await admin().from("reservations").select("status").eq("id", reservationId).single();
    expect((data as any).status).toBe("cancelled");
    expect(await remaining(goodsId)).toBe(4);
    expect(await remaining(passId)).toBe(5);
  });

  step("9. 사용 기록 최종 상태 = restored(복원 시각 기록)", async () => {
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("restored");
    expect(rows[0].restored_at).not.toBeNull();
  });

  step("10. 취소를 다시 호출해도 과복원되지 않는다(4 → 5 금지)", async () => {
    await expect(cancelReservation(reservationId)).rejects.toThrow();
    expect(await remaining(goodsId)).toBe(4);
    expect(await remaining(passId)).toBe(5);
    expect((await usageRows())[0].status).toBe("restored");
  });

  step("알림은 QA 센터의 QA 계정에게만 생성된다(일반 사용자에게 fan-out 없음)", async () => {
    const { data: mgr } = await admin().from("manager_centers").select("account_id").eq("center_id", state.centerId).eq("status", "active");
    const allowed = new Set<string>([state.memberAccountId, ...(mgr ?? []).map((m: any) => m.account_id as string)]);
    const { data, error } = await admin().from("notifications").select("recipient_account_id").eq("center_id", state.centerId);
    expect(error).toBeNull();
    for (const n of data ?? []) expect(allowed.has((n as any).recipient_account_id)).toBe(true);
  });
});
