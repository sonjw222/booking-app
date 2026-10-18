/* TEST4(신규 수업 → 그 자리에서 수강권 구매 → 예약)가 만든 데이터를 "이 실행이 만든 것만" 정리하는 소유권 검증 로직.
   예전 방식: (userA, 고정 이름 상품)의 membership을 전부 payments → memberships 순으로 삭제.
   - reservations를 지우지 않아, 그 수강권을 쓴 예약이 남아 있으면 reservations_membership_id_fkey 위반으로
     beforeAll(= 브라우저 실행 전)에서 실패했다(CI E2E 3/4). 고정 상품이라 과거 실행 잔여물이 계속 걸렸다.
   - 프로필·상품이 같다는 이유만으로 "내 것"이라 보고 지웠다.
   새 방식:
   1) 실행마다 이름에 RUN_SHORT가 든 새 상품을 만든다 → 이전 실행/다른 테스트/실제 데이터가 이 상품의 수강권을 가질 수 없다.
      그래서 시작 시점에는 아무 것도 지우지 않는다(과거 잔여물은 건드리지 않고 남겨 둔다).
   2) 종료 시 소유를 증명한 경우에만 지운다: 상품 이름에 RUN_SHORT · 모든 수강권이 (userA, 실행 시작 이후) · 그 수강권을 참조하는
      예약은 전부 이 실행이 만든 수업의 userA 예약 · 결제는 userA·실행 시작 이후 · 그 밖의 참조 0건이고 조회에 성공.
      하나라도 못 증명하면 아무 것도 삭제하지 않는다(부분 삭제 없음, DB FK를 안전장치로 쓰지 않는다).
   3) 계획(읽기 전용)과 실행을 분리 — 수업을 지워 증거(예약)가 사라지기 전에 계획을 세운다. 삭제 순서: reservations → payments → memberships → product.
      모든 DELETE는 id 외에 소유 조건을 다시 건다. 이 모듈은 DB에 직접 접속하지 않는다(CleanupStore 어댑터). */

export type ProductRow = { id: string; name: string; center_id: string };
export type MembershipRow = { id: string; profile_id: string; product_id: string; created_at: string };
export type ReservationRef = { id: string; class_id: string; membership_id: string; profile_id: string };
export type PaymentRef = { id: string; membership_id: string; profile_id: string; created_at: string };

export interface CleanupStore {
  getProduct(productId: string): Promise<ProductRow | null>;
  membershipsOfProduct(productId: string): Promise<MembershipRow[]>;
  reservationsOf(membershipIds: string[]): Promise<ReservationRef[]>;
  paymentsOf(membershipIds: string[]): Promise<PaymentRef[]>;
  /** 양도/계약/상품권/관리 로그 등 그 밖의 참조 수. 읽을 수 없으면 unverifiable=true. */
  otherReferences(membershipId: string): Promise<{ count: number; unverifiable: boolean }>;
  deleteReservations(ids: string[], ownedClassIds: string[], profileId: string): Promise<void>;
  deletePayments(ids: string[], profileId: string): Promise<void>;
  deleteMemberships(ids: string[], profileId: string, productId: string): Promise<void>;
  /** 상품 삭제가 다른 참조로 막히면 예외 대신 false(호출부가 판매 중지로 대체). */
  deleteProduct(productId: string, name: string, centerId: string): Promise<boolean>;
}

export type RunContext = {
  runShort: string;              // 이 실행의 UUID 앞 8자 — 상품 이름·수업 제목에 들어간다
  profileId: string;             // 구매·예약을 한 테스트 회원 프로필
  centerId: string;
  productId: string;
  ownedClassIds: ReadonlySet<string>;
  runStartedAtMs: number;
};

export type CleanupPlan = {
  deleteReservationIds: string[];
  deletePaymentIds: string[];
  deleteMembershipIds: string[];
  deleteProduct: boolean;
  /** 소유를 증명하지 못한 항목과 사유. 하나라도 있으면 실행 시 아무 것도 삭제하지 않는다. */
  refused: string[];
};

const CLOCK_SKEW_MS = 60_000;
const empty = (): CleanupPlan => ({ deleteReservationIds: [], deletePaymentIds: [], deleteMembershipIds: [], deleteProduct: false, refused: [] });

export function planRunOwnedCleanup(input: {
  ctx: RunContext;
  product: ProductRow | null;
  memberships: MembershipRow[];
  reservations: ReservationRef[];
  payments: PaymentRef[];
  others: Record<string, { count: number; unverifiable: boolean }>;
}): CleanupPlan {
  const { ctx, product, memberships, reservations, payments, others } = input;
  const plan = empty();
  const refuse = (why: string) => { plan.refused.push(why); };

  if (!product) return plan; // 이미 없음 — 지울 것이 없다
  if (product.id !== ctx.productId || product.center_id !== ctx.centerId || !product.name.includes(ctx.runShort)) {
    refuse("상품이 이 실행이 만든 것(이름의 RUN_SHORT·센터)임을 증명할 수 없음");
  }
  const since = ctx.runStartedAtMs - CLOCK_SKEW_MS;
  for (const m of memberships) {
    if (m.product_id !== ctx.productId) refuse(`수강권 ${m.id}의 상품이 다름`);
    else if (m.profile_id !== ctx.profileId) refuse(`수강권 ${m.id}가 이 실행의 테스트 회원 것이 아님(다른 프로필)`);
    else if (Date.parse(m.created_at) < since) refuse(`수강권 ${m.id}가 실행 시작보다 이전에 생성됨`);
  }
  const memIds = new Set(memberships.map((m) => m.id));
  for (const r of reservations.filter((x) => memIds.has(x.membership_id))) {
    if (!ctx.ownedClassIds.has(r.class_id)) refuse(`예약 ${r.id}가 이 실행이 만들지 않은 수업(${r.class_id})에서 이 수강권을 씀`);
    else if (r.profile_id !== ctx.profileId) refuse(`예약 ${r.id}가 다른 프로필의 예약`);
  }
  for (const p of payments.filter((x) => memIds.has(x.membership_id))) {
    if (p.profile_id !== ctx.profileId || Date.parse(p.created_at) < since) refuse(`결제 ${p.id}가 다른 프로필이거나 실행 이전 결제`);
  }
  for (const m of memberships) {
    const o = others[m.id];
    if (!o) refuse(`수강권 ${m.id}의 그 밖의 참조 조회 결과 없음`);
    else if (o.unverifiable) refuse(`수강권 ${m.id}의 참조 테이블 일부를 조회하지 못함(확인 못 한 참조가 있으면 삭제하지 않음)`);
    else if (o.count > 0) refuse(`수강권 ${m.id}에 예약·결제 외 참조 ${o.count}건(양도/계약/상품권/관리 로그)`);
  }
  if (plan.refused.length) return plan; // 부분 삭제 금지
  plan.deleteReservationIds = reservations.filter((x) => memIds.has(x.membership_id)).map((r) => r.id);
  plan.deletePaymentIds = payments.filter((x) => memIds.has(x.membership_id)).map((p) => p.id);
  plan.deleteMembershipIds = memberships.map((m) => m.id);
  plan.deleteProduct = true;
  return plan;
}

/** 1단계(읽기 전용). 이 실행의 수업을 지우기 전에 호출해야 예약(증거)이 남아 있다. */
export async function prepareRunOwnedCleanup(store: CleanupStore, ctx: RunContext): Promise<CleanupPlan> {
  const product = await store.getProduct(ctx.productId);
  const memberships = product ? await store.membershipsOfProduct(ctx.productId) : [];
  const ids = memberships.map((m) => m.id);
  const reservations = ids.length ? await store.reservationsOf(ids) : [];
  const payments = ids.length ? await store.paymentsOf(ids) : [];
  const others: Record<string, { count: number; unverifiable: boolean }> = {};
  for (const id of ids) others[id] = await store.otherReferences(id);
  return planRunOwnedCleanup({ ctx, product, memberships, reservations, payments, others });
}

export type CleanupOutcome = { productDeleted: boolean };

/** 2단계: 계획대로 reservations → payments → memberships → product. 거부된 항목이 있으면 아무 것도 하지 않는다. */
export async function executeRunOwnedCleanup(store: CleanupStore, plan: CleanupPlan, ctx: RunContext): Promise<CleanupOutcome> {
  if (plan.refused.length) return { productDeleted: false };
  const stage = async (what: string, fn: () => Promise<void>) => {
    try { await fn(); }
    catch (e) { throw new Error(`${what} 실패 — 앞 단계는 이 실행이 만든(소유 증명된) 행만 삭제됨, 남은 행은 사람이 확인: ${(e as Error).message}`); }
  };
  if (plan.deleteReservationIds.length) await stage("예약 삭제", () => store.deleteReservations(plan.deleteReservationIds, [...ctx.ownedClassIds], ctx.profileId));
  if (plan.deletePaymentIds.length) await stage("결제 삭제", () => store.deletePayments(plan.deletePaymentIds, ctx.profileId));
  if (plan.deleteMembershipIds.length) await stage("수강권 삭제", () => store.deleteMemberships(plan.deleteMembershipIds, ctx.profileId, ctx.productId));
  let productDeleted = false;
  if (plan.deleteProduct) {
    const product = await store.getProduct(ctx.productId);
    if (product) productDeleted = await store.deleteProduct(ctx.productId, product.name, ctx.centerId);
  }
  return { productDeleted };
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
    async getProduct(id) {
      const { data, error } = await admin.from("products").select("id, name, center_id").eq("id", id).maybeSingle();
      if (error) throw fail("상품 조회 실패", error);
      return (data ?? null) as ProductRow | null;
    },
    async membershipsOfProduct(productId) {
      const { data, error } = await admin.from("memberships").select("id, profile_id, product_id, created_at").eq("product_id", productId);
      if (error) throw fail("수강권 조회 실패", error);
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
        if (error) unverifiable = true; else count += c ?? 0;
      }
      return { count, unverifiable };
    },
    async deleteReservations(ids, classIds, profileId) {
      const { error } = await admin.from("reservations").delete().in("id", ids).in("class_id", classIds).eq("profile_id", profileId);
      if (error) throw fail("예약 삭제 실패", error);
    },
    async deletePayments(ids, profileId) {
      const { error } = await admin.from("payments").delete().in("id", ids).eq("profile_id", profileId);
      if (error) throw fail("결제 삭제 실패", error);
    },
    async deleteMemberships(ids, profileId, productId) {
      const { error } = await admin.from("memberships").delete().in("id", ids).eq("profile_id", profileId).eq("product_id", productId);
      if (error) throw fail("수강권 삭제 실패", error);
    },
    async deleteProduct(productId, name, centerId) {
      const { error } = await admin.from("products").delete().eq("id", productId).eq("name", name).eq("center_id", centerId);
      if (!error) return true;
      // 다른 참조(수업 허용 목록·스케줄 규칙 등)로 막히면 지우지 않고 판매만 중지한다.
      await admin.from("products").update({ is_on_sale: false, is_active: false }).eq("id", productId).eq("name", name).eq("center_id", centerId);
      return false;
    },
  };
}

/** 수업 소유권(#229의 ownsClass를 통합): 제목에 이 실행의 RUN_SHORT가 있고 이 테스트 센터의 수업일 때만 정리 대상. */
export function ownsClass(row: { id: string; title: string; center_id: string }, ctx: { runShort: string; centerId: string }): boolean {
  return row.center_id === ctx.centerId && row.title.includes(ctx.runShort);
}
