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
  validUntil: string | null;
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

// "내 쿠폰 조회" RLS(member_coupons for select, center_member_id in my profiles' rows)가
// 다른 회원 쿠폰을 원천적으로 안 보여준다 — 이 함수는 그 위에 얇게 얹혀 있을 뿐.
export async function fetchMyCoupons(): Promise<MemberCoupon[]> {
  const { data, error } = await supabase
    .from("member_coupons")
    .select("id, status, issued_at, used_at, coupons(id, name, discount_type, discount_value, max_discount_amount, minimum_order_amount, applies_to, valid_until)")
    .order("issued_at", { ascending: false });
  if (error) throw new Error("내 쿠폰을 불러오지 못했어요: " + error.message);
  return (data ?? [])
    .filter((r: any) => r.coupons) // 쿠폰 정의가 삭제된 고아 행 방어(현재 스키마상 cascade라 이론상 없음)
    .map((r: any) => ({
      id: r.id,
      couponId: r.coupons.id,
      couponName: r.coupons.name,
      discountType: r.coupons.discount_type,
      discountValue: r.coupons.discount_value,
      maxDiscountAmount: r.coupons.max_discount_amount,
      minimumOrderAmount: r.coupons.minimum_order_amount,
      appliesTo: r.coupons.applies_to,
      status: r.status,
      issuedAt: r.issued_at,
      usedAt: r.used_at,
      validUntil: r.coupons.valid_until,
    }));
}

// 특정 상품 구매 화면에서 "실제로 지금 쓸 수 있는" 쿠폰만 골라준다(available + 유효기간
// + 최소결제금액 + 적용대상). 서버 재검증(요청 16번)과는 별개의 UX 편의 필터 — 여기서
// 뭘 보여주든 최종 자격/금액은 결제 확정 RPC가 다시 계산한다.
export async function fetchApplicableCoupons(productId: string, productPrice: number): Promise<MemberCoupon[]> {
  const all = await fetchMyCoupons();
  const now = new Date();
  const candidates = all.filter((c) =>
    c.status === "available" &&
    (!c.validUntil || new Date(c.validUntil) >= now) &&
    (c.minimumOrderAmount == null || productPrice >= c.minimumOrderAmount)
  );

  const selectedCandidates = candidates.filter((c) => c.appliesTo === "selected");
  const allowedProductIdsByCoupon: Record<string, string[]> = {};
  if (selectedCandidates.length > 0) {
    const { data, error } = await supabase
      .from("coupon_products")
      .select("coupon_id, product_id")
      .in("coupon_id", selectedCandidates.map((c) => c.couponId));
    if (error) throw new Error("쿠폰 적용 대상을 불러오지 못했어요: " + error.message);
    for (const row of data ?? []) {
      const cid = (row as any).coupon_id;
      (allowedProductIdsByCoupon[cid] ??= []).push((row as any).product_id);
    }
  }

  return candidates.filter(
    (c) => c.appliesTo === "all" || (allowedProductIdsByCoupon[c.couponId] ?? []).includes(productId)
  );
}

// 클라이언트 미리보기용 할인 계산(서버와 동일한 공식 — 최종 확정 금액은 항상 서버가
// 다시 계산하므로, 여기서 값이 어긋나도 결제 안전에는 영향 없다. 단지 결제 전 화면에
// "예상 최종 결제금액"을 보여주기 위한 것).
export function previewDiscount(price: number, coupon: Pick<MemberCoupon, "discountType" | "discountValue" | "maxDiscountAmount">): number {
  if (coupon.discountType === "fixed") return Math.min(coupon.discountValue, price);
  const raw = Math.floor((price * coupon.discountValue) / 100);
  return Math.min(raw, coupon.maxDiscountAmount ?? price);
}
