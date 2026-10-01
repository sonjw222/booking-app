/*
  센터 쿠폰 fixture — 앱의 실제 쿠폰 경로를 QA 매니저 세션으로 호출한다(lib/coupons.ts createCoupon → coupons/coupon_products INSERT,
  issueCouponToMembers → RPC issue_coupon_to_members). 호출 전에 QA 매니저로 로그인된 상태여야 한다.
  이번 실행이 만든 coupons / coupon_products / member_coupons의 UUID를 tracker에 기록해 그 목록으로만 정리한다.
*/
import type { SupabaseClient } from "@supabase/supabase-js";
import { createCoupon, issueCouponToMembers } from "../../../lib/coupons";
import { FixtureTracker, qaName } from "../runContext";

export async function createAndIssueQaCoupon(
  admin: SupabaseClient, t: FixtureTracker,
  opts: { centerId: string; centerMemberId: string; label: string; discountValue: number; minimumOrderAmount?: number | null; productIds: string[] },
): Promise<{ couponId: string; memberCouponId: string }> {
  const couponId = await createCoupon(opts.centerId, {
    name: qaName(t.runId, opts.label), discountType: "fixed", discountValue: opts.discountValue,
    minimumOrderAmount: opts.minimumOrderAmount ?? null, appliesTo: "selected", productIds: opts.productIds,
  });
  t.add("coupons", couponId);
  const cps = await admin.from("coupon_products").select("id").eq("coupon_id", couponId);
  for (const r of cps.data ?? []) t.add("coupon_products", (r as any).id);

  const issued = await issueCouponToMembers(couponId, [opts.centerMemberId]);
  if (issued.issuedCount !== 1) throw new Error(`QA 쿠폰 지급 실패(지급 ${issued.issuedCount}건)`);
  const mc = await admin.from("member_coupons").select("id").eq("coupon_id", couponId).eq("center_member_id", opts.centerMemberId).single();
  if (mc.error || !mc.data) throw new Error(`지급된 QA 쿠폰 조회 실패: ${mc.error?.message}`);
  t.add("member_coupons", mc.data.id);
  return { couponId, memberCouponId: mc.data.id as string };
}
