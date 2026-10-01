/*
  QA 실행 단위(runId)와 "이번 실행이 만든 데이터만" 정리하는 추적기(순수 로직 + admin client 주입).
  정리는 항상 이 실행이 기록한 UUID 목록으로만 한다 — center_id 하나로 QA 센터 전체를 지우는 방식은 쓰지 않는다.
*/
import type { SupabaseClient } from "@supabase/supabase-js";

export const QA_CENTER_NAME = "[QA] MWHABIT 자동테스트";

export function createRunId(now: Date = new Date(), rand: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);   // YYYYMMDDHHMM
  const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `qa${stamp}-${suffix}`;
}

// 이번 실행이 만든 모든 이름은 "[QA <runId>]"로 시작한다 — 정리 범위를 눈으로도 확인할 수 있게.
export function qaName(runId: string, label: string): string {
  return `[QA ${runId}] ${label}`;
}

export function isQaRunName(name: string | null | undefined, runId: string): boolean {
  return !!name && name.startsWith(`[QA ${runId}]`);
}

// 정리 순서: 예약(→ 대여 사용 기록 cascade/복원 트리거) → 수업 → 결제(payments는 memberships/orders를 참조) → 수강권/상품 보유(memberships)
//            → 주문(orders; member_coupons.order_id는 on delete set null) → 지급 쿠폰(member_coupons) → 쿠폰 적용 대상(coupon_products)
//            → 쿠폰 정의(coupons) → 상품
export type FixtureKind =
  | "reservations" | "classes" | "payments" | "admin_action_logs" | "memberships" | "orders" | "member_coupons" | "coupon_products" | "coupons"
  | "products" | "manager_centers" | "center_roles";
// admin_action_logs.membership_id는 on delete 동작이 없는 FK라 수강권보다 먼저 지운다. 이번 실행이 만든 QA 직원 연결/역할은 맨 끝에 정리한다.
export const CLEANUP_ORDER: FixtureKind[] = [
  "reservations", "classes", "payments", "admin_action_logs", "memberships", "orders", "member_coupons", "coupon_products", "coupons",
  "products", "manager_centers", "center_roles",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FixtureTracker {
  readonly runId: string;
  private ids: Record<FixtureKind, string[]> = {
    reservations: [], classes: [], payments: [], admin_action_logs: [], memberships: [], orders: [], member_coupons: [], coupon_products: [], coupons: [],
    products: [], manager_centers: [], center_roles: [],
  };
  constructor(runId: string) { this.runId = runId; }

  add(kind: FixtureKind, id: string | null | undefined): void {
    if (!id || !UUID_RE.test(id)) return;   // UUID가 아니면 기록하지 않는다(= 정리 대상이 되지 않는다)
    if (!this.ids[kind].includes(id)) this.ids[kind].push(id);
  }

  list(kind: FixtureKind): string[] { return [...this.ids[kind]]; }
  total(): number { return CLEANUP_ORDER.reduce((n, k) => n + this.ids[k].length, 0); }

  // 순서가 보장된 정리 계획. 비어 있으면 아무것도 지우지 않는다.
  plan(): { kind: FixtureKind; ids: string[] }[] {
    return CLEANUP_ORDER.map((kind) => ({ kind, ids: this.list(kind) })).filter((s) => s.ids.length > 0);
  }
}

// 정리 실행: 각 단계의 `.in("id", ids)`로만 삭제. best-effort(한 단계 실패가 나머지를 막지 않음), 실패 목록을 돌려준다.
export async function cleanupFixtures(
  admin: SupabaseClient, tracker: FixtureTracker, opts?: { keep?: boolean }
): Promise<{ deleted: Record<string, number>; failures: string[]; kept: boolean }> {
  if (opts?.keep) return { deleted: {}, failures: [], kept: true };
  const deleted: Record<string, number> = {};
  const failures: string[] = [];
  for (const step of tracker.plan()) {
    const { data, error } = await admin.from(step.kind).delete().in("id", step.ids).select("id");
    if (error) failures.push(`${step.kind}: ${error.message}`);
    deleted[step.kind] = data?.length ?? 0;
  }
  return { deleted, failures, kept: false };
}

// 실패한 fixture 보존 옵션(QA_KEEP_FAILED_FIXTURES=1). 기본은 정리.
export function shouldKeepFailedFixtures(env: Record<string, string | undefined>, failed: boolean): boolean {
  return failed && env.QA_KEEP_FAILED_FIXTURES === "1";
}
