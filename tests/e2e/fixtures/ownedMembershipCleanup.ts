/* E2E가 "이 실행에서 만든" 수강권(구매 테스트로 생긴 membership)만 정리하기 위한 소유권 검증 로직.
   예전 cleanupBuyProductMemberships는 (userA, 상품) 조합의 membership을 전부 찾아 payments → memberships 순으로 지웠다.
   - 이 실행 이전부터 있던 수강권(과거 실행 잔여물이든 사람이 쓰던 것이든)도 같은 조건이면 지워졌고, 그 결제 내역까지 함께 지워졌다.
   - reservations를 지우지 않아, 그 수강권으로 예약된 행이 남아 있으면 reservations_membership_id_fkey 위반으로 실패했다.
   여기서는 (1) 실행 시작 시점의 id 스냅샷에 없던 membership만 "소유"로 보고, (2) 이 실행이 만든 수업(UUID가 든 제목으로 식별)의
   예약만 함께 지우며, (3) 그 밖의 참조가 하나라도 있으면 그 membership은 건드리지 않고 거부한다.
   순수 판단(planOwnedMembershipCleanup)과 실행(runOwnedMembershipCleanup)을 분리했고, DB 접근은 CleanupStore 어댑터 뒤에 둬서
   오프라인 단위 테스트(tests/unit/ownedMembershipCleanup.test.ts)가 메모리 가짜 저장소로 검증한다. 이 모듈은 어떤 DB에도 접속하지 않는다. */

export type MembershipRow = { id: string; profile_id: string; product_id: string; created_at: string };
export type ReservationRef = { id: string; class_id: string; membership_id: string };
export type PaymentRef = { id: string; membership_id: string };

export interface CleanupStore {
  listMemberships(profileId: string, productId: string): Promise<MembershipRow[]>;
  reservationsOf(membershipIds: string[]): Promise<ReservationRef[]>;
  paymentsOf(membershipIds: string[]): Promise<PaymentRef[]>;
  /** transfers/product_passes/contracts/admin_action_logs 등 그 밖의 참조 수. 읽을 권한이 없어 확인할 수 없으면 unverifiable=true. */
  otherReferences(membershipId: string): Promise<{ count: number; unverifiable: boolean }>;
  deleteReservations(ids: string[]): Promise<void>;
  deletePayments(ids: string[]): Promise<void>;
  deleteMemberships(ids: string[]): Promise<void>;
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
  /** 건드리지 않는 membership과 사유. */
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

  for (const m of memberships) {
    if (m.profile_id !== ctx.profileId || m.product_id !== ctx.productId) continue; // 대상 조합이 아니면 무시
    if (ctx.preexistingMembershipIds.has(m.id)) { plan.untouchedPreexisting.push(m.id); continue; }
    if (Date.parse(m.created_at) < ctx.runStartedAtMs - CLOCK_SKEW_MS) {
      plan.refused.push({ membershipId: m.id, reason: "스냅샷에는 없지만 실행 시작보다 오래전에 생성됨 — 소유를 증명할 수 없음" });
      continue;
    }
    const foreignRes = reservations.filter((r) => r.membership_id === m.id && !ctx.ownedClassIds.has(r.class_id));
    if (foreignRes.length) {
      plan.refused.push({ membershipId: m.id, reason: `이 실행이 만들지 않은 수업의 예약 ${foreignRes.length}건이 이 수강권을 참조함` });
      continue;
    }
    const o = others[m.id];
    if (o && o.count > 0) {
      plan.refused.push({ membershipId: m.id, reason: `예약·결제 외 참조 ${o.count}건(양도/상품권/계약/관리 로그 등)` });
      continue;
    }
    plan.deleteReservationIds.push(...reservations.filter((r) => r.membership_id === m.id).map((r) => r.id));
    plan.deletePaymentIds.push(...payments.filter((p) => p.membership_id === m.id).map((p) => p.id));
    plan.deleteMembershipIds.push(m.id);
  }
  return plan;
}

export type CleanupResult = CleanupPlan & { unverifiableMembershipIds: string[] };

/** 소유를 증명한 것만 reservations → payments → memberships 순으로 삭제한다. 거부된 membership은 건드리지 않고 결과(refused)로 돌려준다. */
export async function runOwnedMembershipCleanup(store: CleanupStore, ctx: OwnershipContext): Promise<CleanupResult> {
  const memberships = await store.listMemberships(ctx.profileId, ctx.productId);
  const candidateIds = memberships.filter((m) => !ctx.preexistingMembershipIds.has(m.id)).map((m) => m.id);
  const reservations = candidateIds.length ? await store.reservationsOf(candidateIds) : [];
  const payments = candidateIds.length ? await store.paymentsOf(candidateIds) : [];
  const others: Record<string, { count: number; unverifiable: boolean }> = {};
  for (const id of candidateIds) others[id] = await store.otherReferences(id);
  const plan = planOwnedMembershipCleanup({ ctx, memberships, reservations, payments, others });
  const unverifiableMembershipIds = plan.deleteMembershipIds.filter((id) => others[id]?.unverifiable);

  if (plan.deleteReservationIds.length) await store.deleteReservations(plan.deleteReservationIds);
  if (plan.deletePaymentIds.length) await store.deletePayments(plan.deletePaymentIds);
  if (plan.deleteMembershipIds.length) await store.deleteMemberships(plan.deleteMembershipIds); // 확인 못 한 참조는 DB FK가 최종 방어선
  return { ...plan, unverifiableMembershipIds };
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

export function makeSupabaseStore(admin: AdminLike): CleanupStore {
  const fail = (what: string, e: { message: string }) => new Error(`${what}: ${e.message}`);
  return {
    async listMemberships(profileId, productId) {
      const { data, error } = await admin.from("memberships").select("id, profile_id, product_id, created_at").eq("profile_id", profileId).eq("product_id", productId);
      if (error) throw fail("membership 조회 실패", error);
      return (data ?? []) as MembershipRow[];
    },
    async reservationsOf(ids) {
      const { data, error } = await admin.from("reservations").select("id, class_id, membership_id").in("membership_id", ids);
      if (error) throw fail("예약 참조 조회 실패", error);
      return (data ?? []) as ReservationRef[];
    },
    async paymentsOf(ids) {
      const { data, error } = await admin.from("payments").select("id, membership_id").in("membership_id", ids);
      if (error) throw fail("결제 참조 조회 실패", error);
      return (data ?? []) as PaymentRef[];
    },
    async otherReferences(membershipId) {
      let count = 0; let unverifiable = false;
      for (const [table, col] of OTHER_REF_TABLES) {
        const { count: c, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(col, membershipId);
        if (error) unverifiable = true; // 읽기 권한 없음(GRANT gap) 등 — 확인 불가로 기록, 삭제는 DB FK가 막는다
        else count += c ?? 0;
      }
      return { count, unverifiable };
    },
    async deleteReservations(ids) { const { error } = await admin.from("reservations").delete().in("id", ids); if (error) throw fail("예약 삭제 실패", error); },
    async deletePayments(ids) { const { error } = await admin.from("payments").delete().in("id", ids); if (error) throw fail("결제 삭제 실패", error); },
    async deleteMemberships(ids) { const { error } = await admin.from("memberships").delete().in("id", ids); if (error) throw fail("membership 삭제 실패(FK 참조 가능)", error); },
  };
}
