"use client";

/*
  장바구니
  - 담은 수강권/상품 목록 (사이즈 선택 포함)
  - 주문 정보 + 쿠폰 + 결제수단까지 확인 후 한 번에 결제
*/

import { useCallback, useEffect, useState } from "react";
import { fetchCart, addToCart, removeFromCart, clearCart, updateCartSize, updateCartCount, type CartItem } from "../../lib/cart";
import { cartItemAmount, countOptionLabel, sortedTiers } from "../../lib/selectableCount";
import { createOrder } from "../../lib/orders";
import { fetchCenterDetail } from "../../lib/center";
import { fetchProfiles, type ProfileRow } from "../../lib/profiles";
import Loading from "../components/Loading";
import UiIcon, { type IconName } from "../components/UiIcon";
import BackButton from "../components/BackButton";
import { loginHrefWithReturnToHere } from "../../lib/postLoginReturn";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import AppButton from "../components/AppButton";
import { PG_CHECKOUT_ENABLED } from "../../lib/payments";
import { fetchMyPgCheckoutOverride } from "../../lib/authAccount";
import { visiblePayMethodIds, resolveSelectedPayMethod } from "../../lib/payMethods";

// 카카오페이/토스페이는 로고 자산이 없어 outline 아이콘 하나로 뭉치면 구분이 안 되므로
// --vendor-* 색 점(dot)으로, 나머지는 의미가 통하는 outline 아이콘으로 구분한다.
const PAY_METHODS: { id: string; label: string; icon?: IconName; dot?: string }[] = [
  { id: "card", label: "신용/체크카드", icon: "card" },
  { id: "kakao", label: "카카오페이", dot: "var(--vendor-kakao)" },
  { id: "toss", label: "토스페이", dot: "var(--vendor-toss)" },
  { id: "transfer", label: "계좌이체", icon: "bank" },
  { id: "direct", label: "직접결제 (센터에서 결제)", icon: "handshake" },
];

export default function CartPage() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  // PG 게이트(토스 심사 전): 기본 결제수단은 항상 직접결제. 심사관 override 계정만 PG 수단이 열린다.
  const [pgEnabled, setPgEnabled] = useState(PG_CHECKOUT_ENABLED);
  const [payMethod, setPayMethod] = useState(PG_CHECKOUT_ENABLED ? "card" : "direct");
  const [allowedPay, setAllowedPay] = useState<string[] | null>(null);
  // 가족(다중 프로필) 계정에서 "장바구니 전체는 누구 앞으로"를 고를 수 있게 함 —
  // 프로필이 1개뿐이면 UI를 숨기고 기존처럼 자동 배정한다.
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true); setError(null); setLoadError(false);
    try {
      const list = await fetchCart();
      setItems(list);
      if (!PG_CHECKOUT_ENABLED) {
        try { if (await fetchMyPgCheckoutOverride()) { setPgEnabled(true); setPayMethod("card"); } } catch { /* 심사관 계정이 아니면 무시 */ }
      }
      try {
        const profs = await fetchProfiles();
        setProfiles(profs);
        if (profs.length > 0) setSelectedProfileId(profs[0].id);
      } catch { /* 비로그인 — 무시 */ }
      // 장바구니가 한 센터 기준이면 그 센터의 허용 결제수단 적용
      const centerIds = Array.from(new Set(list.map((i) => i.centerId)));
      if (centerIds.length === 1) {
        try {
          const c = await fetchCenterDetail(centerIds[0]);
          setAllowedPay(c?.payMethods ?? null);
        } catch { /* 무시 */ }
      }
    } catch { setLoadError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const visibleMethodIds = visiblePayMethodIds({ pgEnabled, allowed: allowedPay, all: PAY_METHODS.map((m) => m.id) });
  const effectivePayMethod = resolveSelectedPayMethod(payMethod, visibleMethodIds);
  // 횟수 선택형 row 금액 = 1회가×선택 횟수(표시용 — 주문 생성 시 서버가 다시 확정), 그 외는 row 금액 그대로
  const itemAmount = (i: CartItem) => cartItemAmount(i);
  const subtotal = items.reduce((s, i) => s + itemAmount(i), 0);
  const total = subtotal;
  function won(n: number) { return n.toLocaleString("ko-KR") + "원"; }

  // 사이즈 없는 상품만 productId 기준으로 묶어 "행 개수 = 수량"으로 표현(위 handleIncrement
  // 주석 참고). 사이즈 있는 상품은 행별로 그대로 유지.
  const selectableItems = items.filter((it) => it.countSelectable);
  const sizedItems = items.filter((it) => !it.countSelectable && it.sizes && it.sizes.length > 0);
  const noSizeGroups: { productId: string; centerId: string; productName: string; price: number; ids: string[] }[] = [];
  for (const it of items) {
    if (it.countSelectable) continue;
    if (it.sizes && it.sizes.length > 0) continue;
    const g = noSizeGroups.find((x) => x.productId === it.productId);
    if (g) g.ids.push(it.id);
    else noSizeGroups.push({ productId: it.productId, centerId: it.centerId, productName: it.productName, price: it.price, ids: [it.id] });
  }

  async function handleRemove(id: string) {
    setBusy(true);
    try { await removeFromCart(id); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  // UX 감사(A-18) — "장바구니 수량조절 UI 없음": cart_items에는 quantity 컬럼이 없어(스키마
  // 변경 없이) 같은 상품을 여러 행으로 담아 "행 개수 = 수량"으로 표현한다. 단, 사이즈가 있는
  // 상품은 "몇 개를 어떤 사이즈로" 조합이 섞일 수 있어(예: M 2개 + L 1개) 행을 합치면 오히려
  // 헷갈리므로 그룹핑/스테퍼 대상에서 제외하고 기존처럼 행별로 그대로 둔다.
  async function handleIncrement(g: { centerId: string; productId: string; productName: string; price: number }) {
    setBusy(true);
    try {
      await addToCart({ centerId: g.centerId, productId: g.productId, productName: g.productName, price: g.price });
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDecrement(ids: string[]) {
    const last = ids[ids.length - 1];
    if (!last) return;
    setBusy(true);
    try { await removeFromCart(last); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleRemoveGroup(ids: string[]) {
    setBusy(true);
    try { await Promise.all(ids.map((id) => removeFromCart(id))); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleCount(it: CartItem, count: number) {
    setBusy(true);
    try {
      const price = cartItemAmount({ ...it, selectedCount: count });
      await updateCartCount(it.id, count, price);
      setItems((prev) => prev.map((x) => x.id === it.id ? { ...x, selectedCount: count, price } : x));
    } catch (e: any) { setError(e.message); }
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
      // 장바구니는 쿠폰 없이 접수한다(플랫폼 기본 쿠폰 제거 — 센터 쿠폰은 상품별 결제 화면에서 적용).
      for (const it of items) {
        await createOrder({
          centerId: it.centerId, productId: it.productId, productName: it.productName,
          amount: itemAmount(it), payMethod: effectivePayMethod,
          selectedSize: it.selectedSize ?? undefined,
          selectedCount: it.countSelectable ? it.selectedCount : undefined,
          profileId: selectedProfileId || undefined,
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
      </div>
    );
  }

  return (
    <div className="app-shell commerce-page cart-page-v2">
      {error && (
        <div className={`error-toast${error === "로그인이 필요해요" ? " error-toast-with-action" : ""}`}>
          {error}<button onClick={() => setError(null)}>×</button>
          {error === "로그인이 필요해요" && (
            <a className="error-toast-action" href={loginHrefWithReturnToHere()}>로그인 하러 가기</a>
          )}
        </div>
      )}

      <div className="back-header">
        <BackButton fallbackHref="/" />
        <div className="title">장바구니</div>
        <div className="side" />
      </div>

      {loading ? <Loading /> : loadError ? (
        <ErrorState title="장바구니를 불러오지 못했어요" description="연결 상태를 확인하고 다시 시도해 주세요."
          action={<AppButton onClick={load}>다시 시도</AppButton>} />
      ) : items.length === 0 ? (
        <EmptyState icon="cart" title="장바구니가 비어 있어요" description="센터에서 수강권이나 상품을 둘러보세요."
          action={<a className="primary-btn" href="/search">센터 찾아보기</a>} />
      ) : (
        <>
          {/* 주문 정보 */}
          <div className="commerce-title"><strong>담은 상품</strong><span>{items.length}개</span></div>
          <div className="cart-list">
            {/* 구매 횟수 선택형: 상품(+사이즈)당 한 row. 수량 stepper 대신 횟수 select, 사이즈는 chip */}
            {selectableItems.map((it) => (
              <div key={it.id} className="cart-row-wrap">
                <div className="cart-row">
                  <div className="commerce-product-mark">P</div><div className="cart-info">
                    <div className="cart-name">{it.productName}</div>
                    <div className="cart-price">
                      {it.selectedCount ?? "-"}회{it.selectedSize ? ` · ${it.selectedSize}` : ""} · {won(itemAmount(it))}
                    </div>
                  </div>
                  <button className="cart-remove" disabled={busy} onClick={() => handleRemove(it.id)}>삭제</button>
                </div>
                <div className="cart-count-select">
                  <label>
                    <span className="cart-size-label">횟수</span>
                    <select aria-label={`${it.productName} 구매 횟수`} value={it.selectedCount ?? ""} disabled={busy}
                      onChange={(e) => handleCount(it, Number(e.target.value))}>
                      {sortedTiers(it).map((t) => <option key={t.count} value={t.count}>{countOptionLabel(t)}</option>)}
                    </select>
                  </label>
                  <span className="cart-count-total">총 {won(itemAmount(it))}</span>
                </div>
                {it.sizes && it.sizes.length > 0 && (
                  <div className="cart-sizes">
                    <span className="cart-size-label">사이즈</span>
                    {it.sizes.map((sz) => (
                      <button aria-pressed={it.selectedSize === sz} key={sz} className={`filter-chip ${it.selectedSize === sz ? "on" : ""}`}
                        disabled={busy} onClick={() => handleSize(it, sz)}>{sz}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {sizedItems.map((it) => (
              <div key={it.id} className="cart-row-wrap">
                <div className="cart-row">
                  <div className="commerce-product-mark">P</div><div className="cart-info">
                    <div className="cart-name">{it.productName}</div>
                    <div className="cart-price">{won(it.price)}</div>
                  </div>
                  <button className="cart-remove" disabled={busy} onClick={() => handleRemove(it.id)}>삭제</button>
                </div>
                <div className="cart-sizes">
                  <span className="cart-size-label">사이즈</span>
                  {it.sizes!.map((sz) => (
                    <button aria-pressed={it.selectedSize === sz} key={sz} className={`filter-chip ${it.selectedSize === sz ? "on" : ""}`}
                      disabled={busy} onClick={() => handleSize(it, sz)}>{sz}</button>
                  ))}
                </div>
              </div>
            ))}
            {noSizeGroups.map((g) => (
              <div key={g.productId} className="cart-row-wrap">
                <div className="cart-row">
                  <div className="commerce-product-mark">P</div><div className="cart-info">
                    <div className="cart-name">{g.productName}</div>
                    <div className="cart-price">{won(g.price)}{g.ids.length > 1 ? ` × ${g.ids.length} = ${won(g.price * g.ids.length)}` : ""}</div>
                  </div>
                  <button className="cart-remove" disabled={busy} onClick={() => handleRemoveGroup(g.ids)}>삭제</button>
                </div>
                {/* UX 감사(A-18) — 수량조절 UI */}
                <div className="cart-qty">
                  <button type="button" className="cart-qty-btn" disabled={busy} onClick={() => handleDecrement(g.ids)} aria-label={`${g.productName} 수량 줄이기`}>−</button>
                  <span className="cart-qty-count">{g.ids.length}개</span>
                  <button type="button" className="cart-qty-btn" disabled={busy} onClick={() => handleIncrement(g)} aria-label={`${g.productName} 수량 늘리기`}>+</button>
                </div>
              </div>
            ))}
          </div>

          {/* 구매 대상 프로필 (가족 등 프로필이 여러 개일 때만 표시) */}
          {profiles.length > 1 && (
            <>
              <div className="menu-section-label commerce-label">누구 앞으로 구매할까요?</div>
              <div className="mem-filters">
                {profiles.map((p) => (
                  <button aria-pressed={selectedProfileId === p.id} key={p.id} className={`filter-chip ${selectedProfileId === p.id ? "on" : ""}`}
                    onClick={() => setSelectedProfileId(p.id)}>
                    {p.name}{p.isPrimary ? " (본인)" : ""}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* 결제 수단 */}
          <div className="menu-section-label commerce-label">결제 수단</div>
          <div className="perm-guide" style={{ margin: "0 0 8px" }}>
            결제 연동 전이라 실제 결제는 진행되지 않아요 — 아래 선택은 센터에 전달할 희망 결제수단
            참고용이에요.
          </div>
          <div className="pay-methods">
            {PAY_METHODS.filter((m) => visibleMethodIds.includes(m.id)).map((m) => (
              <button key={m.id} className={`pay-method ${effectivePayMethod === m.id ? "on" : ""}`} onClick={() => setPayMethod(m.id)}>
                <span className="pay-method-emoji">
                  {m.dot ? <span className="vendor-dot" style={{ background: m.dot }} /> : <UiIcon name={m.icon!} size={20} />}
                </span>
                <span>{m.label}</span>
                <span className="pay-method-check">{effectivePayMethod === m.id ? "●" : "○"}</span>
              </button>
            ))}
          </div>

          <div className="checkout-total">
            <span>총 {items.length}개 · 결제 금액</span>
            <b>{won(total)}</b>
          </div>
          <AppButton className="checkout-pay-btn" disabled={busy} onClick={handleCheckoutAll}>
            {busy ? "처리 중..." : `${won(total)} 주문 접수하기`}
          </AppButton>
          <div className="perm-guide" style={{ margin: "10px 20px" }}>
            결제 연동 전이라 주문서만 접수돼요. 센터에서 확인 후 처리해요.
          </div>
          <div style={{ height: 30 }} />
        </>
      )}
    </div>
  );
}
