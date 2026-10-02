"use client";

/*
  결제 화면 (주문서)
  - 센터 상세에서 수강권/상품 "구매" → 여기로
  - 주문 정보 + 금액 + 결제수단(placeholder) + 결제하기
  - 결제 수단 연동 전이므로 "결제하기" 시 주문 생성(pending) 후 완료 안내
*/

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchCenterDetail, fetchCenterProductsForPurchase, fetchPurchaseScheduleOptions, type CenterProduct } from "../../lib/center";
import { purchaseScheduleState } from "../../lib/purchaseSchedule";
import { DAYS, type SelectableSchedule } from "../../lib/passes";
import { cancelMyPendingOrderQuietly, createOrder } from "../../lib/orders";
import { requestReturnToken } from "../../lib/payments/tossPaymentApi";
import { clearPendingPgOrder, readPendingPgOrder, savePendingPgOrder } from "../../lib/payments/returnApi";
import { fetchProfiles, type ProfileRow } from "../../lib/profiles";
import { fetchMyPoints, usePoints } from "../../lib/reviews";
import Loading from "../components/Loading";
import { reservationReturnUrl } from "../../lib/reservationNav";
import { getPaymentService, resolveProviderName, PG_CHECKOUT_ENABLED, type PaymentScenario } from "../../lib/payments";
import { supabase } from "../../lib/supabaseClient";
import { fetchMyPgCheckoutOverride } from "../../lib/authAccount";
import { toUserMessage } from "../../lib/userError";
import { fetchApplicableCoupons, previewDiscount, type MemberCoupon } from "../../lib/coupons";
import { visiblePayMethodIds, resolveSelectedPayMethod } from "../../lib/payMethods";
import { computeBaseAmount, countOptionLabel, isCountSelectable, sortedTiers } from "../../lib/selectableCount";
import { loginHrefWithReturnToHere } from "../../lib/postLoginReturn";
import UiIcon, { type IconName } from "../components/UiIcon";
import ErrorState from "../components/ErrorState";

// 카카오페이/토스페이는 로고 자산이 없어 outline 아이콘 하나로 뭉치면 구분이 안 되므로
// --vendor-* 색 점(dot)으로, 나머지는 의미가 통하는 outline 아이콘으로 구분한다.
const PAY_METHODS: { id: string; label: string; icon?: IconName; dot?: string }[] = [
  { id: "card", label: "신용/체크카드", icon: "card" },
  { id: "kakao", label: "카카오페이", dot: "var(--vendor-kakao)" },
  { id: "toss", label: "토스페이", dot: "var(--vendor-toss)" },
  { id: "transfer", label: "계좌이체", icon: "bank" },
  { id: "direct", label: "직접결제 (센터에서 결제)", icon: "handshake" },
];

// 토스 결제창을 거치는 결제수단(카드/카카오페이/토스페이/계좌이체). "direct"(직접결제)는
// PG를 아예 거치지 않는 별도 흐름이라 이 목록과 무관하게 handlePay()에서 먼저 분기한다.
const TOSS_SUPPORTED_METHODS = ["card", "kakao", "toss", "transfer"];
// payMethod → 토스 간편결제 ENUM 코드. "card"는 일반 카드결제라 매핑 없음(undefined).
const EASY_PAY_BY_METHOD: Record<string, "KAKAOPAY" | "TOSSPAY" | undefined> = {
  kakao: "KAKAOPAY",
  toss: "TOSSPAY",
};

export default function CheckoutPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CheckoutContent />
    </Suspense>
  );
}

function CheckoutContent() {
  const sp = useSearchParams();
  const centerId = sp.get("center") ?? "";
  const productId = sp.get("product") ?? "";
  // 예약창 → 수강권 구매하기로 넘어온 경우, 구매 후 바로 예약할 수업 정보
  const reserveClassId = sp.get("reserveClassId");
  const reserveDate = sp.get("reserveDate");
  // 센터 상세 화면의 필터/센터 상태 (뒤로가기 시 그대로 복원하기 위해 그대로 들고 다님)
  const reserveCenter = sp.get("reserveCenter");
  const productIds = sp.get("productIds");
  const showAll = sp.get("showAll");
  // 뒤로가기: 예약 흐름으로 들어온 경우 센터 상세의 구매 시트를 그 상태 그대로 다시 열어줌
  // UX 감사(A-15) — centerId가 없을 때(예: 파라미터 없이 직접 진입) `/center/`(빈 ID)로
  // 가면 404였다. 그럴 땐 홈으로 폴백.
  const centerBackHref = !centerId ? "/" : reserveClassId && reserveDate
    ? `/center/${centerId}?buy=1&reserveClassId=${reserveClassId}&reserveDate=${encodeURIComponent(reserveDate)}`
      + (reserveCenter ? `&reserveCenter=${reserveCenter}` : "")
      + (productIds ? `&productIds=${productIds}` : "")
      + (showAll ? `&showAll=${showAll}` : "")
    : `/center/${centerId}`;
  // 결제 완료 후 예약 화면으로 자동 복귀할 때 쓸 URL (날짜/센터 복원 + 완료 토스트 표시)
  const reservationBackUrl = reserveClassId && reserveDate
    ? reservationReturnUrl({ classId: reserveClassId, date: reserveDate, center: reserveCenter, purchased: true })
    : null;
  // Mock 결제 시나리오 QA용: ?mockScenario=failed|cancelled|success 로 재빌드 없이 즉시 테스트 가능
  // (없으면 NEXT_PUBLIC_PAYMENT_SCENARIO 환경변수, 그것도 없으면 기본 success)
  const mockScenarioParam = sp.get("mockScenario");
  const mockScenarioOverride: PaymentScenario | undefined =
    mockScenarioParam === "success" || mockScenarioParam === "failed" || mockScenarioParam === "cancelled"
      ? mockScenarioParam
      : undefined;

  const [centerName, setCenterName] = useState("");
  const [allowedPay, setAllowedPay] = useState<string[] | null>(null);
  const [product, setProduct] = useState<CenterProduct | null>(null);
  // PG_CHECKOUT_ENABLED가 꺼져 있으면(Toss 실운영 심사 전 임시 출시) "card"는 애초에
  // 고를 수 없는 선택지라 기본값도 항상 선택 가능한 "direct"로 시작해야 한다. 다만 이 계정이
  // 토스 카드사 심사관 전용 테스트 계정이면(accounts.pg_checkout_override, load()에서
  // 비동기로 확인) 전역 게이트와 무관하게 온라인 결제를 열어준다 — 일반 고객 노출은
  // 전역 플래그 그대로다.
  const [pgCheckoutEnabled, setPgCheckoutEnabled] = useState(PG_CHECKOUT_ENABLED);
  const [payMethod, setPayMethod] = useState(PG_CHECKOUT_ENABLED ? "card" : "direct");
  const [selectedSize, setSelectedSize] = useState<string | null>(null);
  // 2026-10-01 — 구매 횟수 선택형 상품의 선택 횟수(센터 구매 sheet에서 ?count=&size=로 넘어옴, 여기서도 변경 가능).
  // 상품 기본금액 = 1회가×횟수(표시용). 최종 금액/발급 횟수는 서버가 주문 snapshot(selected_count)으로 다시 확정한다.
  const [selectedCount, setSelectedCount] = useState<number | null>(null);
  const countSelectable = !!product && isCountSelectable(product);
  const baseAmount = product ? (computeBaseAmount(product, selectedCount) ?? product.price) : 0;
  // 센터가 회원에게 지급한 실제 쿠폰(member_coupons)만 쓴다. 플랫폼 기본/데모 쿠폰(과거 하드코딩
  // 프로모코드)은 2026-10-01에 제거됨. 여기서 미리보기로 계산/표시하는 할인액은 UX용이고, 실제
  // 자격/금액은 결제 확정 RPC(fulfill_order/_issue_membership_and_record_payment)가 공통 함수
  // _order_expected_amount로 다시 검증·계산한다(소유자 확인, 센터 일치, 유효기간, 최소금액 등).
  const [applicableCoupons, setApplicableCoupons] = useState<MemberCoupon[]>([]);
  const [selectedMemberCouponId, setSelectedMemberCouponId] = useState<string | null>(null);
  const [autoBook, setAutoBook] = useState(true);
  // 2026-10-01(Batch C, C-9) — 구매 시 요일/시간 선택형 수강권. product.weekdaySelectable일
  // 때만 의미 있고, 선택 후보(scheduleOptions)는 이 상품의 기존 예약조건에서 계산된다
  // (lib/center.ts fetchPurchaseScheduleOptions, 새 스케줄 데이터 없음).
  const [scheduleOptions, setScheduleOptions] = useState<SelectableSchedule | null>(null);
  const [scheduleOptionsFailed, setScheduleOptionsFailed] = useState(false);
  const [selectedScheduleDay, setSelectedScheduleDay] = useState<number | null>(null);
  const [selectedScheduleTime, setSelectedScheduleTime] = useState<string | null>(null);
  const [myPoints, setMyPoints] = useState(0);
  const [usePoint, setUsePoint] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 앱 복귀 후 PG 주문 상태 확인 중 / 확인 기간이 지나도 pending인 상태(결제 버튼 비활성 + 안내)
  const [pgChecking, setPgChecking] = useState(false);
  const [pgUnresolved, setPgUnresolved] = useState(false);
  const [done, setDone] = useState(false);
  // "direct"(직접결제, 센터에서 결제)는 PG를 거치지 않고 주문만 pending으로 접수한다 —
  // 실제 결제 완료가 아니므로 done 화면 문구를 구분해서 보여줘야 한다.
  const [pendingManualPayment, setPendingManualPayment] = useState(false);
  const [issuedMembershipId, setIssuedMembershipId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 가족(다중 프로필) 계정에서 "이 수강권은 누구 앞으로"를 고를 수 있게 함 — 프로필이
  // 1개뿐이면 고를 게 없으니 UI 자체를 숨기고 기존처럼 자동 배정한다.
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (!PG_CHECKOUT_ENABLED) {
        // 전역 게이트가 꺼져 있을 때만 굳이 계정을 조회한다 — 이미 켜져 있으면(정식 오픈
        // 이후) 매 결제마다 불필요한 조회를 늘릴 이유가 없다.
        try {
          const override = await fetchMyPgCheckoutOverride();
          if (override) {
            setPgCheckoutEnabled(true);
            setPayMethod("card");
          }
        } catch { /* 심사관 계정이 아니면(비로그인 포함) 조용히 무시 — 기본값(직접결제)만 보임 */ }
      }
      const c = await fetchCenterDetail(centerId);
      setCenterName(c?.name ?? "");
      setAllowedPay(c?.payMethods ?? null);
      try { setMyPoints(await fetchMyPoints(centerId)); } catch { /* 무시 */ }
      try {
        const profs = await fetchProfiles();
        setProfiles(profs);
        if (profs.length > 0) setSelectedProfileId(profs[0].id);
      } catch { /* 비로그인 — 무시, 결제 시점에 로그인 유도 */ }
      const products = await fetchCenterProductsForPurchase(centerId);
      const found = products.find((p) => p.id === productId) ?? null;
      setProduct(found);
      if (found && isCountSelectable(found)) {
        // URL의 count/size를 유효한 값이면 그대로, 아니면 최소 횟수로 시작(구매 sheet → checkout 선택 보존)
        const want = Number(sp.get("count"));
        setSelectedCount(computeBaseAmount(found, want) != null ? want : found.minCount);
      }
      const wantSize = sp.get("size");
      if (found?.sizes && wantSize && found.sizes.includes(wantSize)) setSelectedSize(wantSize);
      if (found?.weekdaySelectable) {
        try { setScheduleOptions(await fetchPurchaseScheduleOptions(found.id)); setScheduleOptionsFailed(false); }
        catch { setScheduleOptionsFailed(true); }   // 조회 실패를 "후보 없음"으로 숨기지 않는다
      }
    } catch (e: any) { setError(toUserMessage(e)); }
    finally { setLoading(false); }
  }, [centerId, productId]);
  useEffect(() => { load(); }, [load]);

  // 이 상품에 지금 실제로 쓸 수 있는 회원 쿠폰만 조회(요청 15번 "쿠폰 선택 UI는 usable
  // 쿠폰이 있을 때만"). 비로그인/쿠폰 없음이면 조용히 빈 목록 — 화면 자체는 그대로 진행.
  // 수강권/상품별 "쿠폰 적용 불가" 옵션(add_product_coupon_eligibility.sql) — 이 상품이
  // couponEligible=false면 조회 자체를 안 한다(UI에 아예 안 보여줌). 실제 자격은 어차피
  // 결제 확정 RPC가 다시 막지만(_issue_membership_and_record_payment), 여기서 먼저
  // 걸러야 "쓸 수 없는 쿠폰을 굳이 보여줬다가 결제 시점에 막히는" 혼란을 안 준다.
  useEffect(() => {
    if (!product || !product.couponEligible) { setApplicableCoupons([]); return; }
    let mounted = true;
    fetchApplicableCoupons(product.id, baseAmount)
      .then((list) => { if (mounted) setApplicableCoupons(list); })
      .catch(() => { if (mounted) setApplicableCoupons([]); });
    return () => { mounted = false; };
  }, [product, baseAmount]);

  // 실제 PG(토스) 결제창은 app/checkout/success로 리다이렉트된 뒤 이 페이지로 다시
  // 돌아온다(같은 조회 쿼리 + paymentDone/paymentError 추가) — 그때 기존 "결제 완료"
  // 화면을 그대로 재사용한다(Mock의 즉시-확정 흐름과 화면을 공유). 최초 마운트 시
  // 한 번만 확인하면 되는 값이라 의존성 배열을 비워둔다.
  useEffect(() => {
    if (sp.get("paymentDone") === "1") {
      setIssuedMembershipId(sp.get("membershipId"));
      setDone(true);
    } else if (sp.get("paymentError")) {
      setError(sp.get("paymentError"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 외부 Safari에서 결제를 마치고 앱(WebView)으로 돌아오면 이 화면의 로그인 세션으로 주문 상태를 확인한다(짧게 제한된 재시도만).
  // 외부 Safari로 이동하면 handlePay의 finally가 돌아오지 않아 busy가 남을 수 있으므로 terminal 상태에서 명시적으로 풀어준다.
  const checkPendingRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let running = false;
    async function check() {
      const pending = readPendingPgOrder();
      if (!pending || running) return;
      running = true;
      setPgChecking(true);
      try {
        for (let i = 0; i < 5 && alive; i++) {   // 최대 5회(약 10초) — 무한 polling 금지
          const { data } = await supabase.from("orders").select("status").eq("id", pending.orderId).maybeSingle();
          const st = (data as { status?: string } | null)?.status;
          if (st === "done") { clearPendingPgOrder(); if (alive) { setBusy(false); setPgUnresolved(false); setError(null); setDone(true); } return; }
          if (st === "cancelled") { clearPendingPgOrder(); if (alive) { setBusy(false); setPgUnresolved(false); setError("결제가 취소됐어요. 다시 시도해주세요."); } return; }
          if (!st) { clearPendingPgOrder(); if (alive) { setBusy(false); setPgUnresolved(false); } return; }
          await new Promise((r) => setTimeout(r, 2000));
        }
        // 계속 pending: 영구 "처리 중..."에 가두지 않는다. 중복 결제를 막기 위해 결제 버튼은 비활성으로 두되 "다시 확인"/구매내역 안내를 보여주고,
        // marker는 유지해 다음 foreground에서 다시 확인한다.
        if (alive) { setBusy(false); setPgUnresolved(true); }
      } finally { running = false; if (alive) setPgChecking(false); }
    }
    checkPendingRef.current = () => { void check(); };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    void check();
    return () => { alive = false; document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, []);

  // 예약창에서 들어온 구매를 완료하면, 잠깐 완료 안내를 보여준 뒤 자동으로 그 예약 화면으로 돌아감
  // (기존 예약/결제 로직은 그대로 두고, 화면 전환만 자동화 — 즉시 클릭할 수 있는 버튼도 함께 남겨둠)
  useEffect(() => {
    // 직접결제(direct)는 아직 실제로 결제되지 않아 예약에 쓸 수강권이 없다 — 자동 복귀시키지 않는다.
    if (!done || !reservationBackUrl || pendingManualPayment) return;
    const t = setTimeout(() => {
      window.location.href = reservationBackUrl;
    }, 1800);
    return () => clearTimeout(t);
  }, [done, reservationBackUrl, pendingManualPayment]);

  // 자동예약 요일: 상품에 고정된 요일(auto_book_days)이거나, 구매 시 회원이 고른 요일(weekdaySelectable).
  const autoBookDaysEffective: number[] = product?.autoBookDays && product.autoBookDays.length > 0
    ? product.autoBookDays
    : product?.weekdaySelectable && selectedScheduleDay !== null ? [selectedScheduleDay] : [];
  const showAutoBook = autoBookDaysEffective.length > 0;
  const autoBookRequested = showAutoBook && autoBook;
  // 화면에 보이는 결제수단(PG 게이트 + 센터 pay_methods + direct 안전 대체)
  const visibleMethodIds = visiblePayMethodIds({
    pgEnabled: pgCheckoutEnabled, allowed: allowedPay, all: PAY_METHODS.map((m) => m.id),
  });

  const effectivePayMethodUi = resolveSelectedPayMethod(payMethod, visibleMethodIds);

  const scheduleState = purchaseScheduleState(product, scheduleOptions, scheduleOptionsFailed, selectedScheduleDay, selectedScheduleTime);

  async function handlePay() {
    if (!product) return;
    // 선택형: 가격표에 없는 횟수는 결제를 진행하지 않는다(서버도 같은 기준으로 주문 생성을 거부한다).
    if (countSelectable && computeBaseAmount(product, selectedCount) == null) {
      setError("구매할 횟수를 선택해주세요");
      return;
    }
    // 사이즈 있는 상품인데 미선택
    if (product.sizes && product.sizes.length > 0 && !selectedSize) {
      setError("사이즈를 선택해주세요");
      return;
    }
    // 공개(비로그인) 목록으로 만든 모델은 요일/시간 선택 설정을 알 수 없다 — 이 상태로 결제하지 않는다.
    if (product.publicFallback) {
      setError("로그인 정보를 확인하지 못했어요. 다시 로그인한 뒤 시도해주세요.");
      return;
    }
    // 2026-10-01(Batch C, C-9) — 요일/시간 선택형 수강권은 고르기 전엔 결제를 막는다
    // (선택 없이 구매되면 이후 예약 제한을 걸 기준 자체가 없어지므로). direct/PG 분기보다 먼저 판정한다.
    if (scheduleState.blocked) {
      setError(scheduleState.message ?? "수강 요일 정보를 불러오는 중이에요. 잠시 후 다시 시도해주세요.");
      return;
    }
    // 숨겨진 PG 수단이 선택된 채 결제가 진행되는 일이 없도록 화면에 보이는 수단으로 한 번 더 보정한다.
    const effectivePayMethod = resolveSelectedPayMethod(payMethod, visibleMethodIds);
    if (effectivePayMethod !== payMethod) setPayMethod(effectivePayMethod);
    // "direct"(직접결제, 센터에서 결제)는 PG 자체를 거치지 않는다 — 실제 PG 연동 전
    // 이 앱의 원래 흐름과 동일하게 주문만 pending으로 만들고, 매니저가 결제를 확인한 뒤
    // 기존 "미발급 주문" 화면(fulfill_order)에서 수동으로 발급한다.
    if (effectivePayMethod === "direct") {
      setBusy(true);
      let directOrderIdForCleanup: string | null = null;
      try {
        // [SEC-118] 포인트는 주문번호와 묶여야 서버가 나중에 "실제로 이 주문에서 차감됐는지"
        // 확인할 수 있다(orders.points_used를 그냥 믿지 않음) — 주문을 먼저 만들고 그 id로
        // usePoints를 호출한다(예전엔 반대 순서였음).
        const directOrderId = await createOrder({
          centerId, productId: product.id, productName: product.name,
          amount: finalTotal, payMethod: effectivePayMethod,
          selectedSize: selectedSize ?? undefined,
          selectedCount: countSelectable ? selectedCount : undefined,
          discountAmount: memberCouponDiscount,
          // 2026-10-01 — fulfill_order()가 이제 PG 경로와 같은 공통 검증(_order_expected_amount)으로
          // 센터 쿠폰의 소유/센터/유효기간/최소금액을 확인하고 발급 성공 시 used 처리까지 하므로
          // 직접결제에서도 쿠폰 ID를 보낸다. 최종 금액은 서버가 다시 계산해 비교한다.
          memberCouponId: selectedMemberCouponId ?? undefined,
          autoBook: autoBookRequested,
          pointsUsed: pointToUse,
          profileId: selectedProfileId || undefined,
          selectedDayOfWeek: product.weekdaySelectable ? selectedScheduleDay : undefined,
          selectedStartTime: product.weekdaySelectable && product.timeSelectable ? selectedScheduleTime : undefined,
          // 실제 결제가 없으므로 PG provider를 붙이지 않는다(mock/toss 어느 쪽 확정
          // 로직도 이 주문을 건드리지 않아야 함 — 매니저 수동 발급 전용 경로).
        });
        directOrderIdForCleanup = directOrderId;
        if (pointToUse > 0) await usePoints(centerId, pointToUse, directOrderId);
        directOrderIdForCleanup = null;
        setPendingManualPayment(true);
        setDone(true);
      } catch (e: any) {
        // 포인트 차감이 실패한 주문이 pending으로 남아 관리자 목록에 보이지 않게 정리(취소 시 DB가 이미 차감된 포인트가 있으면 복원).
        await cancelMyPendingOrderQuietly(directOrderIdForCleanup);
        setError(toUserMessage(e));
      }
      finally { setBusy(false); }
      return;
    }
    // 나머지(카드/카카오페이/토스페이/계좌이체)는 실제 PG 결제창을 거친다.
    if (resolveProviderName() === "toss" && !TOSS_SUPPORTED_METHODS.includes(effectivePayMethod)) {
      setError("지금은 카드/계좌이체만 가능해요");
      return;
    }
    setBusy(true);
    let pgOrderIdForCleanup: string | null = null;
    try {
      // 화면에 표시된 값과 동일하게 계산 (pointToUse/finalTotal은 상단에서 계산됨)
      const finalAmount = finalTotal;
      const providerName = resolveProviderName();
      const orderId = await createOrder({
        centerId, productId: product.id, productName: product.name,
        amount: finalAmount, payMethod: effectivePayMethod,
        selectedSize: selectedSize ?? undefined,
        selectedCount: countSelectable ? selectedCount : undefined,
        discountAmount: memberCouponDiscount,
        memberCouponId: selectedMemberCouponId ?? undefined,
        autoBook: autoBookRequested,
        pointsUsed: pointToUse,
        profileId: selectedProfileId || undefined,
        selectedDayOfWeek: product.weekdaySelectable ? selectedScheduleDay : undefined,
        selectedStartTime: product.weekdaySelectable && product.timeSelectable ? selectedScheduleTime : undefined,
        provider: providerName, // Payment Adapter Pattern: env(NEXT_PUBLIC_PAYMENT_PROVIDER)로 전환
      });
      pgOrderIdForCleanup = orderId;
      // [SEC-118] 주문을 먼저 만들고 그 id로 포인트를 사용한다 — 서버가 나중에 확정 시점에
      // "이 주문번호로 실제 차감된 point_transactions 행이 있는지"로 points_used를 검증한다.
      if (pointToUse > 0) await usePoints(centerId, pointToUse, orderId);

      const paymentService = getPaymentService(mockScenarioOverride);

      // 실제 PG 결제창(토스 등)은 successUrl/failUrl로 돌아오는 리다이렉트 기반이라, 지금
      // 조회 중인 쿼리(센터/상품/예약 복귀 정보)를 그대로 유지해 돌아온 뒤 이 화면이 같은
      // 컨텍스트로 "결제 완료"를 보여줄 수 있게 한다. Mock은 이 값들을 그냥 무시한다.
      const returnQuery = new URLSearchParams(window.location.search);
      // 토스 결제창은 외부 Safari에서 열릴 수 있어(iOS 앱) 복귀 콜백이 앱의 로그인 세션을 공유하지 않는다 — Supabase 토큰 대신
      // 서버가 발급한 "이 주문 전용 복귀 토큰"만 URL에 싣는다. 발급 실패 시 결제창을 열지 않고(catch가 방금 만든 pending 주문을 정리) 오류를 보여준다.
      if (providerName === "toss") {
        returnQuery.set("returnToken", await requestReturnToken(orderId));   // 실패하면 throw → marker 저장 없이 catch가 pending 주문 정리
        // 정상 결제창 진입에서는 createPayment()가 이 WebView로 돌아오지 않을 수 있으므로 marker는 결제창을 열기 "직전"에 저장한다.
        savePendingPgOrder(orderId);
      }
      const successUrl = `${window.location.origin}/checkout/success?${returnQuery.toString()}`;
      const failUrl = `${window.location.origin}/checkout/fail?${returnQuery.toString()}`;
      const { data: userData } = await supabase.auth.getUser();

      const created = await paymentService.createPayment({
        orderId, amount: finalAmount, orderName: product.name,
        customerEmail: userData.user?.email ?? undefined,
        customerKey: userData.user?.id,
        successUrl, failUrl,
        method: effectivePayMethod === "transfer" ? "TRANSFER" : "CARD",
        easyPay: EASY_PAY_BY_METHOD[effectivePayMethod],
      });

      if (created.redirected) {
        // 브라우저가 이미 결제창으로 이동 중 — 여기서 더 할 일 없음(성공 시 이 컴포넌트는
        // 언마운트된다). requestPayment가 reject되면(예: 사용자가 결제창을 즉시 닫음)
        // catch 블록으로 넘어가 busy가 풀린다.
        pgOrderIdForCleanup = null;   // 결제창이 열린 뒤의 취소/실패는 /checkout/fail이 정리한다
        return;
      }

      const result = await paymentService.confirmPayment(created.paymentKey, orderId);

      if (result.status === "paid") {
        pgOrderIdForCleanup = null;
        setIssuedMembershipId(result.membershipId ?? null);
        setDone(true);
      } else if (result.status === "cancelled") {
        setError(result.message ?? "결제가 취소됐어요. 다시 시도해주세요.");
      } else {
        // 실패한 주문이 pending으로 남아 있으면 재시도(새 주문)가 포인트를 또 차감하므로 정리한다(done이면 취소되지 않음).
        await cancelMyPendingOrderQuietly(pgOrderIdForCleanup);
        setError(result.message ?? "결제에 실패했어요. 다시 시도해주세요.");
      }
    } catch (e: any) {
      // createPayment/토큰 발급이 실패한 경우: pending 주문 정리 + 앱 복귀용 marker 제거(포인트 복원은 기존 DB 취소 트리거)
      await cancelMyPendingOrderQuietly(pgOrderIdForCleanup);
      clearPendingPgOrder();
      setError(toUserMessage(e));
    }
    finally { setBusy(false); }
  }

  function won(n: number) { return n.toLocaleString("ko-KR") + "원"; }

  const selectedMemberCoupon = applicableCoupons.find((c) => c.id === selectedMemberCouponId) ?? null;
  const memberCouponDiscount = product && selectedMemberCoupon ? previewDiscount(baseAmount, selectedMemberCoupon) : 0;
  // 포인트는 (상품가 - 센터 쿠폰 할인) 범위 안에서만, 보유량 한도로 사용
  const afterCoupon = product ? Math.max(0, baseAmount - memberCouponDiscount) : 0;
  const pointToUse = Math.min(parseInt(usePoint || "0", 10) || 0, myPoints, afterCoupon);
  const finalTotal = Math.max(0, afterCoupon - pointToUse);

  if (loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href={centerBackHref}>‹</a>
          <div className="title">결제</div>
          <div className="side" />
        </div>
        <Loading />
      </div>
    );
  }

  if (done) {
    // 실제 이용 가능한 수강권이 자동 발급됐는지: goods(대여상품)가 아니라 pass(수강권)이면서
    // 발급 RPC가 실제로 membership_id를 돌려준 경우에만 "수강권 등록" 문구를 씀
    const passIssued = product?.kind === "pass" && !!issuedMembershipId;
    return (
      <div className="app-shell">
        <div className="checkout-done">
          <div className="checkout-done-icon" aria-hidden="true" />
          <div className="checkout-done-title">
            {pendingManualPayment
              ? "주문이 접수됐어요"
              : resolveProviderName() === "mock" ? "테스트 결제가 완료됐어요" : "결제가 완료됐어요"}
          </div>
          <div className="checkout-done-sub">
            {centerName}<br />
            {product?.name}{countSelectable && selectedCount ? ` · ${selectedCount}회` : ""} · {won(baseAmount)}<br /><br />
            {pendingManualPayment ? (
              "센터에 방문하거나 연락해 결제를 완료해주세요. 결제 확인 후 이용권이 발급돼요."
            ) : (
              <>
                {resolveProviderName() === "mock" && <>(Mock) 실제 PG 연동 전 테스트 결제예요.<br /></>}
                {passIssued
                  ? "상품 구매가 완료되었으며 이용 가능한 수강권이 등록되었습니다."
                  : "상품 구매가 완료되었습니다."}
              </>
            )}
          </div>
          {!pendingManualPayment && reservationBackUrl ? (
            <>
              <div className="checkout-done-sub" style={{ marginTop: 4 }}>
                잠시 후 아까 그 수업 예약 화면으로 자동으로 돌아가요.<br />
                바로 예약을 진행할 수 있어요.
              </div>
              <a
                className="primary-btn"
                href={reservationBackUrl}
                style={{ margin: "20px", display: "block", width: "calc(100% - 40px)", textAlign: "center" }}
              >
                지금 바로 예약 이어가기
              </a>
              <a className="ghost-btn" href="/mypage" style={{ margin: "0 20px", display: "block", width: "calc(100% - 40px)", textAlign: "center" }}>
                마이페이지로
              </a>
            </>
          ) : (
            <>
              {/* UX 감사(A-16) — 방금 만든 주문은 /purchases에 있는데 거기로 가는 링크가
                  없어 마이페이지를 거쳐 한 단계 더 들어가야 했다. 1순위 버튼으로 승격. */}
              <a className="primary-btn" href="/purchases" style={{ margin: "20px", display: "block", width: "calc(100% - 40px)", textAlign: "center" }}>
                구매 내역 보기
              </a>
              <a className="ghost-btn" href={`/center/${centerId}`} style={{ margin: "0 20px", display: "block", width: "calc(100% - 40px)", textAlign: "center" }}>
                센터로 돌아가기
              </a>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href={centerBackHref}>‹</a>
          <div className="title">결제</div>
          <div className="side" />
        </div>
        <ErrorState
          title="상품 정보를 찾을 수 없어요"
          description="링크가 만료됐거나 상품이 삭제됐을 수 있어요."
          action={<>
            <a className="primary-btn" href="/cart">장바구니로 가기</a>
            <a className="ghost-btn" style={{ marginTop: 8 }} href="/">홈으로</a>
          </>}
        />
      </div>
    );
  }

  return (
    <div className="app-shell commerce-page checkout-page-v2">
      {error && (
        <div className={`error-toast${error === "로그인이 필요해요" ? " error-toast-with-action" : ""}`}>
          {error}<button onClick={() => setError(null)}>×</button>
          {error === "로그인이 필요해요" && (
            <a className="error-toast-action" href={loginHrefWithReturnToHere()}>로그인 하러 가기</a>
          )}
        </div>
      )}

      <div className="back-header">
        <a className="side" href={centerBackHref}>‹</a>
        <div className="title">결제</div>
        <div className="side" />
      </div>

      {/* 주문서 */}
      <div className="commerce-title"><strong>주문 상품</strong><span>1개</span></div>
      <div className="checkout-order">
        <div className="checkout-order-center">{centerName}</div>
        <div className="checkout-order-row">
          <span className="checkout-order-name">
            <span className={`product-kind-tag ${product.kind}`}>{product.kind === "goods" ? "상품" : "수강권"}</span>
            {product.name}
          </span>
          <span className="checkout-order-price">{won(baseAmount)}</span>
        </div>
        <div className="checkout-order-detail">
          {countSelectable
            ? `${selectedCount ?? "-"}회 · ${won(baseAmount)}${selectedSize ? ` · ${selectedSize}` : ""}`
            : product.unlimited ? "무제한" : product.totalCount ? `${product.totalCount}회` : ""}
        </div>
        {countSelectable && (
          <div className="checkout-count-select">
            <label>
              <span>구매 횟수</span>
              <select aria-label="구매 횟수" value={selectedCount ?? ""} disabled={busy}
                onChange={(e) => setSelectedCount(Number(e.target.value))}>
                {sortedTiers(product).map((t) => <option key={t.count} value={t.count}>{countOptionLabel(t)}</option>)}
              </select>
            </label>
          </div>
        )}
        {product.description && (
          <div className="checkout-order-desc">{product.description}</div>
        )}
      </div>

      {/* 구매 대상 프로필 (가족 등 프로필이 여러 개일 때만 표시) */}
      {profiles.length > 1 && (
        <>
          <div className="menu-section-label">누구 앞으로 구매할까요?</div>
          <div className="mem-filters">
            {profiles.map((p) => (
              <button key={p.id} className={`filter-chip ${selectedProfileId === p.id ? "on" : ""}`}
                onClick={() => setSelectedProfileId(p.id)}>
                {p.name}{p.isPrimary ? " (본인)" : ""}
              </button>
            ))}
          </div>
        </>
      )}

      {/* 2026-10-01(Batch C, C-9) — 구매 시 요일/시간 선택. 선택 전엔 handlePay()가
          결제를 막는다. 후보(scheduleOptions)는 이 상품의 기존 예약조건에서 계산돼서
          매니저가 등록한 실제 요일/시간만 보여준다(새 데이터 없음). */}
      {product.weekdaySelectable && (
        <>
          <div className="menu-section-label">수강 요일</div>
          {scheduleOptionsFailed ? (
            <div className="perm-guide" style={{ margin: "0 20px" }}>
              수강 요일 정보를 불러오지 못했어요. 새로고침 후 다시 시도해주세요.
            </div>
          ) : scheduleOptions === null ? (
            <div className="perm-guide" style={{ margin: "0 20px" }}>요일 정보를 불러오는 중이에요…</div>
          ) : scheduleOptions.days.length === 0 ? (
            <div className="perm-guide" style={{ margin: "0 20px" }}>
              아직 선택 가능한 요일이 설정되지 않아 구매할 수 없어요. 센터에 문의해주세요.
            </div>
          ) : (
            <>
              <div className="mem-filters">
                {scheduleOptions.days.map((d) => (
                  <button
                    key={d} aria-pressed={selectedScheduleDay === d}
                    className={`filter-chip ${selectedScheduleDay === d ? "on" : ""}`}
                    onClick={() => { setSelectedScheduleDay(d); setSelectedScheduleTime(null); }}
                  >
                    {DAYS[d]}요일
                  </button>
                ))}
              </div>
              {product.timeSelectable && selectedScheduleDay !== null && (
                <>
                  <div className="menu-section-label">수업 시간</div>
                  {(scheduleOptions.timesByDay[selectedScheduleDay] ?? []).length === 0 ? (
                    <div className="perm-guide" style={{ margin: "0 20px" }}>
                      이 요일엔 선택 가능한 시간이 설정되지 않았어요. 센터에 문의해주세요.
                    </div>
                  ) : (
                    <div className="mem-filters">
                      {(scheduleOptions.timesByDay[selectedScheduleDay] ?? []).map((t) => (
                        <button
                          key={t} aria-pressed={selectedScheduleTime === t}
                          className={`filter-chip ${selectedScheduleTime === t ? "on" : ""}`}
                          onClick={() => setSelectedScheduleTime(t)}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}

      {/* 사이즈 선택 (대여상품 등) */}
      {product.sizes && product.sizes.length > 0 && (
        <>
          <div className="menu-section-label">사이즈 선택</div>
          <div className="mem-filters">
            {product.sizes.map((s) => (
              <button key={s} className={`filter-chip ${selectedSize === s ? "on" : ""}`} onClick={() => setSelectedSize(s)}>{s}</button>
            ))}
          </div>
        </>
      )}

      {/* 요일반 자동예약 */}
      {showAutoBook && (
        <>
          <div className="menu-section-label">자동 예약</div>
          <div className="autobook-box">
            <div className="set-row" style={{ padding: 0, borderBottom: "none" }}>
              <div className="set-label">
                {autoBookDaysEffective.map((d) => ["일","월","화","수","목","금","토"][d]).join("·")}요일 수업 자동 예약
                <br />
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  결제 확인 후 가까운 날짜부터 남은 횟수만큼 예약해드려요. 수강권 만료일 이후 수업은 예약하지 않아요.
                </span>
              </div>
              <button className={`switch ${autoBook ? "on" : ""}`} onClick={() => setAutoBook((v) => !v)}>
                <span className="knob" />
              </button>
            </div>
          </div>
          {!autoBook && (
            <div className="perm-guide" style={{ margin: "6px 20px 0" }}>
              끄면 예약은 직접 하셔야 해요.
            </div>
          )}
        </>
      )}

      {/* 센터가 회원에게 지급한 쿠폰 — 쓸 수 있는 쿠폰이 있을 때만 보여준다(없으면 영역 자체를 숨김).
          최종 할인금액은 항상 결제 확정 시점에 서버가 다시 계산 — 여기 미리보기 숫자를 그대로 믿지 않는다. */}
      {applicableCoupons.length > 0 && (
        <>
          <div className="menu-section-label commerce-label">내 쿠폰</div>
          <div className="coupon-list">
            <button
              className={`coupon-item ${selectedMemberCouponId === null ? "on" : ""}`}
              onClick={() => setSelectedMemberCouponId(null)}
            >
              <span className="coupon-label">쿠폰 사용 안 함</span>
            </button>
            {applicableCoupons.map((c) => (
              <button
                key={c.id}
                className={`coupon-item ${selectedMemberCouponId === c.id ? "on" : ""}`}
                onClick={() => setSelectedMemberCouponId(c.id)}
              >
                <span className="coupon-label">{c.couponName}</span>
                <span className="coupon-amount">-{won(previewDiscount(baseAmount, c))}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* 포인트 */}
      {myPoints > 0 && (
        <>
          <div className="menu-section-label">
            포인트 <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 500 }}>· 보유 {myPoints.toLocaleString("ko-KR")}P</span>
          </div>
          <div className="commerce-code-row">
            <input className="input-field" style={{ flex: 1 }} inputMode="numeric" placeholder="사용할 포인트"
              value={usePoint} onChange={(e) => setUsePoint(e.target.value.replace(/[^0-9]/g, ""))} />
            <button className="ghost-btn" style={{ flex: "0 0 80px" }}
              onClick={() => setUsePoint(String(Math.min(myPoints, Math.max(0, baseAmount - memberCouponDiscount))))}>
              전액
            </button>
          </div>
          <div className="perm-guide" style={{ margin: "6px 20px 0" }}>
            결제 금액 내에서 사용할 수 있어요.
          </div>
        </>
      )}

      {/* 결제 수단 */}
      <div className="menu-section-label commerce-label">결제 수단</div>
      <div className="pay-methods">
        {PAY_METHODS
          .filter((m) => visibleMethodIds.includes(m.id))
          .map((m) => (
          <button key={m.id} className={`pay-method ${effectivePayMethodUi === m.id ? "on" : ""}`} onClick={() => setPayMethod(m.id)}>
            <span className="pay-method-emoji">
              {m.dot ? <span className="vendor-dot" style={{ background: m.dot }} /> : <UiIcon name={m.icon!} size={20} />}
            </span>
            <span>{m.label}</span>
            <span className="pay-method-check">{effectivePayMethodUi === m.id ? "●" : "○"}</span>
          </button>
        ))}
      </div>
      {!pgCheckoutEnabled ? (
        <div className="perm-guide" style={{ margin: "10px 20px" }}>
          온라인 결제(카드·계좌이체)는 준비 중이라, 지금은 센터에서
          직접 결제만 가능해요.
        </div>
      ) : resolveProviderName() === "mock" ? (
        <div className="perm-guide" style={{ margin: "10px 20px" }}>
          실제 PG(카드 등) 연동은 준비 중이라, 지금은 테스트 결제(Mock)로 처리돼요.
        </div>
      ) : effectivePayMethodUi === "card" && resolveProviderName() === "toss" && (
        // 실기기 QA(2026-09-29) — 카드사별 결제 가능 여부는 토스 결제창(PG)이 직접 제어한다
        // (이 앱이 카드사 목록 UI를 따로 구현하지 않음). 일부 카드사(예: 카드사 심사 진행 중)는
        // 결제창에서 바로 확인되므로, 앱에서는 과도하게 구체적인 안내 대신 자연스러운 문구만.
        <div className="perm-guide" style={{ margin: "10px 20px" }}>
          카드 결제창에서 일부 카드사는 아직 준비 중일 수 있어요.
        </div>
      )}
      {effectivePayMethodUi === "direct" && (
        <div className="perm-guide" style={{ margin: "10px 20px" }}>
          결제 없이 주문만 접수돼요. 센터에서 결제를 확인하면 이용권이 발급돼요.
        </div>
      )}

      {/* 결제 금액 + 버튼 */}
      {memberCouponDiscount > 0 && (
        <div className="checkout-discount-row">
          <span>쿠폰 할인</span>
          <span>-{won(memberCouponDiscount)}</span>
        </div>
      )}
      {pointToUse > 0 && (
        <div className="checkout-discount-row">
          <span>포인트 사용</span>
          <span>-{won(pointToUse)}</span>
        </div>
      )}
      <div className="checkout-total">
        <span>총 결제 금액</span>
        <b>{won(finalTotal)}</b>
      </div>
      {scheduleState.required && scheduleState.blocked && scheduleState.message && (
        <div className="perm-guide" style={{ margin: "0 20px 8px" }} role="alert">{scheduleState.message}</div>
      )}
      {pgUnresolved && (
        <div className="perm-guide is-warning" style={{ margin: "0 20px 8px" }} role="status">
          결제 결과를 확인하는 중이에요. 중복 결제를 막기 위해 결제 버튼을 잠시 막았어요.
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            <button type="button" className="quiet-action" disabled={pgChecking} onClick={() => checkPendingRef.current()}>{pgChecking ? "확인 중..." : "다시 확인"}</button>
            <a className="quiet-action" href="/purchases">구매내역 확인</a>
          </div>
        </div>
      )}
      <button className="primary-btn checkout-pay-btn" disabled={busy || pgUnresolved || (scheduleState.required && ["loading", "load_failed", "no_options", "no_times"].includes(scheduleState.reason))} onClick={handlePay}>
        {busy ? "처리 중..." : pgUnresolved ? "결제 결과 확인 중" : `${won(finalTotal)} 결제하기`}
      </button>
      <div style={{ textAlign: "center", marginTop: 10, fontSize: 12, color: "var(--text-dim)" }}>
        결제 시 <a href="/legal/refund" target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>환불 정책</a>과{" "}
        <a href="/legal/terms" target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>이용약관</a>에 동의하는 것으로 간주돼요.
      </div>
      <div style={{ height: 30 }} />
    </div>
  );
}
