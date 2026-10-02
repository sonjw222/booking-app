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
import { fetchPublicStorefrontProducts, groupPublicProductsByCenter, type PublicStorefrontProduct } from "../../lib/center";
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

  const groups = products ? groupPublicProductsByCenter(products) : [];

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
        </div>
        <div className="home-footer-biz">
          <div>{BUSINESS_INFO.companyName} · 대표 {BUSINESS_INFO.ceoName}</div>
          <div>사업자등록번호 {BUSINESS_INFO.businessRegNo}</div>
          <div>통신판매업 신고번호 {BUSINESS_INFO.mailOrderRegNo}</div>
          <div>고객센터 {BUSINESS_INFO.customerServicePhone}</div>
        </div>
      </div>
    </div>
  );
}
