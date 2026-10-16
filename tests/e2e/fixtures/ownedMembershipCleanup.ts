/* E2E가 "이 실행에서 만든" 수강권(구매 테스트로 생긴 membership)만 정리하기 위한 소유권 검증 로직.
   예전 cleanupBuyProductMemberships는 (userA, 상품) 조합의 membership을 전부 찾아 payments → memberships 순으로 지웠다.
   - 이 실행 이전부터 있던 수강권(과거 실행 잔여물이든 사람이 쓰던 것이든)도 같은 조건이면 지워졌고, 그 결제 내역까지 함께 지워졌다.
   - reservations를 지우지 않아, 그 수강권으로 예약된 행이 남아 있으면 reservations_membership_id_fkey 위반으로 실패했다.
   삭제는 "시작 시점에 없었다"만으로는 하지 않는다. 소유를 **적극적으로 증명**한 수강권만 지운다:
     (1) 시작 스냅샷에 없고 실행 시작 이후에 생성됨, (2) 새로 생긴 (profile, product) 수강권이 정확히 1개(2개 이상이면 동시 실행/외부 구매와
     구분할 수 없어 전부 거부), (3) 이 실행의 UUID가 제목에 든 수업의 예약이 그 수강권을 참조함(=이 실행의 예약이 쓴 수강권),
     (4) 그 수강권을 참조하는 예약이 전부 이 실행의 수업에 속함, (5) 결제는 같은 프로필·실행 시작 이후 것뿐, (6) 그 밖의 참조 테이블이
     0건이며 전부 조회에 성공함(조회 못 하면 삭제하지 않음 — DB FK를 보호 장치로 쓰지 않는다).
   하나라도 못 증명하면 아무 것도 삭제하지 않는다(부분 삭제 없음). 계획 수립(read-only)과 실행을 분리해, 수업을 지워 증거(예약)가
   사라지기 전에 계획을 세울 수 있게 했다. 모든 DELETE는 id 외에 소유 조건(수업 목록/프로필/상품)을 다시 건다.
   DB 접근은 CleanupStore 어댑터 뒤에 있고 오프라인 단위 테스트가 메모리 가짜 저장소로 검증한다. 이 모듈 자체는 어떤 DB에도 접속하지 않는다. */

import { assertIsolatedTestDb, type GuardEnv } from "./isolatedTestDbGuard";

export type MembershipRow = { id: string; profile_id: string; product_id: string; created_at: string };
export type ReservationRef = { id: string; class_id: string; membership_id: string; profile_id: string };
export type PaymentRef = { id: string; membership_id: string; profile_id: string; created_at: string };

export interface CleanupStore {
  listMemberships(profileId: string, productId: string): Promise<MembershipRow[]>;
  reservationsOf(membershipIds: string[]): Promise<ReservationRef[]>;
  paymentsOf(membershipIds: string[]): Promise<PaymentRef[]>;
  /** transfers/product_passes/contracts/admin_action_logs 등 그 밖의 참조 수. 읽을 권한이 없어 확인할 수 없으면 unverifiable=true. */
  otherReferences(membershipId: string): Promise<{ count: number; unverifiable: boolean }>;
  /** 삭제는 id 목록에 소유 조건을 다시 건다(수업 목록 / 프로필 / 상품). 조건에 안 맞는 행은 id가 같아도 지워지지 않는다. */
  deleteReservations(ids: string[], ownedClassIds: string[]): Promise<void>;
  deletePayments(ids: string[], profileId: string): Promise<void>;
  deleteMemberships(ids: string[], profileId: string, productId: string): Promise<void>;
}

export type OwnershipContext = {
  runId: string;                       // 이 실행의 UUID(수업 제목에 들어간다)
  profileId: string;
  productId: string;
  preexistingMembershipIds: ReadonlySet<string>; // 실행 시작 시점에 이미 있던 (profile, product) membership id
  ownedClassIds: ReadonlySet<string>;  // 이 실행이 직접 만든 수업 id
  runStartedAtMs: number;
};

export type CleanupPlan = {
  deleteReservationIds: string[];
  deletePaymentIds: string[];
  deleteMembershipIds: string[];
  /** 소유를 증명하지 못해 건드리지 않는 membership과 사유. 하나라도 있으면 실행 시 아무 것도 삭제하지 않는다. */
  refused: { membershipId: string; reason: string }[];
  /** 이 실행 이전부터 있어 건드리지 않는 membership id. */
  untouchedPreexisting: string[];
};

const CLOCK_SKEW_MS = 60_000;

export function planOwnedMembershipCleanup(input: {
  ctx: OwnershipContext;
  memberships: MembershipRow[];
  reservations: ReservationRef[];
  payments: PaymentRef[];
  others: Record<string, { count: number; unverifiable: boolean }>;
}): CleanupPlan {
  const { ctx, memberships, reservations, payments, others } = input;
  const plan: CleanupPlan = { deleteReservationIds: [], deletePaymentIds: [], deleteMembershipIds: [], refused: [], untouchedPreexisting: [] };
  const pair = memberships.filter((m) => m.profile_id === ctx.profileId && m.product_id === ctx.productId);
  const fresh = pair.filter((m) => !ctx.preexistingMembershipIds.has(m.id));
  plan.untouchedPreexisting = pair.filter((m) => ctx.preexistingMembershipIds.has(m.id)).map((m) => m.id);

  // (2) 동시 실행·외부 구매와 구분 불가: 새 수강권이 2개 이상이면 어느 것이 이 실행의 것인지 모르므로 전부 거부.
  if (fresh.length > 1) {
    for (const m of fresh) plan.refused.push({ membershipId: m.id, reason: `새로 생긴 수강권이 ${fresh.length}개 — 이 실행의 것인지 구분할 수 없음(동시 실행/외부 구매 가능)` });
    return plan;
  }
  for (const m of fresh) {
    if (Date.parse(m.created_at) < ctx.runStartedAtMs - CLOCK_SKEW_MS) {
      plan.refused.push({ membershipId: m.id, reason: "스냅샷에는 없지만 실행 시작보다 오래전에 생성됨 — 소유를 증명할 수 없음" });
      continue;
    }
    const mine = reservations.filter((r) => r.membership_id === m.id);
    // (3) 적극적 증명: 이 실행의 수업에서 이 프로필이 한 예약이 이 수강권을 썼다.
    if (!mine.some((r) => ctx.ownedClassIds.has(r.class_id) && r.profile_id === ctx.profileId)) {
      plan.refused.push({ membershipId: m.id, reason: "이 실행의 수업 예약이 이 수강권을 쓴 증거가 없음 — 소유를 증명할 수 없어 삭제하지 않음" });
      continue;
    }
    const foreignRes = mine.filter((r) => !ctx.ownedClassIds.has(r.class_id));
    if (foreignRes.length) { plan.refused.push({ membershipId: m.id, reason: `이 실행이 만들지 않은 수업의 예약 ${foreignRes.length}건이 이 수강권을 참조함` }); continue; }
    const pay = payments.filter((p) => p.membership_id === m.id);
    const foreignPay = pay.filter((p) => p.profile_id !== ctx.profileId || Date.parse(p.created_at) < ctx.runStartedAtMs - CLOCK_SKEW_MS);
    if (foreignPay.length) { plan.refused.push({ membershipId: m.id, reason: `다른 프로필이거나 실행 이전의 결제 ${foreignPay.length}건이 이 수강권을 참조함` }); continue; }
    const o = others[m.id];
    if (!o) { plan.refused.push({ membershipId: m.id, reason: "그 밖의 참조 조회 결과가 없음 — 삭제하지 않음" }); continue; }
    if (o.unverifiable) { plan.refused.push({ membershipId: m.id, reason: "참조 테이블 일부를 조회하지 못함 — 확인하지 못한 참조가 있어 삭제하지 않음(DB FK에 의존하지 않음)" }); continue; }
    if (o.count > 0) { plan.refused.push({ membershipId: m.id, reason: `예약·결제 외 참조 ${o.count}건(양도/상품권/계약/관리 로그 등)` }); continue; }
    plan.deleteReservationIds.push(...mine.map((r) => r.id));
    plan.deletePaymentIds.push(...pay.map((p) => p.id));
    plan.deleteMembershipIds.push(m.id);
  }
  // 부분 삭제 금지: 하나라도 거부되면 삭제 계획 전체를 비운다.
  if (plan.refused.length) { plan.deleteReservationIds = []; plan.deletePaymentIds = []; plan.deleteMembershipIds = []; }
  return plan;
}

/** 1단계(읽기 전용): 소유 증명과 삭제 계획. 수업을 지우기 전에 호출해야 예약(증거)이 남아 있다. */
export async function prepareOwnedMembershipCleanup(store: CleanupStore, ctx: OwnershipContext): Promise<CleanupPlan> {
  const memberships = await store.listMemberships(ctx.profileId, ctx.productId);
  const candidateIds = memberships.filter((m) => !ctx.preexistingMembershipIds.has(m.id)).map((m) => m.id);
  const reservations = candidateIds.length ? await store.reservationsOf(candidateIds) : [];
  const payments = candidateIds.length ? await store.paymentsOf(candidateIds) : [];
  const others: Record<string, { count: number; unverifiable: boolean }> = {};
  for (const id of candidateIds) others[id] = await store.otherReferences(id);
  return planOwnedMembershipCleanup({ ctx, memberships, reservations, payments, others });
}

/** 2단계: 계획대로 reservations → payments → memberships 순으로 삭제. 거부된 항목이 있으면 아무 것도 하지 않는다. */
export async function executeOwnedMembershipCleanup(store: CleanupStore, plan: CleanupPlan, ctx: OwnershipContext): Promise<void> {
  if (plan.refused.length) return;
  const owned = [...ctx.ownedClassIds];
  if (plan.deleteReservationIds.length) await store.deleteReservations(plan.deleteReservationIds, owned);
  if (plan.deletePaymentIds.length) await store.deletePayments(plan.deletePaymentIds, ctx.profileId);
  if (plan.deleteMembershipIds.length) {
    try { await store.deleteMemberships(plan.deleteMembershipIds, ctx.profileId, ctx.productId); }
    catch (e) {
      // 예약·결제는 소유가 증명된 행이라 이미 지워졌어도 이 실행의 테스트 데이터뿐이다. 남은 수강권은 사람이 확인한다.
      throw new Error(`수강권 삭제 실패 — 예약 ${plan.deleteReservationIds.length}건·결제 ${plan.deletePaymentIds.length}건(소유 증명됨)은 이미 삭제됨, 수강권 ${plan.deleteMembershipIds.join(",")}은 남음: ${(e as Error).message}`);
    }
  }
}

/** 편의 함수(계획+실행). 수업 삭제와 순서가 얽힌 호출부는 prepare/execute를 따로 쓴다. */
export async function runOwnedMembershipCleanup(store: CleanupStore, ctx: OwnershipContext): Promise<CleanupPlan> {
  const plan = await prepareOwnedMembershipCleanup(store, ctx);
  await executeOwnedMembershipCleanup(store, plan, ctx);
  return plan;
}

/** 수업 소유권: 제목에 이 실행의 UUID 조각이 있고 이 테스트 센터의 수업일 때만 정리 대상. */
export function ownsClass(row: { id: string; title: string; center_id: string }, ctx: { runShort: string; centerId: string }): boolean {
  return row.center_id === ctx.centerId && row.title.includes(ctx.runShort);
}

/** Supabase(service role) 어댑터 — 실제 실행은 E2E에서만 일어난다. 테이블 이름은 schema.sql 기준. */
type AdminLike = { from: (table: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const OTHER_REF_TABLES: [string, string][] = [
  ["membership_transfers", "membership_id"], ["product_passes", "linked_membership_id"], ["contracts", "membership_id"],
  ["admin_action_logs", "membership_id"], ["admin_action_logs", "source_unassigned_id"],
];

export function makeSupabaseStore(admin: AdminLike, env: GuardEnv = process.env): CleanupStore {
  assertIsolatedTestDb(env); // 어댑터를 만드는 순간 격리 DB 확인 — 공유 DEV/Production이면 삭제 함수가 존재하지 않는다

  const fail = (what: string, e: { message: string }) => new Error(`${what}: ${e.message}`);
  return {
    async listMemberships(profileId, productId) {
      const { data, error } = await admin.from("memberships").select("id, profile_id, product_id, created_at").eq("profile_id", profileId).eq("product_id", productId);
      if (error) throw fail("membership 조회 실패", error);
      return (data ?? []) as MembershipRow[];
    },
    async reservationsOf(ids) {
      const { data, error } = await admin.from("reservations").select("id, class_id, membership_id, profile_id").in("membership_id", ids);
      if (error) throw fail("예약 참조 조회 실패", error);
      return (data ?? []) as ReservationRef[];
    },
    async paymentsOf(ids) {
      const { data, error } = await admin.from("payments").select("id, membership_id, profile_id, created_at").in("membership_id", ids);
      if (error) throw fail("결제 참조 조회 실패", error);
      return (data ?? []) as PaymentRef[];
    },
    async otherReferences(membershipId) {
      let count = 0; let unverifiable = false;
      for (const [table, col] of OTHER_REF_TABLES) {
        const { count: c, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(col, membershipId);
        if (error) unverifiable = true; // 읽기 권한 없음(GRANT gap) 등 — 확인 불가 → 계획 단계에서 삭제 거부
        else count += c ?? 0;
      }
      return { count, unverifiable };
    },
    async deleteReservations(ids, classIds) { const { error } = await admin.from("reservations").delete().in("id", ids).in("class_id", classIds); if (error) throw fail("예약 삭제 실패", error); },
    async deletePayments(ids, profileId) { const { error } = await admin.from("payments").delete().in("id", ids).eq("profile_id", profileId); if (error) throw fail("결제 삭제 실패", error); },
    async deleteMemberships(ids, profileId, productId) { const { error } = await admin.from("memberships").delete().in("id", ids).eq("profile_id", profileId).eq("product_id", productId); if (error) throw fail("membership 삭제 실패(FK 참조 가능)", error); },
  };
}
