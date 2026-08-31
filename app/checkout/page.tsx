"use client";

/*
  결제 화면 (주문서)
  - 센터 상세에서 수강권/상품 "구매" → 여기로
  - 주문 정보 + 금액 + 결제수단(placeholder) + 결제하기
  - 결제 수단 연동 전이므로 "결제하기" 시 주문 생성(pending) 후 완료 안내
*/

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchCenterDetail, fetchCenterProducts, type CenterProduct } from "../../lib/center";
import { createOrder } from "../../lib/orders";
import { fetchMyPoints, usePoints } from "../../lib/reviews";
import Loading from "../components/Loading";
import { reservationReturnUrl } from "../../lib/reservationNav";
import { getPaymentService, resolveProviderName, type PaymentScenario } from "../../lib/payments";
import { supabase } from "../../lib/supabaseClient";
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

// 토스 결제창이 지금 실제로 지원하는 결제수단(MVP 범위) — 계좌이체/직접결제는 아직 준비 안 됨.
const TOSS_SUPPORTED_METHODS = ["card", "kakao", "toss"];
// payMethod → 토스 간편결제 ENUM 코드. "card"는 일반 카드결제라 매핑 없음(undefined).
const EASY_PAY_BY_METHOD: Record<string, "KAKAOPAY" | "TOSSPAY" | undefined> = {
  kakao: "KAKAOPAY",
  toss: "TOSSPAY",
};

// 보유 쿠폰 (데모)
const MY_COUPONS = [
  { code: "WELCOME", label: "신규 가입 5,000원 할인", discount: 5000 },
  { code: "FIGURE10", label: "피겨 클래스 10,000원 할인", discount: 10000 },
];

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
  const [payMethod, setPayMethod] = useState("card");
  const [selectedSize, setSelectedSize] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [discount, setDiscount] = useState(0);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [autoBook, setAutoBook] = useState(true);
  const [myPoints, setMyPoints] = useState(0);
  const [usePoint, setUsePoint] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [issuedMembershipId, setIssuedMembershipId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await fetchCenterDetail(centerId);
      setCenterName(c?.name ?? "");
      setAllowedPay(c?.payMethods ?? null);
      if (c?.payMethods && c.payMethods.length > 0) setPayMethod(c.payMethods[0]);
      try { setMyPoints(await fetchMyPoints(centerId)); } catch { /* 무시 */ }
      const products = await fetchCenterProducts(centerId);
      setProduct(products.find((p) => p.id === productId) ?? null);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId, productId]);
  useEffect(() => { load(); }, [load]);

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

  // 예약창에서 들어온 구매를 완료하면, 잠깐 완료 안내를 보여준 뒤 자동으로 그 예약 화면으로 돌아감
  // (기존 예약/결제 로직은 그대로 두고, 화면 전환만 자동화 — 즉시 클릭할 수 있는 버튼도 함께 남겨둠)
  useEffect(() => {
    if (!done || !reservationBackUrl) return;
    const t = setTimeout(() => {
      window.location.href = reservationBackUrl;
    }, 1800);
    return () => clearTimeout(t);
  }, [done, reservationBackUrl]);

  function applyCoupon(code?: string) {
    const c = (code ?? couponInput).trim().toUpperCase();
    if (!c) return;
    const found = MY_COUPONS.find((x) => x.code === c);
    if (found) {
      setDiscount(found.discount);
      setCouponInput(found.code);
      setCouponMsg(`쿠폰 적용됨: -${found.discount.toLocaleString("ko-KR")}원`);
    } else {
      setDiscount(0);
      setCouponMsg("유효하지 않은 쿠폰이에요");
    }
  }

  async function handlePay() {
    if (!product) return;
    // 사이즈 있는 상품인데 미선택
    if (product.sizes && product.sizes.length > 0 && !selectedSize) {
      setError("사이즈를 선택해주세요");
      return;
    }
    // 실제 PG(토스) 연동은 카드/카카오페이/토스페이만 지원(MVP 범위) — 계좌이체/직접결제는
    // 아직 준비 안 됐다. 화면 안내와 다르게 엉뚱한 결제창이 뜨는 혼란을 막는다.
    if (resolveProviderName() === "toss" && !TOSS_SUPPORTED_METHODS.includes(payMethod)) {
      setError("지금은 카드/카카오페이/토스페이만 가능해요");
      return;
    }
    setBusy(true);
    try {
      // 화면에 표시된 값과 동일하게 계산 (pointToUse/finalTotal은 상단에서 계산됨)
      if (pointToUse > 0) await usePoints(centerId, pointToUse);
      const finalAmount = finalTotal;
      const providerName = resolveProviderName();
      const orderId = await createOrder({
        centerId, productId: product.id, productName: product.name,
        amount: finalAmount, payMethod,
        selectedSize: selectedSize ?? undefined,
        couponCode: discount > 0 ? couponInput.trim().toUpperCase() : undefined,
        discountAmount: discount,
        autoBook: !!(product.autoBookDays && product.autoBookDays.length > 0) && autoBook,
        provider: providerName, // Payment Adapter Pattern: env(NEXT_PUBLIC_PAYMENT_PROVIDER)로 전환
      });

      const paymentService = getPaymentService(mockScenarioOverride);

      // 실제 PG 결제창(토스 등)은 successUrl/failUrl로 돌아오는 리다이렉트 기반이라, 지금
      // 조회 중인 쿼리(센터/상품/예약 복귀 정보)를 그대로 유지해 돌아온 뒤 이 화면이 같은
      // 컨텍스트로 "결제 완료"를 보여줄 수 있게 한다. Mock은 이 값들을 그냥 무시한다.
      const returnQuery = new URLSearchParams(window.location.search);
      const successUrl = `${window.location.origin}/checkout/success?${returnQuery.toString()}`;
      const failUrl = `${window.location.origin}/checkout/fail?${returnQuery.toString()}`;
      const { data: userData } = await supabase.auth.getUser();

      const created = await paymentService.createPayment({
        orderId, amount: finalAmount, orderName: product.name,
        customerEmail: userData.user?.email ?? undefined,
        customerKey: userData.user?.id,
        successUrl, failUrl,
        easyPay: EASY_PAY_BY_METHOD[payMethod],
      });

      if (created.redirected) {
        // 브라우저가 이미 결제창으로 이동 중 — 여기서 더 할 일 없음(성공 시 이 컴포넌트는
        // 언마운트된다). requestPayment가 reject되면(예: 사용자가 결제창을 즉시 닫음)
        // catch 블록으로 넘어가 busy가 풀린다.
        return;
      }

      const result = await paymentService.confirmPayment(created.paymentKey, orderId);

      if (result.status === "paid") {
        setIssuedMembershipId(result.membershipId ?? null);
        setDone(true);
      } else if (result.status === "cancelled") {
        setError(result.message ?? "결제가 취소됐어요. 다시 시도해주세요.");
      } else {
        setError(result.message ?? "결제에 실패했어요. 다시 시도해주세요.");
      }
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  function won(n: number) { return n.toLocaleString("ko-KR") + "원"; }

  // 포인트는 (상품가 - 쿠폰할인) 범위 안에서만, 보유량 한도로 사용
  const afterCoupon = product ? Math.max(0, product.price - discount) : 0;
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
            {resolveProviderName() === "mock" ? "테스트 결제가 완료됐어요" : "결제가 완료됐어요"}
          </div>
          <div className="checkout-done-sub">
            {centerName}<br />
            {product?.name} · {won(product?.price ?? 0)}<br /><br />
            {resolveProviderName() === "mock" && <>(Mock) 실제 PG 연동 전 테스트 결제예요.<br /></>}
            {passIssued
              ? "상품 구매가 완료되었으며 이용 가능한 수강권이 등록되었습니다."
              : "상품 구매가 완료되었습니다."}
          </div>
          {reservationBackUrl ? (
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
          <span className="checkout-order-price">{won(product.price)}</span>
        </div>
        <div className="checkout-order-detail">
          {product.unlimited ? "무제한" : product.totalCount ? `${product.totalCount}회` : ""}
        </div>
        {product.description && (
          <div className="checkout-order-desc">{product.description}</div>
        )}
      </div>

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
      {product.autoBookDays && product.autoBookDays.length > 0 && (
        <>
          <div className="menu-section-label">자동 예약</div>
          <div className="autobook-box">
            <div className="set-row" style={{ padding: 0, borderBottom: "none" }}>
              <div className="set-label">
                {product.autoBookDays.map((d) => ["일","월","화","수","목","금","토"][d]).join("·")}요일 수업 자동 예약
                <br />
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  결제 확인 후 가까운 날짜부터 남은 횟수만큼 예약해드려요
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

      {/* 쿠폰 */}
      <div className="menu-section-label commerce-label">할인 쿠폰</div>
      <div className="commerce-code-row">
        <input className="input-field" style={{ flex: 1 }} placeholder="쿠폰 코드 입력" value={couponInput}
          onChange={(e) => { setCouponInput(e.target.value); setCouponMsg(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") applyCoupon(); }} />
        <button className="ghost-btn" style={{ flex: "0 0 80px" }} onClick={() => applyCoupon()}>적용</button>
      </div>
      <div className="coupon-list">
        {MY_COUPONS.map((c) => (
          <button key={c.code} className={`coupon-item ${couponInput.toUpperCase() === c.code ? "on" : ""}`}
            onClick={() => applyCoupon(c.code)}>
            <span className="coupon-label">{c.label}</span>
            <span className="coupon-amount">-{c.discount.toLocaleString("ko-KR")}원</span>
          </button>
        ))}
      </div>
      {couponMsg && (
        <div className={`perm-guide ${discount > 0 ? "is-success" : "is-error"}`} style={{ margin: "6px 20px 0" }}>{couponMsg}</div>
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
              onClick={() => setUsePoint(String(Math.min(myPoints, Math.max(0, product.price - discount))))}>
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
        {PAY_METHODS.filter((m) => !allowedPay || allowedPay.length === 0 || allowedPay.includes(m.id)).map((m) => (
          <button key={m.id} className={`pay-method ${payMethod === m.id ? "on" : ""}`} onClick={() => setPayMethod(m.id)}>
            <span className="pay-method-emoji">
              {m.dot ? <span className="vendor-dot" style={{ background: m.dot }} /> : <UiIcon name={m.icon!} size={20} />}
            </span>
            <span>{m.label}</span>
            <span className="pay-method-check">{payMethod === m.id ? "●" : "○"}</span>
          </button>
        ))}
      </div>
      {resolveProviderName() === "mock" && (
        <div className="perm-guide" style={{ margin: "10px 20px" }}>
          실제 PG(카드/카카오페이 등) 연동은 준비 중이라, 지금은 테스트 결제(Mock)로 처리돼요.
        </div>
      )}
      {resolveProviderName() === "toss" && (
        <div className="perm-guide" style={{ margin: "10px 20px" }}>
          카드/카카오페이/토스페이만 지원돼요. 계좌이체/직접결제는 준비 중이에요.
        </div>
      )}

      {/* 결제 금액 + 버튼 */}
      {discount > 0 && (
        <div className="checkout-discount-row">
          <span>쿠폰 할인</span>
          <span>-{won(discount)}</span>
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
      <button className="primary-btn checkout-pay-btn" disabled={busy} onClick={handlePay}>
        {busy ? "처리 중..." : `${won(finalTotal)} 결제하기`}
      </button>
      <div style={{ height: 30 }} />
    </div>
  );
}
