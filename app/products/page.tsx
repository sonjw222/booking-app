"use client";

/*
  판매 상품 — 로그인 없이 누구나 볼 수 있는 공개 상품 안내(2026-10-01).
  토스페이먼츠 전자결제 심사에서 "실제 판매 상품을 확인할 수 있어야 한다"는 요구가 있었고,
  일반 이용자에게도 센터별 수강권·상품을 미리 둘러보는 자연스러운 경로다.

  - 데이터: fetch_public_storefront_products()(add_public_storefront_products.sql) — 승인된
    센터의 활성·판매중·전체공개(visibility_type=all) 상품만. 등급 전용/지정 회원 전용 상품은
    이 경로에 절대 나오지 않는다(회원 로그인 후 센터 화면에서 본인 대상 상품으로 확인).
  - 구매는 여기서 하지 않는다 — "센터에서 보기"로 센터 화면(구매 시트)에 연결하고, 실제
    결제는 기존대로 로그인 후 진행된다. 새 checkout을 만들지 않는다.
  - 상품이 하나도 없는 센터는 아예 그리지 않고(빈 카드 없음), 상품 이미지 필드가 없어 이미지
    placeholder도 반복해서 넣지 않는다 — 텍스트 중심 목록.
*/

import Link from "next/link";
import { useEffect, useState } from "react";
import Loading from "../components/Loading";
import ServicePeriodNotice, { ServicePeriodGenericNote } from "../components/ServicePeriodNotice";
import { isFixedExpiryPassed } from "../../lib/servicePeriod";
import { useKstToday } from "../../lib/useKstToday";
import { fetchPublicStorefrontProducts, groupPublicProductsByCenter, type PublicStorefrontProduct } from "../../lib/center";
import BusinessAddressLine from "../components/BusinessAddressLine";
import { BUSINESS_INFO } from "../../lib/businessInfo";
import { toUserMessage } from "../../lib/userError";
import { availabilityLabel, isCountSelectable, priceSummary } from "../../lib/selectableCount";

function won(n: number) { return n.toLocaleString("ko-KR") + "원"; }

function productMeta(p: PublicStorefrontProduct): string {
  if (p.kind === "goods") return p.unlimited ? "상품 · 무제한" : "상품";
  if (p.unlimitedPass) return "수강권 · 횟수 무제한";
  return p.totalCount ? `수강권 · ${p.totalCount}회` : "수강권";
}

export default function PublicProductsPage() {
  const [products, setProducts] = useState<PublicStorefrontProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPublicStorefrontProducts()
      .then(setProducts)
      .catch((e) => setError(toUserMessage(e, "상품을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.")));
  }, []);

  const kstTodayStr = useKstToday();   // KST 자정이 지나면 갱신 — 고정 만료일이 지난 상품이 새로고침 없이 사라진다
  const activeProducts = products ? products.filter((p) => !isFixedExpiryPassed(p.periodSource, kstTodayStr)) : null;
  const groups = activeProducts ? groupPublicProductsByCenter(activeProducts) : [];

  return (
    <div className="app-shell">
      <div className="back-header">
        <Link className="side" aria-label="홈으로" href="/" prefetch={false}>‹</Link>
        <div className="title">판매 상품</div>
        <div className="side" />
      </div>

      <div className="perm-guide" style={{ margin: "0 20px 8px" }}>
        센터별로 판매 중인 수강권과 상품이에요. 구매는 센터 화면에서 로그인 후 진행돼요.
      </div>
      <div style={{ margin: "0 20px 8px" }}><ServicePeriodGenericNote /></div>

      {/* 카드사/PG 심사 대비 비결제 안내(2026-10-16): 이용기간·환불 조건·판매자 정보로 가는 길을 상품 목록 바로 위에 둔다.
          특정 PG·결제수단을 단정하지 않는다(결제수단은 구매 화면이 실제 활성 수단만 보여준다). 사업장 주소는 여기에 넣지 않는다(사용자 결정). */}
      <div className="perm-guide" style={{ margin: "0 20px 8px" }} data-testid="products-purchase-guide">
        <strong>구매 전 확인하세요</strong>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          <li>이용기간·사용 조건은 상품마다 달라요. 센터 화면의 상품 상세에서 확인할 수 있어요.</li>
          <li>결제수단은 구매 화면에서 안내돼요.</li>
          <li>환불·취소는 <Link href="/legal/refund" prefetch={false} style={{ textDecoration: "underline" }}>환불·취소 정책</Link>을 따라요.</li>
          <li>모하빗은 통신판매중개자예요. 판매자 정보는 <Link href="/legal/business" prefetch={false} style={{ textDecoration: "underline" }}>사업자 정보</Link>에서 확인할 수 있어요.</li>
        </ul>
      </div>

      {error ? (
        <div className="daylist-empty">{error}</div>
      ) : products === null ? (
        <Loading />
      ) : groups.length === 0 ? (
        <div className="daylist-empty">현재 판매 중인 상품이 없어요</div>
      ) : (
        groups.map((g) => (
          <section key={g.centerId} aria-label={`${g.centerName} 판매 상품`}>
            <div className="menu-section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>{g.centerName}</span>
              <Link href={`/center/${g.centerId}?buy=1`} style={{ color: "var(--accent)", fontWeight: 800 }} prefetch={false}>센터에서 보기 ›</Link>
            </div>
            <div className="center-products">
              {g.items.map((p) => (
                <div key={p.id} className="center-product-row">
                  <div className="center-product-info">
                    <div className="center-product-name">{p.name}</div>
                    {/* 구매 횟수 선택형은 "회당 6,000원 · 1~12회 선택", 고정 상품은 기존 표시 그대로 */}
                    <div className="center-product-detail">
                      {isCountSelectable(p)
                        ? `${productMeta(p)} · ${priceSummary(p)}`
                        : <>{productMeta(p)} · {won(p.price)}</>}
                    </div>
                    {availabilityLabel(p.remaining) && (
                      <div className={`center-product-avail${p.remaining != null && p.remaining <= 0 ? " is-soldout" : ""}`}>{availabilityLabel(p.remaining)}</div>
                    )}
                    {p.description && <div className="center-product-detail products-desc">{p.description}</div>}
                    {/* 이용기간(사전예약기간·서비스 제공기간): 공개 기간 RPC 가 있을 때만 상품별 날짜, 없으면 아무것도 안 그림(아래 공통 안내) */}
                    <ServicePeriodNotice source={p.periodSource} variant="compact" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      <div className="home-footer" style={{ marginTop: 24 }}>
        <div className="home-footer-links">
          <Link href="/legal/terms" prefetch={false}>이용약관</Link>
          <Link href="/legal/privacy" prefetch={false}>개인정보처리방침</Link>
          <Link href="/legal/business" prefetch={false}>사업자 정보</Link>
          <Link href="/legal/refund" prefetch={false}>환불·취소 정책</Link>
          <Link href="/legal/notices/nicepay-20261030" prefetch={false}>NICEPAY 정책 변경 사전 안내</Link>
        </div>
        <div className="home-footer-biz">
          <div>{BUSINESS_INFO.companyName} · 대표 {BUSINESS_INFO.ceoName}</div>
          <div>사업자등록번호 {BUSINESS_INFO.businessRegNo}</div>
          <div>통신판매업 신고번호 {BUSINESS_INFO.mailOrderRegNo}</div>
          <BusinessAddressLine />
          <div>고객센터 {BUSINESS_INFO.customerServicePhone}</div>
        </div>
      </div>
    </div>
  );
}
