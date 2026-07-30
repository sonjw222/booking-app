"use client";

/*
  결제 화면 (주문서)
  - 센터 상세에서 수강권/상품 "구매" → 여기로
  - 주문 정보 + 금액 + 결제수단(placeholder) + 결제하기
  - 결제 수단 연동 전이므로 "결제하기" 시 주문 생성(pending) 후 완료 안내
*/

import { Suspense, useCallback, useEffect, useState } from "react";
import BottomNav from "../components/BottomNav";
import { useSearchParams } from "next/navigation";
import { fetchCenterDetail, fetchCenterProducts, type CenterProduct } from "../../lib/center";
import { createOrder } from "../../lib/orders";
import { fetchMyPoints, usePoints } from "../../lib/reviews";
import Loading from "../components/Loading";
import { reservationReturnUrl } from "../../lib/reservationNav";
import { getPaymentService, type PaymentScenario } from "../../lib/payments";

const PAY_METHODS = [
  { id: "card", label: "신용/체크카드", emoji: "💳" },
  { id: "kakao", label: "카카오페이", emoji: "🟡" },
  { id: "toss", label: "토스페이", emoji: "🔵" },
  { id: "transfer", label: "계좌이체", emoji: "🏦" },
  { id: "direct", label: "직접결제 (센터에서 결제)", emoji: "🤝" },
];

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
  const centerBackHref = reserveClassId && reserveDate
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
    setBusy(true);
    try {
      // 화면에 표시된 값과 동일하게 계산 (pointToUse/finalTotal은 상단에서 계산됨)
      if (pointToUse > 0) await usePoints(centerId, pointToUse);
      const finalAmount = finalTotal;
      const orderId = await createOrder({
        centerId, productId: product.id, productName: product.name,
        amount: finalAmount, payMethod,
        selectedSize: selectedSize ?? undefined,
        couponCode: discount > 0 ? couponInput.trim().toUpperCase() : undefined,
        discountAmount: discount,
        autoBook: !!(product.autoBookDays && product.autoBookDays.length > 0) && autoBook,
        provider: "mock", // Payment Adapter Pattern: 지금은 테스트 결제(Mock)로만 처리
      });

      const paymentService = getPaymentService(mockScenarioOverride);
      const created = await paymentService.createPayment({ orderId, amount: finalAmount });
      const result = await paymentService.confirmPayment(created.paymentKey, orderId);

      if (result.status === "paid") {
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
    return (
      <div className="app-shell">
        <div className="checkout-done">
          <div className="checkout-done-icon">✅</div>
          <div className="checkout-done-title">테스트 결제가 완료됐어요</div>
          <div className="checkout-done-sub">
            {centerName}<br />
            {product?.name} · {won(product?.price ?? 0)}<br /><br />
            (Mock) 실제 PG 연동 전 테스트 결제예요.<br />
            수강권이 바로 발급됐어요.
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
              <a className="primary-btn" href="/mypage" style={{ margin: "20px", display: "block", width: "calc(100% - 40px)", textAlign: "center" }}>
                마이페이지로
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
        <div className="daylist-empty" style={{ paddingTop: 60 }}>상품 정보를 찾을 수 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      <div className="back-header">
        <a className="side" href={centerBackHref}>‹</a>
        <div className="title">결제</div>
        <div className="side" />
      </div>

      {/* 주문서 */}
      <div className="menu-section-label">주문 정보</div>
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
      <div className="menu-section-label">쿠폰</div>
      <div style={{ display: "flex", gap: 8, padding: "0 20px" }}>
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
        <div className="perm-guide" style={{ margin: "6px 20px 0", color: discount > 0 ? "#1f9d55" : "#c0392b" }}>{couponMsg}</div>
      )}

      {/* 포인트 */}
      {myPoints > 0 && (
        <>
          <div className="menu-section-label">
            포인트 <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 500 }}>· 보유 {myPoints.toLocaleString("ko-KR")}P</span>
          </div>
          <div style={{ display: "flex", gap: 8, padding: "0 20px" }}>
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
      <div className="menu-section-label">결제 수단</div>
      <div className="pay-methods">
        {PAY_METHODS.filter((m) => !allowedPay || allowedPay.length === 0 || allowedPay.includes(m.id)).map((m) => (
          <button key={m.id} className={`pay-method ${payMethod === m.id ? "on" : ""}`} onClick={() => setPayMethod(m.id)}>
            <span className="pay-method-emoji">{m.emoji}</span>
            <span>{m.label}</span>
            <span className="pay-method-check">{payMethod === m.id ? "●" : "○"}</span>
          </button>
        ))}
      </div>
      <div className="perm-guide" style={{ margin: "10px 20px" }}>
        실제 PG(카드/카카오페이 등) 연동은 준비 중이라, 지금은 테스트 결제(Mock)로 처리돼요.
      </div>

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
      <BottomNav />
    </div>
  );
}
