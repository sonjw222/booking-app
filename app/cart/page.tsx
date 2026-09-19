"use client";

/*
  장바구니
  - 담은 수강권/상품 목록 (사이즈 선택 포함)
  - 주문 정보 + 쿠폰 + 결제수단까지 확인 후 한 번에 결제
*/

import { useCallback, useEffect, useState } from "react";
import { fetchCart, removeFromCart, clearCart, updateCartSize, type CartItem } from "../../lib/cart";
import { createOrder } from "../../lib/orders";
import { fetchCenterDetail } from "../../lib/center";
import Loading from "../components/Loading";
import BottomNav from "../components/BottomNav";

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

export default function CartPage() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [payMethod, setPayMethod] = useState("card");
  const [allowedPay, setAllowedPay] = useState<string[] | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [discount, setDiscount] = useState(0);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const list = await fetchCart();
      setItems(list);
      // 장바구니가 한 센터 기준이면 그 센터의 허용 결제수단 적용
      const centerIds = Array.from(new Set(list.map((i) => i.centerId)));
      if (centerIds.length === 1) {
        try {
          const c = await fetchCenterDetail(centerIds[0]);
          setAllowedPay(c?.payMethods ?? null);
          if (c?.payMethods && c.payMethods.length > 0) setPayMethod(c.payMethods[0]);
        } catch { /* 무시 */ }
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const subtotal = items.reduce((s, i) => s + i.price, 0);
  const total = Math.max(0, subtotal - discount);
  function won(n: number) { return n.toLocaleString("ko-KR") + "원"; }

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

  async function handleRemove(id: string) {
    setBusy(true);
    try { await removeFromCart(id); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleSize(it: CartItem, size: string) {
    setBusy(true);
    try {
      await updateCartSize(it.id, size);
      setItems((prev) => prev.map((x) => x.id === it.id ? { ...x, selectedSize: size } : x));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleCheckoutAll() {
    if (items.length === 0) return;
    // 사이즈 필요한데 안 고른 항목 확인
    const missing = items.find((i) => i.sizes && i.sizes.length > 0 && !i.selectedSize);
    if (missing) { setError(`'${missing.productName}'의 사이즈를 선택해주세요`); return; }

    setBusy(true);
    try {
      // 할인은 첫 항목에 적용 (단순화)
      let left = discount;
      for (const it of items) {
        const d = Math.min(left, it.price);
        left -= d;
        await createOrder({
          centerId: it.centerId, productId: it.productId, productName: it.productName,
          amount: it.price - d, payMethod,
          selectedSize: it.selectedSize ?? undefined,
          couponCode: discount > 0 ? couponInput.trim().toUpperCase() : undefined,
          discountAmount: d,
        });
      }
      await clearCart();
      setDone(true);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="app-shell">
        <div className="checkout-done">
          <div className="checkout-done-icon" aria-hidden="true" />
          <div className="checkout-done-title">주문이 접수됐어요</div>
          <div className="checkout-done-sub">
            센터에서 확인 후 발급해드려요.<br />
            결제 연동 전이라 실제 결제는 아직이에요.
          </div>
          <a className="primary-btn" href="/mypage" style={{ margin: "20px", display: "block", width: "calc(100% - 40px)", textAlign: "center" }}>마이페이지로</a>
          <a className="ghost-btn" href="/" style={{ margin: "0 20px", display: "block", width: "calc(100% - 40px)", textAlign: "center" }}>홈으로</a>
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="app-shell commerce-page cart-page-v2">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      <div className="back-header">
        <a className="side" href="/">‹</a>
        <div className="title">장바구니</div>
        <div className="side" />
      </div>

      {loading ? <Loading /> : items.length === 0 ? (
        <div className="commerce-empty">
          <div className="commerce-empty-mark" aria-hidden="true">0</div>
          <b>장바구니가 비어 있어요</b>
          <span>센터에서 수강권이나 상품을 둘러보세요.</span>
          <a className="primary-btn" href="/search">센터 찾아보기</a>
        </div>
      ) : (
        <>
          {/* 주문 정보 */}
          <div className="commerce-title"><strong>담은 상품</strong><span>{items.length}개</span></div>
          <div className="cart-list">
            {items.map((it) => (
              <div key={it.id} className="cart-row-wrap">
                <div className="cart-row">
                  <div className="commerce-product-mark">P</div><div className="cart-info">
                    <div className="cart-name">{it.productName}</div>
                    <div className="cart-price">{won(it.price)}</div>
                  </div>
                  <button className="cart-remove" disabled={busy} onClick={() => handleRemove(it.id)}>삭제</button>
                </div>
                {it.sizes && it.sizes.length > 0 && (
                  <div className="cart-sizes">
                    <span className="cart-size-label">사이즈</span>
                    {it.sizes.map((sz) => (
                      <button key={sz} className={`filter-chip ${it.selectedSize === sz ? "on" : ""}`}
                        disabled={busy} onClick={() => handleSize(it, sz)}>{sz}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 쿠폰 */}
          <div className="menu-section-label commerce-label">할인 쿠폰</div>
          <div className="commerce-code-row">
            <input className="input-field" style={{ flex: 1 }} placeholder="쿠폰 코드 입력"
              value={couponInput}
              onChange={(e) => { setCouponInput(e.target.value); setCouponMsg(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") applyCoupon(); }} />
            <button className="ghost-btn" style={{ flex: "0 0 80px" }} onClick={() => applyCoupon()}>적용</button>
          </div>
          <div className="coupon-list">
            {MY_COUPONS.map((c) => (
              <button key={c.code} className={`coupon-item ${couponInput.toUpperCase() === c.code ? "on" : ""}`}
                onClick={() => applyCoupon(c.code)}>
                <span className="coupon-label">{c.label}</span>
                <span className="coupon-amount">-{won(c.discount)}</span>
              </button>
            ))}
          </div>
          {couponMsg && (
            <div className="perm-guide" style={{ margin: "6px 20px 0", color: discount > 0 ? "#1f9d55" : "#c0392b" }}>{couponMsg}</div>
          )}

          {/* 결제 수단 */}
          <div className="menu-section-label commerce-label">결제 수단</div>
          <div className="pay-methods">
            {PAY_METHODS.filter((m) => !allowedPay || allowedPay.length === 0 || allowedPay.includes(m.id)).map((m) => (
              <button key={m.id} className={`pay-method ${payMethod === m.id ? "on" : ""}`} onClick={() => setPayMethod(m.id)}>
                <span className="pay-method-emoji">{m.emoji}</span>
                <span>{m.label}</span>
                <span className="pay-method-check">{payMethod === m.id ? "●" : "○"}</span>
              </button>
            ))}
          </div>

          {discount > 0 && (
            <div className="checkout-discount-row">
              <span>할인</span>
              <span>-{won(discount)}</span>
            </div>
          )}
          <div className="checkout-total">
            <span>총 {items.length}개 · 결제 금액</span>
            <b>{won(total)}</b>
          </div>
          <button className="primary-btn checkout-pay-btn" disabled={busy} onClick={handleCheckoutAll}>
            {busy ? "처리 중..." : `${won(total)} 결제하기`}
          </button>
          <div className="perm-guide" style={{ margin: "10px 20px" }}>
            결제 연동 전이라 주문서만 접수돼요. 센터에서 확인 후 처리해요.
          </div>
          <div style={{ height: 30 }} />
        </>
      )}
      <BottomNav />
    </div>
  );
}
