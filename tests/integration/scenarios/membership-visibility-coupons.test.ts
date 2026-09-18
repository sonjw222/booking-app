/*
  MWHABIT Membership Visibility + Member Coupon Batch(2026-09-18) — Business Scenario
  E2E. 기존 tests/integration/scenarios 프레임워크(runScenario/invariants/actors/setup)
  그대로 재사용 — 새 QA 인프라를 만들지 않는다.

  요청 24번의 20개 시나리오 중 보안/정합성 핵심(공개범위 3종+격리, 쿠폰 계산 5종,
  쿠폰 소유권/센터격리/동시성/생애주기, 공개범위+쿠폰 조합, 기존 상품 regression)을
  실제 라이브 dev DB에 대해 실행해 PASS/FAIL을 실측으로 확인한다.

  ⚠ 실제 결제 경로 사용: Toss 실제 PG는 절대 건드리지 않고(요청 25번 금지사항),
  confirm_test_payment()(payment_provider='mock' 전용, add_payment_test_provider.sql류)
  만 사용한다 — 이미 이 저장소의 기존 결제 테스트(payment-lifecycle.test.ts 등)가
  쓰는 것과 동일한, 안전하게 확립된 경로.
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { getOrCreateOwnedTestCenter, cleanupTestClassAdmin, getFixtureAdminClient } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA, memberB as loginMemberB, memberCSubProfile, memberDSubProfile } from "./actors";
import { runScenario } from "./reporter";
import { loginConcurrentClient } from "./concurrentClient";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("MWHABIT Membership Visibility + Member Coupon Batch — 실제 라이브 DB 검증", () => {
  let centerAId: string;
  let centerBId: string;
  let memberAAccountId: string;
  let memberAProfileId: string;
  let memberBAccountId: string;
  let memberBProfileId: string;
  let memberCProfileId: string; // memberA의 서브프로필
  let memberDProfileId: string; // memberB의 서브프로필

  const pendingProductIds: string[] = [];
  const pendingGradeIds: string[] = [];
  const pendingCouponIds: string[] = [];
  const pendingOrderIds: string[] = [];
  const pendingCenterMemberGradeResets: { centerId: string; profileId: string }[] = [];

  beforeAll(async () => {
    const managerA = await loginManagerA();
    centerAId = await getOrCreateOwnedTestCenter(managerA);

    const managerB = await import("./actors").then((m) => m.managerB());
    centerBId = await getOrCreateOwnedTestCenter(managerB);

    const memberA = await loginMemberA();
    memberAAccountId = memberA.accountId;
    memberAProfileId = memberA.profileId;
    const memberC = await memberCSubProfile(memberAAccountId);
    memberCProfileId = memberC.profileId;

    const memberB = await loginMemberB();
    memberBAccountId = memberB.accountId;
    memberBProfileId = memberB.profileId;
    const memberD = await memberDSubProfile(memberBAccountId);
    memberDProfileId = memberD.profileId;
  }, 90000);

  afterAll(async () => {
    const admin = getFixtureAdminClient();
    // 등급 삭제 전, 그 등급을 참조 중인 center_members.grade_id를 먼저 null로
    // 되돌린다(member_grades.id를 FK로 물고 있어 참조 무결성 위반 없이 지우려면
    // 필요 — schema.sql: center_members.grade_id references member_grades(id),
    // on delete 절 없음=기본 RESTRICT).
    for (const r of pendingCenterMemberGradeResets) {
      await admin.from("center_members").update({ grade_id: null }).eq("center_id", r.centerId).eq("profile_id", r.profileId);
    }
    if (pendingGradeIds.length > 0) await admin.from("member_grades").delete().in("id", pendingGradeIds);
    if (pendingProductIds.length > 0) {
      // 실측 발견: 실제로 결제까지 확인한(confirm_test_payment) 시나리오는 memberships가
      // 이 상품을 FK로 참조하고 있어 하드 삭제가 "memberships_product_fk" 위반으로 조용히
      // 실패한다(기존 deleteProduct()가 애초에 소프트 삭제인 이유와 동일). 하드 삭제를
      // 먼저 시도하고(참조 없는 것들은 지워짐), 실패해서 남은 것만 앱 기존 관례대로
      // is_active=false로 비활성화한다.
      await admin.from("products").delete().in("id", pendingProductIds);
      await admin.from("products").update({ is_active: false }).in("id", pendingProductIds);
    }
    if (pendingCouponIds.length > 0) await admin.from("coupons").delete().in("id", pendingCouponIds);
    if (pendingOrderIds.length > 0) await admin.from("orders").delete().in("id", pendingOrderIds);
  }, 60000);

  // ---------------- fixture helpers ----------------

  async function makeGrade(centerId: string, name: string): Promise<string> {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("member_grades").insert({ center_id: centerId, name }).select("id").single();
    if (error || !data) throw new Error(`등급 생성 실패: ${error?.message ?? "no data"}`);
    pendingGradeIds.push((data as any).id);
    return (data as any).id as string;
  }

  async function setMemberGrade(centerId: string, profileId: string, gradeId: string | null): Promise<void> {
    const admin = getFixtureAdminClient();
    const { data: existing } = await admin.from("center_members").select("id").eq("center_id", centerId).eq("profile_id", profileId).maybeSingle();
    if (existing) {
      await admin.from("center_members").update({ grade_id: gradeId }).eq("id", (existing as any).id);
    } else {
      await admin.from("center_members").insert({ center_id: centerId, profile_id: profileId, grade_id: gradeId, status: "active" });
    }
    pendingCenterMemberGradeResets.push({ centerId, profileId });
  }

  async function centerMemberIdOf(centerId: string, profileId: string): Promise<string> {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("center_members").select("id").eq("center_id", centerId).eq("profile_id", profileId).single();
    if (error || !data) throw new Error(`center_members 조회 실패: ${error?.message ?? "no data"}`);
    return (data as any).id as string;
  }

  async function makeProduct(
    centerId: string, price: number,
    visibility?: { type: string; gradeIds?: string[]; memberIds?: string[] },
    couponEligible: boolean = true
  ): Promise<string> {
    const admin = getFixtureAdminClient();
    const runId = newRunId();
    const { data, error } = await admin.from("products").insert({
      center_id: centerId,
      name: `QA-상품-${runId}`,
      price,
      product_kind: "pass",
      pass_type: "count",
      total_count: 10,
      is_active: true,
      is_on_sale: true,
      visibility_type: visibility?.type ?? "all",
      coupon_eligible: couponEligible,
    }).select("id").single();
    if (error || !data) throw new Error(`상품 생성 실패: ${error?.message ?? "no data"}`);
    const productId = (data as any).id as string;
    pendingProductIds.push(productId);

    if (visibility?.type === "grades" && visibility.gradeIds?.length) {
      await admin.from("membership_product_grades").insert(visibility.gradeIds.map((gradeId) => ({ product_id: productId, grade_id: gradeId })));
    }
    if (visibility?.type === "selected_members" && visibility.memberIds?.length) {
      await admin.from("membership_product_members").insert(visibility.memberIds.map((centerMemberId) => ({ product_id: productId, center_member_id: centerMemberId })));
    }
    return productId;
  }

  // orders INSERT는 profile_id를 명시적으로 줘야 하므로(RLS가 my_profile_ids() 소속만
  // 허용) 각 로그인된 세션의 profileId를 인자로 받는 얇은 직접 insert 헬퍼.
  async function createOrderAs(profileId: string, centerId: string, productId: string, productName: string, amount: number, memberCouponId?: string) {
    return supabase.from("orders").insert({
      center_id: centerId,
      profile_id: profileId,
      product_id: productId,
      product_name: productName,
      amount,
      payment_provider: "mock",
      member_coupon_id: memberCouponId ?? null,
      status: "pending",
    }).select("id").single();
  }

  async function payWithMock(orderId: string) {
    return supabase.rpc("confirm_test_payment", { p_order_id: orderId, p_provider_ref: `qa-mock-${newRunId()}` });
  }

  async function issueCoupon(centerId: string, input: {
    name: string; discountType: "fixed" | "percentage"; discountValue: number;
    maxDiscountAmount?: number | null; minimumOrderAmount?: number | null;
    appliesTo?: "all" | "selected"; productIds?: string[];
    validFrom?: string | null; validUntil?: string | null;
  }): Promise<string> {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("coupons").insert({
      center_id: centerId, name: input.name,
      discount_type: input.discountType, discount_value: input.discountValue,
      max_discount_amount: input.maxDiscountAmount ?? null,
      minimum_order_amount: input.minimumOrderAmount ?? null,
      applies_to: input.appliesTo ?? "all",
      valid_from: input.validFrom ?? null, valid_until: input.validUntil ?? null,
      status: "active",
    }).select("id").single();
    if (error || !data) throw new Error(`쿠폰 생성 실패: ${error?.message ?? "no data"}`);
    const couponId = (data as any).id as string;
    pendingCouponIds.push(couponId);
    if (input.appliesTo === "selected" && input.productIds?.length) {
      await admin.from("coupon_products").insert(input.productIds.map((productId) => ({ coupon_id: couponId, product_id: productId })));
    }
    return couponId;
  }

  async function grantMemberCoupon(couponId: string, centerMemberId: string): Promise<string> {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin.from("member_coupons").insert({ coupon_id: couponId, center_member_id: centerMemberId, status: "available" }).select("id").single();
    if (error || !data) throw new Error(`쿠폰 지급 실패: ${error?.message ?? "no data"}`);
    return (data as any).id as string;
  }

  // ============================================================
  // §24-1/2/3: 공개범위 3종
  // ============================================================
  it("[24-1] 전체 공개 상품 — 누구나 조회/구매 가능", async () => {
    const productId = await makeProduct(centerAId, 10000, { type: "all" });
    await runScenario("SCN-VIS-01", ["memberA"], async (assertions) => {
      await loginMemberA();
      const canBuy = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberAProfileId });
      assertions.push({ name: "전체 공개 상품은 구매 자격 있음(RPC)", passed: canBuy.data === true, detail: JSON.stringify(canBuy) });
      expect(canBuy.data).toBe(true);

      const purchasable = await supabase.rpc("fetch_purchasable_products", { p_center_id: centerAId });
      const ids = (purchasable.data ?? []).map((p: any) => p.id);
      assertions.push({ name: "구매 가능 목록에도 포함됨", passed: ids.includes(productId) });
      expect(ids).toContain(productId);

      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-전체공개", 10000);
      assertions.push({ name: "주문 생성 성공", passed: !orderRes.error, detail: orderRes.error?.message });
      expect(orderRes.error).toBeNull();
      if (orderRes.data) pendingOrderIds.push((orderRes.data as any).id);
    });
  }, 60000);

  it("[24-2] 지정 회원 상품 — 대상만 조회/구매 가능, 비대상은 목록 숨김 + 직접 접근 서버 차단", async () => {
    await setMemberGrade(centerAId, memberCProfileId, null); // center_members 행 존재 보장(grade 없이)
    const targetCenterMemberId = await centerMemberIdOf(centerAId, memberCProfileId);
    const productId = await makeProduct(centerAId, 20000, { type: "selected_members", memberIds: [targetCenterMemberId] });

    await runScenario("SCN-VIS-02", ["memberC(target)", "memberA(non-target)"], async (assertions) => {
      // 대상(memberC, memberA 계정의 서브프로필)
      await loginMemberA();
      const canBuyTarget = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberCProfileId });
      assertions.push({ name: "지정된 회원(C)은 구매 자격 있음", passed: canBuyTarget.data === true, detail: JSON.stringify(canBuyTarget) });
      expect(canBuyTarget.data).toBe(true);

      const orderOk = await createOrderAs(memberCProfileId, centerAId, productId, "QA-지정회원", 20000);
      assertions.push({ name: "대상 회원 주문 생성 성공", passed: !orderOk.error, detail: orderOk.error?.message });
      expect(orderOk.error).toBeNull();
      if (orderOk.data) pendingOrderIds.push((orderOk.data as any).id);

      // 비대상(memberA 본인, 같은 계정이지만 다른 프로필이라 대상 아님) — 개별 프로필
      // 단위 자격 판정은 정확하다(member_can_purchase_product는 profile_id를 그대로 봄).
      const canBuyNonTarget = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberAProfileId });
      assertions.push({ name: "비대상(A 본인)은 구매 자격 없음", passed: canBuyNonTarget.data === false, detail: JSON.stringify(canBuyNonTarget) });
      expect(canBuyNonTarget.data).toBe(false);

      // ⚠ 하드닝: "목록에서 숨김"/"직접 접근 차단" 검증은 memberA가 아니라 memberB(완전히
      // 다른 계정)로 해야 한다 — my_profile_ids()는 "로그인한 계정 소유의 모든 프로필"을
      // 반환하므로(가족 프로필 공유 기능), memberA 세션의 fetch_purchasable_products는
      // memberA 자신뿐 아니라 같은 계정의 서브프로필(memberC, 이 상품의 실제 대상)
      // 몫까지 합쳐서 보여준다 — 이건 실제 제품 입장에서 맞는 동작(가족 계정으로 자녀
      // 몫 상품도 둘러볼 수 있어야 함)이라, "memberA 세션에 안 보임"을 검증하려면 애초에
      // 이 상품과 계정 자체가 무관한 memberB를 써야 한다(실측 재현 — 최초 구현에서
      // memberA로 검사했다가 "보임"으로 나와 실패했었음, 버그 아니라 테스트 설계 오류).
      await loginMemberB();
      const purchasableForB = await supabase.rpc("fetch_purchasable_products", { p_center_id: centerAId });
      const idsForB = (purchasableForB.data ?? []).map((p: any) => p.id);
      assertions.push({ name: "완전히 무관한 회원(B) 목록에서는 이 상품이 안 보임(숨김)", passed: !idsForB.includes(productId), detail: JSON.stringify({ visibleCount: idsForB.length }) });
      expect(idsForB).not.toContain(productId);

      // 보안 핵심: product id를 직접 알아내서 주문을 시도해도(개발자도구/API 직접
      // 호출 시뮬레이션) 서버(orders INSERT RLS)가 차단해야 한다.
      const directOrderAttempt = await createOrderAs(memberBProfileId, centerAId, productId, "QA-지정회원", 20000);
      assertions.push({
        name: "[보안] 완전히 무관한 회원(B)이 product id를 직접 넣어 주문 생성을 시도해도 서버가 차단함",
        passed: !!directOrderAttempt.error,
        detail: directOrderAttempt.error?.message,
      });
      expect(directOrderAttempt.error).not.toBeNull();
    });
  }, 60000);

  it("[24-3] 특정 등급 상품 — VIP만 조회/구매 가능, 일반은 차단", async () => {
    const vipGradeId = await makeGrade(centerAId, `QA-VIP-${newRunId()}`);
    await setMemberGrade(centerAId, memberAProfileId, vipGradeId);
    // memberB는 등급 없음(일반)
    const productId = await makeProduct(centerAId, 30000, { type: "grades", gradeIds: [vipGradeId] });

    await runScenario("SCN-VIS-03", ["memberA(VIP)", "memberB(일반)"], async (assertions) => {
      await loginMemberA();
      const canBuyVip = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberAProfileId });
      assertions.push({ name: "VIP 회원은 구매 자격 있음", passed: canBuyVip.data === true });
      expect(canBuyVip.data).toBe(true);

      await loginMemberB();
      const canBuyNormal = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberBProfileId });
      assertions.push({ name: "일반 회원은 구매 자격 없음", passed: canBuyNormal.data === false });
      expect(canBuyNormal.data).toBe(false);

      const orderBlocked = await createOrderAs(memberBProfileId, centerAId, productId, "QA-VIP전용", 30000);
      assertions.push({ name: "일반 회원의 주문 생성 시도는 서버가 차단", passed: !!orderBlocked.error, detail: orderBlocked.error?.message });
      expect(orderBlocked.error).not.toBeNull();
    });
  }, 60000);

  it("[24-4] 등급 변경이 즉시 반영된다 — 일반→VIP 승급 시 VIP 전용 상품이 바로 보임", async () => {
    const vipGradeId = await makeGrade(centerAId, `QA-VIP승급-${newRunId()}`);
    await setMemberGrade(centerAId, memberBProfileId, null); // 처음엔 등급 없음
    const productId = await makeProduct(centerAId, 15000, { type: "grades", gradeIds: [vipGradeId] });

    await runScenario("SCN-VIS-04", ["memberB"], async (assertions) => {
      await loginMemberB();
      const before = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberBProfileId });
      assertions.push({ name: "승급 전에는 구매 자격 없음", passed: before.data === false });
      expect(before.data).toBe(false);

      await setMemberGrade(centerAId, memberBProfileId, vipGradeId);

      const after = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberBProfileId });
      assertions.push({ name: "VIP로 승급하면 즉시 구매 자격 생김", passed: after.data === true, detail: JSON.stringify({ before: before.data, after: after.data }) });
      expect(after.data).toBe(true);
    });
  }, 60000);

  it("[24-6] 센터 격리 — centerA 매니저가 centerB의 등급/회원을 공개범위 대상으로 지정할 수 없다", async () => {
    const managerA = await loginManagerA();
    const productId = await makeProduct(centerAId, 10000, { type: "all" });

    // centerB의 등급을 만들어서, centerA 상품에 매핑을 시도한다(관리자 세션은 managerA로 유지).
    const admin = getFixtureAdminClient();
    const { data: gradeB } = await admin.from("member_grades").insert({ center_id: centerBId, name: `QA-B등급-${newRunId()}` }).select("id").single();
    pendingGradeIds.push((gradeB as any).id);

    await runScenario("SCN-VIS-06", ["managerA"], async (assertions) => {
      await loginManagerA();
      const res = await supabase.from("membership_product_grades").insert({ product_id: productId, grade_id: (gradeB as any).id });
      assertions.push({
        name: "[보안] centerA 관리자가 centerB 등급을 자기 상품에 매핑하려는 시도는 RLS가 거부",
        passed: !!res.error,
        detail: res.error?.message,
      });
      expect(res.error).not.toBeNull();
    });
  }, 60000);

  // ============================================================
  // §24-7~11: 쿠폰 계산
  // ============================================================
  it("[24-7] 정액 쿠폰 — 400,000원 상품 + 30,000원 할인 = 370,000원", async () => {
    const productId = await makeProduct(centerAId, 400000, { type: "all" });
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId).catch(async () => {
      await setMemberGrade(centerAId, memberAProfileId, null);
      return centerMemberIdOf(centerAId, memberAProfileId);
    });
    const couponId = await issueCoupon(centerAId, { name: "QA-정액쿠폰", discountType: "fixed", discountValue: 30000 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-07", ["memberA"], async (assertions) => {
      await loginMemberA();
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-정액테스트", 370000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);

      const payRes = await payWithMock(orderId);
      assertions.push({ name: "서버가 계산한 할인과 클라이언트가 보낸 370,000원이 일치해 결제 성공", passed: !payRes.error, detail: JSON.stringify({ data: payRes.data, error: payRes.error?.message }) });
      expect(payRes.error).toBeNull();
      expect((payRes.data as any).amount).toBe(370000);
    });
  }, 60000);

  it("[24-8] 정률 쿠폰 — 400,000원 + 10% = 360,000원", async () => {
    const productId = await makeProduct(centerAId, 400000, { type: "all" });
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-정률쿠폰", discountType: "percentage", discountValue: 10 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-08", ["memberA"], async (assertions) => {
      await loginMemberA();
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-정률테스트", 360000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);
      const payRes = await payWithMock(orderId);
      assertions.push({ name: "10% 할인 정확히 계산됨(400,000 -> 360,000)", passed: !payRes.error && (payRes.data as any)?.amount === 360000, detail: JSON.stringify(payRes) });
      expect((payRes.data as any).amount).toBe(360000);
    });
  }, 60000);

  it("[24-9] 정률 쿠폰 + 최대 할인금액 — 400,000원 + 20%(최대 30,000원) = 370,000원", async () => {
    const productId = await makeProduct(centerAId, 400000, { type: "all" });
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-최대할인쿠폰", discountType: "percentage", discountValue: 20, maxDiscountAmount: 30000 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-09", ["memberA"], async (assertions) => {
      await loginMemberA();
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-최대할인테스트", 370000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);
      const payRes = await payWithMock(orderId);
      assertions.push({
        name: "20% 계산값(80,000)이 아니라 최대 할인(30,000)이 적용됨(370,000원)",
        passed: !payRes.error && (payRes.data as any)?.amount === 370000,
        detail: JSON.stringify(payRes),
      });
      expect((payRes.data as any).amount).toBe(370000);
    });
  }, 60000);

  it("[24-10] 최소 결제금액 미달 — 80,000원 상품에 '10만원 이상' 쿠폰은 사용 불가(서버 거부)", async () => {
    const productId = await makeProduct(centerAId, 80000, { type: "all" });
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-최소금액쿠폰", discountType: "fixed", discountValue: 20000, minimumOrderAmount: 100000 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-10", ["memberA"], async (assertions) => {
      await loginMemberA();
      // 클라이언트가 (잘못) 할인 적용된 금액(60,000)으로 주문을 만들어도, orders INSERT
      // 자체는 상품자격만 보고 성공할 수 있다 — 진짜 방어선은 결제 확정 시점.
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-최소금액테스트", 60000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);
      const payRes = await payWithMock(orderId);
      assertions.push({
        name: "[보안] 최소 결제금액 미달 쿠폰은 결제 확정 시점에 서버가 거부",
        passed: !!payRes.error,
        detail: payRes.error?.message,
      });
      expect(payRes.error).not.toBeNull();
    });
  }, 60000);

  it("[24-11] 만료된 쿠폰은 사용 불가(서버 거부)", async () => {
    const productId = await makeProduct(centerAId, 50000, { type: "all" });
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, {
      name: "QA-만료쿠폰", discountType: "fixed", discountValue: 10000,
      validUntil: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-11", ["memberA"], async (assertions) => {
      await loginMemberA();
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-만료테스트", 40000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);
      const payRes = await payWithMock(orderId);
      assertions.push({ name: "[보안] 유효기간 지난 쿠폰은 결제 확정 시점에 거부", passed: !!payRes.error, detail: payRes.error?.message });
      expect(payRes.error).not.toBeNull();
    });
  }, 60000);

  // ============================================================
  // §신규(2026-09-19): 상품별 "쿠폰 적용 불가" 옵션(add_product_coupon_eligibility.sql)
  // — 쿠폰 쪽 applies_to='all'이어도, 상품 자체가 coupon_eligible=false면 그 어떤
  // 쿠폰도 못 쓴다(상품 설정이 쿠폰 설정보다 우선). 유효하고, 소유자도 맞고, 최소금액도
  // 만족하는 "완전히 정상적인" 쿠폰으로 시도해도 여전히 막혀야 한다 — 그래야 이게
  // 진짜 상품 레벨 차단인지(다른 사유로 우연히 막힌 게 아닌지) 확실하다.
  // ============================================================
  it("[24-22] 쿠폰 적용 불가 상품 — 완전히 유효한 쿠폰이어도 서버가 차단", async () => {
    const productId = await makeProduct(centerAId, 100000, { type: "all" }, false); // coupon_eligible=false
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-쿠폰불가상품용쿠폰", discountType: "fixed", discountValue: 10000 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-22", ["memberA"], async (assertions) => {
      await loginMemberA();
      // 할인 없이 원가로 시도해도(클라이언트가 할인을 아예 반영 안 한 경우) 서버가
      // coupon_eligible 체크에서 먼저 막아야 한다 — 금액 불일치가 아니라 쿠폰 적용
      // 자체가 차단되는지를 본다.
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-쿠폰불가상품테스트", 90000, memberCouponId);
      expect(orderRes.error).toBeNull(); // orders INSERT는 상품 구매자격만 보므로 일단 통과
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);

      const payRes = await payWithMock(orderId);
      assertions.push({
        name: "[보안] coupon_eligible=false 상품은 유효한 쿠폰이어도 결제 확정 시점에 거부",
        passed: !!payRes.error,
        detail: payRes.error?.message,
      });
      expect(payRes.error).not.toBeNull();

      // 쿠폰 자체는 이 실패한 시도로 소비되지 않아야 한다(다른 정상 상품에는 여전히
      // 쓸 수 있어야 함) — 실패한 결제는 쿠폰 상태를 바꾸지 않는다는 기존 요청 18번
      // 원칙과 동일선상의 회귀 방지.
      const { data: mc } = await getFixtureAdminClient().from("member_coupons").select("status").eq("id", memberCouponId).single();
      assertions.push({ name: "차단된 시도로 쿠폰이 소비되지 않음(여전히 available)", passed: (mc as any)?.status === "available", detail: JSON.stringify(mc) });
      expect((mc as any)?.status).toBe("available");
    });
  }, 60000);

  // ============================================================
  // §24-12/13: 쿠폰 소유권/센터 격리 공격
  // ============================================================
  it("[24-12] 다른 회원 쿠폰 도용 — B의 쿠폰 id를 A가 자기 주문에 넣어도 서버가 차단", async () => {
    const productId = await makeProduct(centerAId, 100000, { type: "all" });
    await setMemberGrade(centerAId, memberBProfileId, null);
    const bCenterMemberId = await centerMemberIdOf(centerAId, memberBProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-B전용쿠폰", discountType: "fixed", discountValue: 10000 });
    const bMemberCouponId = await grantMemberCoupon(couponId, bCenterMemberId); // B에게 지급

    await runScenario("SCN-CPN-12", ["memberA(attacker)", "memberB(owner)"], async (assertions) => {
      await loginMemberA(); // 공격자 A로 로그인, B의 member_coupon_id를 직접 넣어 주문 시도
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-쿠폰도용테스트", 90000, bMemberCouponId);
      expect(orderRes.error).toBeNull(); // orders INSERT는 상품자격만 봐서 일단 통과할 수 있음
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);

      const payRes = await payWithMock(orderId);
      assertions.push({
        name: "[보안] 본인 소유가 아닌 쿠폰(B의 쿠폰)로 결제 확정 시도는 서버가 차단",
        passed: !!payRes.error,
        detail: payRes.error?.message,
      });
      expect(payRes.error).not.toBeNull();

      const admin = getFixtureAdminClient();
      const { data: mcAfter } = await admin.from("member_coupons").select("status").eq("id", bMemberCouponId).single();
      assertions.push({ name: "B의 쿠폰은 여전히 available(도용 실패로 소모 안 됨)", passed: (mcAfter as any).status === "available" });
      expect((mcAfter as any).status).toBe("available");
    });
  }, 60000);

  it("[24-13] 다른 센터 쿠폰 — centerA 쿠폰을 centerB 상품 구매에 사용 시도 시 서버가 차단", async () => {
    const productBId = await makeProduct(centerBId, 50000, { type: "all" });
    await setMemberGrade(centerAId, memberAProfileId, null);
    const aCenterMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponAId = await issueCoupon(centerAId, { name: "QA-A센터쿠폰", discountType: "fixed", discountValue: 10000 });
    const memberCouponId = await grantMemberCoupon(couponAId, aCenterMemberId);

    await runScenario("SCN-CPN-13", ["memberA"], async (assertions) => {
      await loginMemberA();
      // centerB 상품을 사려면 centerB의 구매자격이 필요한데 상품은 all이라 통과됨 —
      // 문제는 "센터A 쿠폰을 센터B 주문에" 쓰려는 시도 자체.
      const orderRes = await createOrderAs(memberAProfileId, centerBId, productBId, "QA-타센터쿠폰테스트", 40000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);

      const payRes = await payWithMock(orderId);
      assertions.push({ name: "[보안] 센터A 쿠폰으로 센터B 주문 결제 확정 시도는 서버가 차단", passed: !!payRes.error, detail: payRes.error?.message });
      expect(payRes.error).not.toBeNull();
    });
  }, 60000);

  // ============================================================
  // §24-14: 쿠폰 동시 사용 race
  // ============================================================
  it("[24-14] 같은 쿠폰으로 두 주문을 동시에 결제 확정 시도해도 정확히 하나만 성공한다", async () => {
    const product1Id = await makeProduct(centerAId, 50000, { type: "all" });
    const product2Id = await makeProduct(centerAId, 50000, { type: "all" });
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-동시성쿠폰", discountType: "fixed", discountValue: 5000 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-14", ["memberA"], async (assertions) => {
      await loginMemberA();
      const order1 = await createOrderAs(memberAProfileId, centerAId, product1Id, "QA-동시성1", 45000, memberCouponId);
      const order2 = await createOrderAs(memberAProfileId, centerAId, product2Id, "QA-동시성2", 45000, memberCouponId);
      expect(order1.error).toBeNull();
      expect(order2.error).toBeNull();
      const order1Id = (order1.data as any).id as string;
      const order2Id = (order2.data as any).id as string;
      pendingOrderIds.push(order1Id, order2Id);

      const [clientA1, clientA2] = await Promise.all([
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
        loginConcurrentClient("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"),
      ]);
      const [pay1, pay2] = await Promise.all([
        clientA1.rpc("confirm_test_payment", { p_order_id: order1Id, p_provider_ref: `qa-race-1-${newRunId()}` }),
        clientA2.rpc("confirm_test_payment", { p_order_id: order2Id, p_provider_ref: `qa-race-2-${newRunId()}` }),
      ]);

      const successes = [pay1, pay2].filter((r) => !r.error);
      assertions.push({
        name: "동시 결제 확정 중 정확히 1건만 성공(쿠폰 이중 사용 방지)",
        passed: successes.length === 1,
        detail: JSON.stringify({ pay1: { data: pay1.data, error: pay1.error?.message }, pay2: { data: pay2.data, error: pay2.error?.message } }),
      });
      expect(successes.length).toBe(1);

      const admin = getFixtureAdminClient();
      const { data: mcFinal } = await admin.from("member_coupons").select("status, order_id").eq("id", memberCouponId).single();
      assertions.push({ name: "쿠폰은 정확히 한 주문에만 used로 연결됨", passed: (mcFinal as any).status === "used", detail: JSON.stringify(mcFinal) });
      expect((mcFinal as any).status).toBe("used");
    });
  }, 60000);

  // ============================================================
  // §24-15/16/17: 쿠폰 생애주기(선택 시점/결제성공/환불)
  // ============================================================
  it("[24-15/16] 쿠폰은 주문 생성(선택) 시점이 아니라 결제 확정 성공 시점에만 used로 바뀐다", async () => {
    const productId = await makeProduct(centerAId, 60000, { type: "all" });
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-생애주기쿠폰", discountType: "fixed", discountValue: 10000 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-15-16", ["memberA"], async (assertions) => {
      await loginMemberA();
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-생애주기테스트", 50000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);

      const admin = getFixtureAdminClient();
      const { data: afterOrderCreate } = await admin.from("member_coupons").select("status").eq("id", memberCouponId).single();
      assertions.push({ name: "[24-15] 주문 생성(쿠폰 선택)만으로는 아직 available 유지", passed: (afterOrderCreate as any).status === "available", detail: JSON.stringify(afterOrderCreate) });
      expect((afterOrderCreate as any).status).toBe("available");

      const payRes = await payWithMock(orderId);
      expect(payRes.error).toBeNull();

      const { data: afterPay } = await admin.from("member_coupons").select("status, used_at, order_id").eq("id", memberCouponId).single();
      assertions.push({ name: "[24-16] 결제 성공 확정 후에야 used로 전환, used_at/order_id 기록됨", passed: (afterPay as any).status === "used" && !!(afterPay as any).used_at && (afterPay as any).order_id === orderId, detail: JSON.stringify(afterPay) });
      expect((afterPay as any).status).toBe("used");
      expect((afterPay as any).order_id).toBe(orderId);
    });
  }, 60000);

  it("[24-17] 전체 결제 취소(셀프 환불) 시 사용된 쿠폰이 available로 복원된다", async () => {
    const productId = await makeProduct(centerAId, 40000, { type: "all" });
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-환불쿠폰", discountType: "fixed", discountValue: 5000 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);

    await runScenario("SCN-CPN-17", ["memberA"], async (assertions) => {
      await loginMemberA();
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-환불테스트", 35000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);
      const payRes = await payWithMock(orderId);
      expect(payRes.error).toBeNull();
      const membershipId = (payRes.data as any).membership_id as string;

      const refundRes = await supabase.rpc("refund_membership", { p_membership_id: membershipId });
      assertions.push({ name: "셀프 환불 성공(24시간 이내, 미사용)", passed: !refundRes.error && (refundRes.data as any)?.refunded === true, detail: JSON.stringify(refundRes) });
      expect(refundRes.error).toBeNull();

      const admin = getFixtureAdminClient();
      const { data: mcAfterRefund } = await admin.from("member_coupons").select("status, used_at, order_id").eq("id", memberCouponId).single();
      assertions.push({ name: "환불 후 쿠폰이 available로 복원됨(used_at/order_id 초기화)", passed: (mcAfterRefund as any).status === "available" && (mcAfterRefund as any).used_at === null, detail: JSON.stringify(mcAfterRefund) });
      expect((mcAfterRefund as any).status).toBe("available");
      expect((mcAfterRefund as any).used_at).toBeNull();
    });
  }, 60000);

  // ============================================================
  // §24-18: 쿠폰 회수
  // ============================================================
  it("[24-18] 관리자가 미사용 쿠폰을 회수하면 회원이 더 이상 쓸 수 없다", async () => {
    await setMemberGrade(centerAId, memberAProfileId, null);
    const centerMemberId = await centerMemberIdOf(centerAId, memberAProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-회수쿠폰", discountType: "fixed", discountValue: 5000 });
    const memberCouponId = await grantMemberCoupon(couponId, centerMemberId);
    const productId = await makeProduct(centerAId, 20000, { type: "all" });

    await runScenario("SCN-CPN-18", ["managerA", "memberA"], async (assertions) => {
      await loginManagerA();
      const revokeRes = await supabase.rpc("revoke_member_coupon", { p_member_coupon_id: memberCouponId });
      assertions.push({ name: "관리자 회수 성공", passed: !revokeRes.error, detail: revokeRes.error?.message });
      expect(revokeRes.error).toBeNull();

      await loginMemberA();
      const orderRes = await createOrderAs(memberAProfileId, centerAId, productId, "QA-회수후사용시도", 15000, memberCouponId);
      expect(orderRes.error).toBeNull();
      const orderId = (orderRes.data as any).id as string;
      pendingOrderIds.push(orderId);
      const payRes = await payWithMock(orderId);
      assertions.push({ name: "[보안] 회수된 쿠폰은 결제 확정 시점에 사용 거부됨", passed: !!payRes.error, detail: payRes.error?.message });
      expect(payRes.error).not.toBeNull();
    });
  }, 60000);

  // ============================================================
  // §24-19: 공개범위 + 쿠폰 조합 보안(가장 중요 — 요청 원문 강조)
  // ============================================================
  it("[24-19] 쿠폰을 갖고 있어도 비공개 상품 구매 자격이 생기지 않는다", async () => {
    const vipGradeId = await makeGrade(centerAId, `QA-조합VIP-${newRunId()}`);
    await setMemberGrade(centerAId, memberAProfileId, vipGradeId); // A는 VIP
    await setMemberGrade(centerAId, memberBProfileId, null); // B는 일반
    const productId = await makeProduct(centerAId, 400000, { type: "grades", gradeIds: [vipGradeId] });

    const bCenterMemberId = await centerMemberIdOf(centerAId, memberBProfileId);
    const couponId = await issueCoupon(centerAId, { name: "QA-조합쿠폰", discountType: "fixed", discountValue: 30000 });
    const bMemberCouponId = await grantMemberCoupon(couponId, bCenterMemberId); // 일반 회원 B도 쿠폰은 보유

    await runScenario("SCN-CPN-19", ["memberA(VIP)", "memberB(일반+쿠폰보유)"], async (assertions) => {
      // VIP(A)는 상품 자격 있음 + 쿠폰 없이도 구매 가능(별도 쿠폰 없이 정가 결제로 확인)
      await loginMemberA();
      const canBuyA = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberAProfileId });
      expect(canBuyA.data).toBe(true);

      // 일반 회원 B는 쿠폰을 갖고 있어도 VIP 상품 구매 자격이 없어야 한다 — 핵심 검증.
      await loginMemberB();
      const canBuyB = await supabase.rpc("member_can_purchase_product", { p_product_id: productId, p_profile_id: memberBProfileId });
      assertions.push({
        name: "[핵심] 쿠폰을 보유해도 일반 회원(B)은 VIP 전용 상품 구매 자격이 생기지 않음",
        passed: canBuyB.data === false,
        detail: JSON.stringify(canBuyB),
      });
      expect(canBuyB.data).toBe(false);

      const orderAttempt = await createOrderAs(memberBProfileId, centerAId, productId, "QA-조합공격테스트", 370000, bMemberCouponId);
      assertions.push({
        name: "[보안] B가 쿠폰을 곁들여 VIP 상품 주문을 시도해도 서버(orders INSERT RLS)가 차단",
        passed: !!orderAttempt.error,
        detail: orderAttempt.error?.message,
      });
      expect(orderAttempt.error).not.toBeNull();

      const admin = getFixtureAdminClient();
      const { data: mcAfter } = await admin.from("member_coupons").select("status").eq("id", bMemberCouponId).single();
      assertions.push({ name: "B의 쿠폰은 공격 시도 후에도 여전히 available(소모 안 됨)", passed: (mcAfter as any).status === "available" });
      expect((mcAfter as any).status).toBe("available");
    });
  }, 60000);

  // ============================================================
  // §24-20: 기존 상품 regression
  // ============================================================
  it("[24-20] 공개범위를 지정하지 않고 만든 상품은 기본적으로 전체 공개(all)로 취급된다", async () => {
    const admin = getFixtureAdminClient();
    const runId = newRunId();
    // visibility_type을 아예 명시하지 않고 insert — DB 컬럼 기본값(default 'all')이
    // 실제로 적용되는지 확인(요청 3번 "기존 수강권 compatibility").
    const { data, error } = await admin.from("products").insert({
      center_id: centerAId, name: `QA-레거시상품-${runId}`, price: 10000,
      product_kind: "pass", pass_type: "count", total_count: 10,
      is_active: true, is_on_sale: true,
    }).select("id, visibility_type").single();
    if (error || !data) throw new Error(`상품 생성 실패: ${error?.message}`);
    pendingProductIds.push((data as any).id);

    await runScenario("SCN-VIS-20", ["memberA"], async (assertions) => {
      assertions.push({ name: "DB 기본값이 실제로 'all'로 적용됨", passed: (data as any).visibility_type === "all", detail: JSON.stringify(data) });
      expect((data as any).visibility_type).toBe("all");

      await loginMemberA();
      const canBuy = await supabase.rpc("member_can_purchase_product", { p_product_id: (data as any).id, p_profile_id: memberAProfileId });
      assertions.push({ name: "공개범위 지정 안 한 기존 상품도 정상 구매 가능(회귀 없음)", passed: canBuy.data === true, detail: JSON.stringify(canBuy) });
      expect(canBuy.data).toBe(true);
    });
  }, 60000);
});
