/*
  MWHABIT Membership Visibility + Member Coupon Batch(2026-09-18)
  - 매니저: 쿠폰 정의(coupons) 생성/보관, 회원에게 지급(RPC), 회수(RPC), 지급/사용 현황 조회
  - 회원: 내 쿠폰 조회, 특정 상품에 실제로 쓸 수 있는 쿠폰만 필터링

  ⚠ 클라이언트에서 하는 계산(fetchApplicableCoupons의 최소금액/유효기간/적용대상 필터)은
  전부 UX 편의용이다 — 실제 최종 검증과 할인금액 계산은 항상 서버
  (_issue_membership_and_record_payment(), add_membership_visibility_and_coupons.sql)가
  다시 한다. 여기서 뭘 숨기거나 보여주든 구매 자체의 안전에는 영향 없다.
*/

import { supabase } from "./supabaseClient";

export type DiscountType = "fixed" | "percentage";
export type CouponAppliesTo = "all" | "selected";
export type MemberCouponStatus = "available" | "used" | "expired" | "revoked";

export type Coupon = {
  id: string;
  centerId: string;
  name: string;
  discountType: DiscountType;
  discountValue: number;
  maxDiscountAmount: number | null;
  minimumOrderAmount: number | null;
  appliesTo: CouponAppliesTo;
  validFrom: string | null;
  validUntil: string | null;
  status: "active" | "archived";
  createdAt: string;
  issuedCount: number;
  usedCount: number;
};

export type MemberCoupon = {
  id: string;
  couponId: string;
  couponName: string;
  discountType: DiscountType;
  discountValue: number;
  maxDiscountAmount: number | null;
  minimumOrderAmount: number | null;
  appliesTo: CouponAppliesTo;
  status: MemberCouponStatus;
  issuedAt: string;
  usedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  centerId: string;
  centerName: string;
  /** appliesTo="selected"일 때 적용 대상 수강권 id(서버 함수 my_member_coupons 가 내 쿠폰 것만 돌려준다) */
  productIds: string[];
};

// ---------------- 매니저: 쿠폰 정의 ----------------

export async function fetchCoupons(centerId: string): Promise<Coupon[]> {
  const { data, error } = await supabase
    .from("coupons")
    .select("id, center_id, name, discount_type, discount_value, max_discount_amount, minimum_order_amount, applies_to, valid_from, valid_until, status, created_at")
    .eq("center_id", centerId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("쿠폰을 불러오지 못했어요: " + error.message);
  const rows = data ?? [];
  const ids = rows.map((c: any) => c.id);

  // 지급/사용 인원 집계 — 쿠폰마다 따로 조회하지 않고 한 번에(요청 23번 N+1 방지)
  const issuedByCoupon: Record<string, number> = {};
  const usedByCoupon: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: mcRows, error: mcErr } = await supabase
      .from("member_coupons")
      .select("coupon_id, status")
      .in("coupon_id", ids);
    if (mcErr) throw new Error("쿠폰 지급 현황을 불러오지 못했어요: " + mcErr.message);
    for (const mc of mcRows ?? []) {
      const cid = (mc as any).coupon_id;
      issuedByCoupon[cid] = (issuedByCoupon[cid] ?? 0) + 1;
      if ((mc as any).status === "used") usedByCoupon[cid] = (usedByCoupon[cid] ?? 0) + 1;
    }
  }

  return rows.map((c: any) => ({
    id: c.id, centerId: c.center_id, name: c.name,
    discountType: c.discount_type, discountValue: c.discount_value,
    maxDiscountAmount: c.max_discount_amount, minimumOrderAmount: c.minimum_order_amount,
    appliesTo: c.applies_to, validFrom: c.valid_from, validUntil: c.valid_until,
    status: c.status, createdAt: c.created_at,
    issuedCount: issuedByCoupon[c.id] ?? 0,
    usedCount: usedByCoupon[c.id] ?? 0,
  }));
}

export async function createCoupon(centerId: string, input: {
  name: string; discountType: DiscountType; discountValue: number;
  maxDiscountAmount?: number | null; minimumOrderAmount?: number | null;
  appliesTo: CouponAppliesTo; productIds?: string[];
  validFrom?: string | null; validUntil?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.from("coupons").insert({
    center_id: centerId, name: input.name,
    discount_type: input.discountType, discount_value: input.discountValue,
    max_discount_amount: input.maxDiscountAmount ?? null,
    minimum_order_amount: input.minimumOrderAmount ?? null,
    applies_to: input.appliesTo,
    valid_from: input.validFrom ?? null, valid_until: input.validUntil ?? null,
    status: "active",
  }).select("id").single();
  if (error || !data) throw new Error("쿠폰 생성에 실패했어요: " + (error?.message ?? "no data"));

  if (input.appliesTo === "selected" && input.productIds && input.productIds.length > 0) {
    // coupon_products RLS("매니저 쿠폰적용대상 관리")가 이 센터 소속이 아닌 상품을
    // 넣으려는 시도를 서버에서 거부한다(다른 센터 수강권은 선택 불가 — 요청 12번).
    const { error: cpErr } = await supabase.from("coupon_products").insert(
      input.productIds.map((productId) => ({ coupon_id: (data as any).id, product_id: productId }))
    );
    if (cpErr) throw new Error("쿠폰 적용 대상 저장에 실패했어요: " + cpErr.message);
  }
  return (data as any).id;
}

export async function fetchCouponProductIds(couponId: string): Promise<string[]> {
  const { data, error } = await supabase.from("coupon_products").select("product_id").eq("coupon_id", couponId);
  if (error) throw new Error("쿠폰 적용 대상을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => r.product_id);
}

// 아직 사용되지 않은 쿠폰 "정의"를 보관(archived) 처리 — 이미 지급된 member_coupons는
// 건드리지 않는다(요청 7번과 동일한 원칙: 과거 지급/구매에는 영향 없음, 앞으로 새로
// 지급만 막힘 — coupons.status='active' 조건이 issue_coupon_to_members RPC에서 이미
// 강제됨).
export async function archiveCoupon(couponId: string): Promise<void> {
  const { error } = await supabase.from("coupons").update({ status: "archived" }).eq("id", couponId);
  if (error) throw new Error("쿠폰 보관에 실패했어요: " + error.message);
}

// ---------------- 매니저: 지급/회수 ----------------

export async function issueCouponToMembers(
  couponId: string, centerMemberIds: string[]
): Promise<{ issuedCount: number; skippedCount: number }> {
  const { data, error } = await supabase.rpc("issue_coupon_to_members", {
    p_coupon_id: couponId, p_center_member_ids: centerMemberIds,
  });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
  return { issuedCount: (data as any)?.issued_count ?? 0, skippedCount: (data as any)?.skipped_count ?? 0 };
}

export async function revokeMemberCoupon(memberCouponId: string): Promise<void> {
  const { error } = await supabase.rpc("revoke_member_coupon", { p_member_coupon_id: memberCouponId });
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ""));
}

export type IssuedMemberCoupon = {
  id: string;
  memberName: string;
  memberPhone: string | null;
  status: MemberCouponStatus;
  issuedAt: string;
  usedAt: string | null;
};

// 특정 쿠폰의 지급 대상/상태 상세(요청 20번 "쿠폰 상세")
export async function fetchIssuedMemberCoupons(couponId: string): Promise<IssuedMemberCoupon[]> {
  const { data, error } = await supabase
    .from("member_coupons")
    .select("id, status, issued_at, used_at, center_members(profiles(name, accounts(phone)))")
    .eq("coupon_id", couponId)
    .order("issued_at", { ascending: false });
  if (error) throw new Error("지급 내역을 불러오지 못했어요: " + error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    status: r.status,
    issuedAt: r.issued_at,
    usedAt: r.used_at,
    memberName: r.center_members?.profiles?.name ?? "이름없음",
    memberPhone: r.center_members?.profiles?.accounts?.phone ?? null,
  }));
}

// ---------------- 회원: 내 쿠폰 ----------------

// 내게 지급된 쿠폰 — 서버 함수 my_member_coupons()(내 center_members 의 member_coupons 와 그 정의·적용 상품만 반환).
// 예전에는 member_coupons 에 coupons(...)를 임베드했는데 회원은 coupons 를 읽을 수 없어 임베드가 null 이 되고 앱이 그 행을 걸러내
// 지급된 쿠폰이 "없는 것처럼" 보였다(감사 F01). 정상 빈 목록과 권한·네트워크 오류는 구분한다: 오류는 던진다.
export async function fetchMyCoupons(): Promise<MemberCoupon[]> {
  const { data, error } = await supabase.rpc("my_member_coupons");
  if (error) {
    const missing = error.code === "PGRST202" || error.code === "42883" || /Could not find the function/i.test(error.message ?? "");
    throw new Error(missing ? "쿠폰 조회 기능을 아직 사용할 수 없어요. 앱/서버 업데이트 후 다시 시도해 주세요." : "내 쿠폰을 불러오지 못했어요: " + error.message);
  }
  return ((data ?? []) as MyCouponRow[]).map(rowToMemberCoupon);
}

type MyCouponRow = {
  id: string; status: MemberCouponStatus; issued_at: string; used_at: string | null; coupon_id: string; name: string;
  center_id: string; center_name: string | null; discount_type: DiscountType; discount_value: number; max_discount_amount: number | null;
  minimum_order_amount: number | null; applies_to: CouponAppliesTo; valid_from: string | null; valid_until: string | null; product_ids: string[] | null;
};
export function rowToMemberCoupon(r: MyCouponRow): MemberCoupon {
  return {
    id: r.id, couponId: r.coupon_id, couponName: r.name, discountType: r.discount_type, discountValue: r.discount_value,
    maxDiscountAmount: r.max_discount_amount, minimumOrderAmount: r.minimum_order_amount, appliesTo: r.applies_to,
    status: r.status, issuedAt: r.issued_at, usedAt: r.used_at, validFrom: r.valid_from, validUntil: r.valid_until,
    centerId: r.center_id, centerName: r.center_name ?? "센터", productIds: r.product_ids ?? [],
  };
}

export type CouponIneligibleReason = "not_available" | "other_center" | "not_started" | "expired" | "min_amount" | "other_product";

/** 이 쿠폰을 이 상품·이 센터에서 지금 쓸 수 있는지. 서버 _order_expected_amount 의 자격 검사와 같은 조건이다
 *  (본인 소유·센터 일치·available·시작/종료 시각·적용 상품·최소 금액). 판정은 UX 편의이고 최종 판단은 항상 서버다(F05). */
export function evaluateCoupon(c: MemberCoupon, ctx: { productId: string; price: number; centerId: string; now?: Date }): { ok: true } | { ok: false; reason: CouponIneligibleReason } {
  const now = ctx.now ?? new Date();
  if (c.status !== "available") return { ok: false, reason: "not_available" };
  if (c.centerId !== ctx.centerId) return { ok: false, reason: "other_center" };
  if (c.validFrom && now < new Date(c.validFrom)) return { ok: false, reason: "not_started" };
  if (c.validUntil && now > new Date(c.validUntil)) return { ok: false, reason: "expired" };
  if (c.appliesTo === "selected" && !c.productIds.includes(ctx.productId)) return { ok: false, reason: "other_product" };
  if (c.minimumOrderAmount != null && ctx.price < c.minimumOrderAmount) return { ok: false, reason: "min_amount" };
  return { ok: true };
}

// 특정 상품 구매 화면에서 "실제로 지금 쓸 수 있는" 쿠폰만 골라준다. 서버 재검증과는 별개의 UX 편의 필터 — 최종 자격/금액은 결제 확정 RPC가 다시 계산한다.
export async function fetchApplicableCoupons(productId: string, productPrice: number, centerId: string): Promise<MemberCoupon[]> {
  const all = await fetchMyCoupons();
  return all.filter((c) => evaluateCoupon(c, { productId, price: productPrice, centerId }).ok);
}

// 클라이언트 미리보기용 할인 계산(서버와 동일한 공식 — 최종 확정 금액은 항상 서버가
// 다시 계산하므로, 여기서 값이 어긋나도 결제 안전에는 영향 없다. 단지 결제 전 화면에
// "예상 최종 결제금액"을 보여주기 위한 것).
export function previewDiscount(price: number, coupon: Pick<MemberCoupon, "discountType" | "discountValue" | "maxDiscountAmount">): number {
  if (coupon.discountType === "fixed") return Math.min(coupon.discountValue, price);
  const raw = Math.floor((price * coupon.discountValue) / 100);
  return Math.min(raw, coupon.maxDiscountAmount ?? price);
}
