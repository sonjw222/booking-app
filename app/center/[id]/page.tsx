"use client";

import Link from "next/link";
import SheetOverlay from "../../components/SheetOverlay";

/*
  센터 상세 화면
  - 센터 소개/주소/연락처 + 예약 가능한 수업 목록
  - 수업을 누르면 예약 화면으로
  - 로그인 없이도 열림 (승인된 센터만)
*/

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Loading from "../../components/Loading";
import { useParams, useSearchParams } from "next/navigation";
import {
  fetchCenterDetail, fetchCenterClasses, centerPhotoUrl,
  fetchCenterProducts, hasActivePassAtCenter, requestPurchase, fetchClassAllowedPasses,
  type CenterDetail, type CenterClass, type CenterProduct,
} from "../../../lib/center";
import { ZoomableImage } from "../../components/ImageViewer";
import { addToCart, cartCount } from "../../../lib/cart";
import { availabilityLabel, computeBaseAmount, countOptionLabel, isCountSelectable, priceSummary, sortedTiers } from "../../../lib/selectableCount";
import {
  EMPTY_CATALOG_FILTER, catalogEmptyMessage, filterCatalog, isFilterActive, nextFilterOnKind, uniqueGroupLabels,
  type CatalogFilterState, type KindFilter,
} from "../../../lib/catalogFilter";
import CatalogSearchFilter from "../../components/CatalogSearchFilter";
import {
  fetchReviews, myReviewFor, writeReview, deleteReview, uploadReviewPhoto, reviewPhotoUrl, type Review,
  reportReview, REVIEW_REPORT_REASON_LABELS, type ReviewReportReason,
} from "../../../lib/reviews";
import { reservationReturnUrl } from "../../../lib/reservationNav";
import { extractPlainText } from "../../../lib/security";
import { fetchRulesForProducts, ruleToText, type ScheduleRule } from "../../../lib/passes";
import RichTextEditor from "../../components/RichTextEditor";
import UiIcon from "../../components/UiIcon";
import EmptyState from "../../components/EmptyState";
import BackButton from "../../components/BackButton";
import AppButton from "../../components/AppButton";
import { loginHrefWithReturnToHere } from "../../../lib/postLoginReturn";

// 수강권 대분류(group_label) 기준으로 묶는다 — 라벨 없는 상품은 맨 위에 헤더 없이,
// 라벨 있는 상품은 처음 등장한 순서대로 그룹 헤더를 붙여 보여준다(add_product_group_label.sql).
function groupByLabel<T extends { groupLabel: string | null; price: number }>(items: T[]): { label: string | null; items: T[] }[] {
  // 종류가 많아지면 뭘 골라야 할지 판단하기 어렵다는 피드백(2026-09-06 UX 감사) —
  // 그룹 안에서 최소한 가격 오름차순으로라도 정렬해 저렴한 옵션이 먼저 보이게 한다.
  const byPrice = (a: T, b: T) => a.price - b.price;
  const ungrouped = items.filter((i) => !i.groupLabel).sort(byPrice);
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const item of items) {
    if (!item.groupLabel) continue;
    if (!map.has(item.groupLabel)) { map.set(item.groupLabel, []); order.push(item.groupLabel); }
    map.get(item.groupLabel)!.push(item);
  }
  const result: { label: string | null; items: T[] }[] = [];
  if (ungrouped.length > 0) result.push({ label: null, items: ungrouped });
  for (const key of order) result.push({ label: key, items: map.get(key)!.sort(byPrice) });
  return result;
}

export default function CenterDetailPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CenterDetailContent />
    </Suspense>
  );
}

function CenterDetailContent() {
  const params = useParams();
  const centerId = String(params.id);
  const searchParams = useSearchParams();
  // 예약창에서 "수강권 구매하기"로 넘어온 경우: 구매 후 바로 예약할 수업 정보
  const reserveClassId = searchParams.get("reserveClassId");
  const reserveDate = searchParams.get("reserveDate");
  // 예약창에서 보고 있던 센터 필터 (뒤로가기/구매 완료 후 예약 화면 복원용)
  const reserveCenter = searchParams.get("reserveCenter");
  // 예약창에서 들어온 경우, 뒤로가기 시 홈이 아니라 그 예약 화면(날짜/센터/수업 모달까지)으로 복귀
  const backHref = reserveClassId && reserveDate
    ? reservationReturnUrl({ classId: reserveClassId, date: reserveDate, center: reserveCenter })
    : "/";
  // 예약창에서 특정 수업에 쓸 수 있는 상품만 필터링해서 보여달라고 넘어온 경우
  const filterProductIds = useMemo(() => {
    const raw = searchParams.get("productIds");
    if (!raw) return null;
    const ids = raw.split(",").filter(Boolean);
    return ids.length > 0 ? new Set(ids) : null;
  }, [searchParams]);
  const [showAllProducts, setShowAllProducts] = useState(() => searchParams.get("showAll") === "1");
  const [center, setCenter] = useState<CenterDetail | null>(null);
  const [classes, setClasses] = useState<CenterClass[]>([]);
  const [products, setProducts] = useState<CenterProduct[]>([]);
  const [allowedPasses, setAllowedPasses] = useState<Record<string, string[]>>({});
  const [hasPass, setHasPass] = useState(false);
  const [buySheet, setBuySheet] = useState(false);
  const [cartItemCount, setCartItemCount] = useState(0);
  const [passRules, setPassRules] = useState<Record<string, ScheduleRule[]>>({});
  const [descProduct, setDescProduct] = useState<CenterProduct | null>(null);
  // 구매 sheet 검색/필터(2026-10-01) — 이미 받아 온 상품 배열을 클라이언트에서 거르기만 한다(새 API 없음).
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilterState>(EMPTY_CATALOG_FILTER);
  // 상품별 선택(횟수/사이즈)은 row 밖(상위 state)에 둔다 — 필터/검색으로 row가 사라졌다 돌아와도 선택이 유지된다.
  const [selections, setSelections] = useState<Record<string, Partial<ProductSelection>>>({});
  const changeSelection = useCallback((productId: string, patch: Partial<ProductSelection>) => {
    setSelections((prev) => ({ ...prev, [productId]: { ...prev[productId], ...patch } }));
  }, []);
  // 후기
  const [reviews, setReviews] = useState<Review[]>([]);
  const [myReview, setMyReview] = useState<Review | null>(null);
  const [reviewSheet, setReviewSheet] = useState(false);
  const [tab, setTab] = useState<"info" | "class" | "review">("info");
  const [rvRating, setRvRating] = useState(5);
  const [rvContent, setRvContent] = useState("");
  const [rvAlign, setRvAlign] = useState<"left" | "center" | "right">("left");
  const [rvFontSize, setRvFontSize] = useState(14);
  const [rvBusy, setRvBusy] = useState(false);
  const [rvPhotos, setRvPhotos] = useState<string[]>([]);
  const [rvUploading, setRvUploading] = useState(false);
  const [rvEditing, setRvEditing] = useState(false);
  // 후기 신고 (Release Blocker Cleanup Batch A) — reportTargetId가 신고 시트를 연 후기의 id
  const [reportTargetId, setReportTargetId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<ReviewReportReason>("inappropriate");
  const [reportDetail, setReportDetail] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [mapSheet, setMapSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await fetchCenterDetail(centerId);
      if (!c) { setNotFound(true); setLoading(false); return; }
      setCenter(c);
      setClasses(await fetchCenterClasses(centerId));
      const fetchedProducts = await fetchCenterProducts(centerId);
      setProducts(fetchedProducts);
      // 회원이 정확히 무슨 요일·시간에 쓸 수 있는 수강권인지 구매 전에 알 수 있도록
      // 표시(비로그인이면 RLS로 빈 결과만 옴 — 조용히 무시).
      try {
        const passIds = fetchedProducts.filter((p) => p.kind === "pass").map((p) => p.id);
        setPassRules(await fetchRulesForProducts(passIds));
      } catch { /* 비로그인 등 — 무시 */ }
      try { setAllowedPasses(await fetchClassAllowedPasses(centerId)); } catch { /* 무시 */ }
      try { setReviews(await fetchReviews(centerId)); } catch { /* 무시 */ }
      try { setMyReview(await myReviewFor(centerId)); } catch { /* 무시 */ }
      try { setHasPass(await hasActivePassAtCenter(centerId)); } catch { /* 비로그인 */ }
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  // 예약창에서 "수강권 구매하기"로 들어오면 구매 시트 자동 오픈
  useEffect(() => {
    if (!loading && searchParams.get("buy") === "1") {
      setBuySheet(true);
    }
  }, [loading, searchParams]);

  function won(n: number) { return n.toLocaleString("ko-KR") + "원"; }

  function handleReserveClick() {
    // 수강권 없으면 구매 안내
    if (!hasPass) {
      setError("이 센터의 수강권이 없어요. 먼저 수강권을 구매해주세요.");
      setBuySheet(true);
      return;
    }
    window.location.href = `/reservation?center=${centerId}`;
  }

  function handlePurchase(p: CenterProduct, sel?: ProductSelection) {
    // 결제 화면으로 이동 (예약창에서 넘어온 경우, 예약할 수업/필터 상태도 함께 전달해
    // 결제 완료 후 또는 뒤로가기 시 지금 이 화면 상태로 되돌아올 수 있게 함)
    let url = `/checkout?center=${centerId}&product=${p.id}`;
    // 구매 횟수 선택형 상품은 고른 횟수/사이즈를 checkout까지 그대로 넘긴다(최종 금액·횟수는 서버가 다시 확정).
    if (sel?.count != null) url += `&count=${sel.count}`;
    if (sel?.size) url += `&size=${encodeURIComponent(sel.size)}`;
    if (reserveClassId && reserveDate) {
      url += `&reserveClassId=${reserveClassId}&reserveDate=${encodeURIComponent(reserveDate)}`;
      if (reserveCenter) url += `&reserveCenter=${reserveCenter}`;
      if (filterProductIds) url += `&productIds=${Array.from(filterProductIds).join(",")}`;
      if (showAllProducts) url += `&showAll=1`;
    }
    window.location.href = url;
  }

  async function handleWriteReview() {
    // rvContent는 RichTextEditor가 넘기는 HTML이라, 태그만 있고 실제 글자는
    // 없는 경우(예: <br>만 남은 경우)를 빈 내용으로 정확히 판정하기 위해
    // 실제 표시 텍스트 기준으로 검사한다(HTML 문자열 길이 기준 아님).
    if (!extractPlainText(rvContent)) { setError("후기 내용을 입력해주세요"); return; }
    setRvBusy(true);
    try {
      if (rvEditing && myReview) await deleteReview(myReview.id);
      const pt = await writeReview(centerId, rvRating, rvContent, rvPhotos);
      showToast(rvEditing ? "후기를 수정했어요" : (pt > 0 ? `후기 등록 완료! ${pt.toLocaleString("ko-KR")}P 적립됐어요` : "후기를 등록했어요"));
      setReviewSheet(false);
      setRvContent(""); setRvRating(5); setRvPhotos([]); setRvEditing(false);
      setRvAlign("left"); setRvFontSize(14);
      setReviews(await fetchReviews(centerId));
      setMyReview(await myReviewFor(centerId));
    } catch (e: any) { setError(e.message); }
    finally { setRvBusy(false); }
  }

  function openEditReview() {
    if (!myReview) return;
    setRvRating(myReview.rating);
    setRvContent(myReview.content);
    setRvAlign("left"); setRvFontSize(14);
    setRvPhotos(myReview.photos ?? []);
    setRvEditing(true);
    setReviewSheet(true);
  }

  async function handleDeleteReview() {
    if (!myReview) return;
    if (!await globalThis.appConfirm("후기를 삭제할까요?\n적립된 포인트는 회수되지 않아요.")) return;
    setRvBusy(true);
    try {
      await deleteReview(myReview.id);
      setReviews(await fetchReviews(centerId));
      setMyReview(null);
    } catch (e: any) { setError(e.message); }
    finally { setRvBusy(false); }
  }

  async function handleReportSubmit() {
    if (!reportTargetId) return;
    setReportBusy(true);
    try {
      await reportReview(reportTargetId, reportReason, reportDetail);
      setReportTargetId(null);
      showToast("신고가 접수됐어요. 운영팀이 확인할게요.");
    } catch (e: any) {
      setError(e.message);
      setReportTargetId(null);
    } finally { setReportBusy(false); }
  }

  async function handleAddCart(p: CenterProduct, sel?: ProductSelection) {
    // 사이즈 있는 고정 상품은 결제화면에서 선택하도록 안내(장바구니는 사이즈 없는 것 위주).
    // 횟수 선택형 상품은 고른 횟수/사이즈를 그대로 담는다(같은 상품+사이즈는 한 row, 다시 담으면 선택 변경).
    try {
      await addToCart({
        centerId, productId: p.id, productName: p.name,
        price: computeBaseAmount(p, sel?.count) ?? p.price,
        selectedSize: sel?.size ?? null, selectedCount: sel?.count ?? null,
      });
      showToast(`'${p.name}' 장바구니에 담았어요`);
      cartCount().then(setCartItemCount);
    } catch (e: any) { setError(e.message); }
  }

  useEffect(() => {
    if (buySheet) cartCount().then(setCartItemCount);
  }, [buySheet]);

  // 구매 sheet 목록: (수업 지정 필터) → 종류/그룹/검색 필터. 기존 정렬 순서는 그대로 두고 항목만 제거한다.
  const classScopedProducts = useMemo(
    () => (filterProductIds && !showAllProducts ? products.filter((p) => filterProductIds.has(p.id)) : products),
    [products, filterProductIds, showAllProducts],
  );
  const groupLabels = useMemo(() => uniqueGroupLabels(classScopedProducts), [classScopedProducts]);
  const effectiveCatalogFilter = useMemo<CatalogFilterState>(
    () => ({ ...catalogFilter, group: catalogFilter.group && groupLabels.includes(catalogFilter.group) ? catalogFilter.group : null }),
    [catalogFilter, groupLabels],
  );
  const catalogProducts = useMemo(
    () => filterCatalog(classScopedProducts, effectiveCatalogFilter),
    [classScopedProducts, effectiveCatalogFilter],
  );

  if (loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <BackButton fallbackHref={backHref} />
          <div className="title">센터 정보</div>
          <div className="side" />
        </div>
        <Loading />
      </div>
    );
  }

  if (notFound || !center) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <BackButton fallbackHref={backHref} />
          <div className="title">센터 정보</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>센터를 찾을 수 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell center-detail-v2">
      {error && (
        <div className={`error-toast${error === "로그인이 필요해요" ? " error-toast-with-action" : ""}`}>
          {error}<button onClick={() => setError(null)}>×</button>
          {error === "로그인이 필요해요" && (
            <a className="error-toast-action" href={loginHrefWithReturnToHere()}>로그인 하러 가기</a>
          )}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}

      {/* 수강권 구매 안내 시트 */}
      {/* 지도/길찾기 앱 선택 */}
      {mapSheet && center && (
        <SheetOverlay className="sheet-overlay" onClick={() => setMapSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">길찾기 앱 선택</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              <UiIcon name="location" size={14} /> {center.address}<br />
              {center.latitude != null ? "목적지가 이 센터로 자동 설정돼요" : "정확한 길찾기는 센터 위치 좌표가 필요해요"}
            </div>
            <div className="map-app-list">
              {(() => {
                const addr = encodeURIComponent(center.address ?? "");
                const name = encodeURIComponent(center.name);
                const hasCoord = center.latitude != null && center.longitude != null;
                const lat = center.latitude, lng = center.longitude;
                // 카카오맵/네이버지도/티맵은 로고 자산이 없어 outline 아이콘 하나로 뭉치면
                // 구분이 안 되므로 --vendor-* 색 점으로 구분한다. 구글 지도는 이모지("🗺️")
                // 대신 일반 지도핀 아이콘을 써도 정체성이 흐려지지 않아(로고 자체가 지도
                // 색상 팔레트) 그대로 UiIcon으로 바꾼다.
                const apps: { id: string; label: string; dot?: string; url: string }[] = [
                  { id: "kakao", label: "카카오맵으로 길찾기", dot: "var(--vendor-kakao)",
                    url: hasCoord
                      ? `https://map.kakao.com/link/to/${name},${lat},${lng}`
                      : `https://map.kakao.com/link/search/${addr}` },
                  { id: "naver", label: "네이버 지도로 길찾기", dot: "var(--vendor-naver)",
                    // 앱: nmap 스킴(목적지 자동), 웹 대체: 검색
                    url: hasCoord
                      ? `nmap://route/car?dlat=${lat}&dlng=${lng}&dname=${name}&appname=woori.class`
                      : `https://map.naver.com/v5/search/${addr}` },
                  { id: "tmap", label: "티맵으로 길찾기", dot: "var(--vendor-tmap)",
                    // 앱: tmap 스킴(목적지 자동)
                    url: hasCoord
                      ? `tmap://route?goalname=${name}&goalx=${lng}&goaly=${lat}`
                      : `https://tmap.life/route?goalname=${name}` },
                  { id: "google", label: "구글 지도로 길찾기",
                    url: hasCoord
                      ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
                      : `https://www.google.com/maps/search/?api=1&query=${addr}` },
                ];
                return apps.map((a) => (
                  <a key={a.id} className="map-app-item" href={a.url} target="_blank" rel="noreferrer" onClick={() => setMapSheet(false)}>
                    <span className="map-app-emoji">
                      {a.dot ? <span className="vendor-dot" style={{ background: a.dot }} /> : <UiIcon name="location" size={20} />}
                    </span>
                    <span>{a.label}</span>
                    <span className="map-app-go">›</span>
                  </a>
                ));
              })()}
            </div>
            <button className="ghost-btn" style={{ width: "100%", marginTop: 12 }} onClick={() => setMapSheet(false)}>닫기</button>
          </div>
        </SheetOverlay>
      )}

      {buySheet && (() => {
        const applyFilter = filterProductIds && !showAllProducts;
        const visibleProducts = catalogProducts;
        const filterActive = isFilterActive(effectiveCatalogFilter);
        return (
        <SheetOverlay className="sheet-overlay" onClick={() => setBuySheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">
              수강권 · 상품 구매
              <button type="button" className="sheet-close-btn" aria-label="닫기" onClick={() => setBuySheet(false)}>
                <UiIcon name="close" size={20} />
              </button>
            </div>
            <Link href="/cart" className="cart-link-btn" prefetch={false}>
              <UiIcon name="cart" size={16} /> 장바구니 보기{cartItemCount > 0 ? ` (${cartItemCount})` : ""}
            </Link>
            <p className="center-buy-help">수강권을 선택하고 바로 구매하거나 장바구니에 담을 수 있어요.</p>
            {filterProductIds && (
              <div className="class-filter-notice">
                <span>{applyFilter ? "이 수업에 사용할 수 있는 수강권만 표시 중" : "전체 상품 표시 중"}</span>
                <button className="class-filter-clear-btn" onClick={() => setShowAllProducts((v) => !v)}>
                  {applyFilter ? "전체 상품 보기" : "이 수업에 맞는 수강권 보기"}
                </button>
              </div>
            )}
            {/* 검색 + 종류(전체/수강권/상품) + 그룹(group_label 동적) — 입력 즉시 클라이언트에서 거른다. */}
            {classScopedProducts.length > 0 && (
              <CatalogSearchFilter
                query={catalogFilter.query}
                onQuery={(q) => setCatalogFilter((f) => ({ ...f, query: q }))}
                placeholder="수강권·상품 검색" searchLabel="수강권·상품 검색"
                kind={catalogFilter.kind}
                onKind={(k: KindFilter) => setCatalogFilter((f) => nextFilterOnKind(f, k))}
                groups={groupLabels}
                group={effectiveCatalogFilter.group}
                onGroup={(g) => setCatalogFilter((f) => ({ ...f, group: g }))}
                resultText={filterActive ? `${visibleProducts.length}개` : null}
              />
            )}
            {classScopedProducts.length === 0 ? (
              <div className="daylist-empty" style={{ padding: 16 }}>
                {applyFilter ? "이 수업에 쓸 수 있는 판매중인 상품이 없어요" : catalogEmptyMessage(0, EMPTY_CATALOG_FILTER)}
              </div>
            ) : visibleProducts.length === 0 ? (
              <div className="catalog-empty">
                {catalogEmptyMessage(classScopedProducts.length, effectiveCatalogFilter)}
                <div>
                  <button type="button" className="quiet-action" onClick={() => setCatalogFilter(EMPTY_CATALOG_FILTER)}>필터 초기화</button>
                </div>
              </div>
            ) : (
              <>
                {visibleProducts.filter((p) => p.kind === "pass").length > 0 && (
                  <>
                    <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>수강권</div>
                    {groupByLabel(visibleProducts.filter((p) => p.kind === "pass")).map((group) => (
                      <div key={group.label ?? "__ungrouped"}>
                        {group.label && (
                          <div className="menu-section-label" style={{ padding: "10px 0 4px", fontSize: 11 }}>{group.label}</div>
                        )}
                        <div className="center-products">
                          {group.items.map((p) => (
                            <CenterProductRow key={p.id} p={p} rules={passRules[p.id]} value={selections[p.id]} onChange={changeSelection} onDesc={setDescProduct} onAddCart={handleAddCart} onBuy={handlePurchase} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {visibleProducts.filter((p) => p.kind === "goods").length > 0 && (
                  <>
                    <div className="menu-section-label" style={{ padding: "10px 0 6px" }}>상품</div>
                    <div className="center-products">
                      {visibleProducts.filter((p) => p.kind === "goods").map((p) => (
                        <CenterProductRow key={p.id} p={p} value={selections[p.id]} onChange={changeSelection} onDesc={setDescProduct} onAddCart={handleAddCart} onBuy={handlePurchase} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            <button className="ghost-btn" style={{ width: "100%", marginTop: 12 }} onClick={() => setBuySheet(false)}>닫기</button>
          </div>
        </SheetOverlay>
        );
      })()}

      {/* 후기 작성 */}
      {reviewSheet && (
        <SheetOverlay className="sheet-overlay" onClick={() => setReviewSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{rvEditing ? "후기 수정" : "후기 쓰기"}</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              이 센터 수강권을 구매한 회원만 쓸 수 있어요. 작성하면 센터 포인트가 적립돼요.
            </div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>별점</div>
            <div className="star-picker">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className={`star-btn ${n <= rvRating ? "on" : ""}`} onClick={() => setRvRating(n)}>★</button>
              ))}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>내용</div>
            <RichTextEditor
              html={rvContent}
              align={rvAlign}
              fontSize={rvFontSize}
              onChangeHtml={setRvContent}
              onChangeAlign={setRvAlign}
              onChangeFontSize={setRvFontSize}
            />
            <div className="perm-guide" style={{ margin: "6px 0 0" }}>
              수업은 어땠나요? 다른 회원에게 도움이 되는 후기를 남겨주세요.
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>사진 (선택, 여러 장)</div>
            <div className="rv-photo-add">
              {rvPhotos.map((ph, i) => (
                <div key={i} className="rv-photo-thumb">
                  <img src={reviewPhotoUrl(ph) ?? ""} alt="" loading="lazy" decoding="async" />
                  <button className="rv-photo-del" onClick={() => setRvPhotos((prev) => prev.filter((_, x) => x !== i))}>×</button>
                </div>
              ))}
              <label className="rv-photo-btn">
                {rvUploading ? "…" : "+"}
                <input type="file" accept="image/*" hidden onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  setRvUploading(true);
                  try { const path = await uploadReviewPhoto(f); setRvPhotos((prev) => [...prev, path]); }
                  catch (err: any) { setError(err.message); }
                  finally { setRvUploading(false); e.target.value = ""; }
                }} />
              </label>
            </div>

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setReviewSheet(false)}>취소</button>
              <button className="primary-btn" disabled={rvBusy} onClick={handleWriteReview}>
                {rvBusy ? "등록 중..." : "등록하기"}
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 후기 신고 (Release Blocker Cleanup Batch A) */}
      {reportTargetId && (
        <SheetOverlay className="sheet-overlay" onClick={() => setReportTargetId(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">후기 신고</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              신고 내용은 운영팀이 확인 후 처리해요.
            </div>
            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>신고 사유</div>
            {(Object.keys(REVIEW_REPORT_REASON_LABELS) as ReviewReportReason[]).map((key) => (
              <label key={key} className="admin-row" style={{ cursor: "pointer" }}>
                <input
                  type="radio" name="report-reason" value={key}
                  checked={reportReason === key}
                  onChange={() => setReportReason(key)}
                  style={{ marginRight: 8 }}
                />
                <span className="v">{REVIEW_REPORT_REASON_LABELS[key]}</span>
              </label>
            ))}
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>상세 사유 (선택)</div>
            <textarea aria-label="추가로 전달하고 싶은 내용이 있다면 적어주세요"
              className="input-field"
              style={{ width: "100%", minHeight: 60 }}
              placeholder="추가로 전달하고 싶은 내용이 있다면 적어주세요"
              value={reportDetail}
              onChange={(e) => setReportDetail(e.target.value)}
            />
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setReportTargetId(null)}>취소</button>
              <button className="primary-btn" disabled={reportBusy} onClick={handleReportSubmit}>
                {reportBusy ? "접수 중..." : "신고하기"}
              </button>
            </div>
          </div>
        </SheetOverlay>
      )}

      {/* 상품 상세 설명 */}
      {descProduct && (
        <SheetOverlay className="sheet-overlay" onClick={() => setDescProduct(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{descProduct.name}</div>
            <div className="checkout-order-detail" style={{ marginBottom: 8 }}>
              {descProduct.unlimited ? "무제한" : descProduct.totalCount ? `${descProduct.totalCount}회` : ""} · {won(descProduct.price)}
            </div>
            <div className="center-intro-text" style={{ whiteSpace: "pre-wrap" }}>{descProduct.description}</div>
            {descProduct.sizes && descProduct.sizes.length > 0 && (
              <div className="perm-guide" style={{ margin: "10px 0 0" }}>사이즈: {descProduct.sizes.join(", ")}</div>
            )}
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setDescProduct(null)}>닫기</button>
              <button className="primary-btn" onClick={() => { const p = descProduct; setDescProduct(null); handlePurchase(p); }}>구매하기</button>
            </div>
          </div>
        </SheetOverlay>
      )}

      <div className="back-header center-detail-head">
        <a className="side" aria-label="뒤로가기" href={backHref}>‹</a>
        <div className="title">센터</div>
        <div className="side" />
      </div>

      {/* 센터 헤더 */}
      <div className="center-hero">
        {center.photoUrl
          ? <ZoomableImage className="center-hero-photo" src={centerPhotoUrl(center.photoUrl) ?? ""} />
          : <div className="center-hero-badge">{center.name.slice(0, 1)}</div>}
        <div className="center-hero-name">{center.name}</div>
        {center.address && <div className="center-hero-addr"><UiIcon name="location" size={14} /> {center.address}</div>}
        {center.phone && (
          <a className="center-hero-phone" href={`tel:${center.phone}`}><UiIcon name="phone" size={14} /> {center.phone}</a>
        )}
        {center.sns && (
          <div className="center-sns">
            {center.sns.split("\n").filter((l) => l.trim()).map((line, i) => (
              <span key={i} className="center-sns-item">{line}</span>
            ))}
          </div>
        )}
      </div>

      {/* 섹션 탭 */}
      <div className="center-tabs">
        <button className={`center-tab ${tab === "info" ? "on" : ""}`} onClick={() => setTab("info")}>센터 정보</button>
        <button className={`center-tab ${tab === "class" ? "on" : ""}`} onClick={() => setTab("class")}>수업</button>
        <button className={`center-tab ${tab === "review" ? "on" : ""}`} onClick={() => setTab("review")}>후기</button>
      </div>

      {tab === "info" && (<>
      {/* UI/UX 감사(P0-2/A-1) — 주소·소개가 둘 다 비어있으면 700px 넘는 완전한 백지라
          "고장났나?" 로 보였다. 최소한 대체 동선(수업 탭)이라도 제공한다. */}
      {!center.address && center.introBlocks.length === 0 && !center.intro && (
        <EmptyState
          icon="building"
          title="아직 등록된 센터 정보가 없어요"
          description="위치·소개는 준비 중이에요. 수업 탭에서 일정을 먼저 확인해보세요."
          action={<button type="button" className="primary-btn" onClick={() => setTab("class")}>수업 보러가기 ›</button>}
        />
      )}
      {/* iPad portrait 배치(2026-09-24) — .center-info-2col: 위치/소개가 짧을 때 아래
          공백이 지나치게 커 보이던 문제. 768~1279px에서만 2열 grid가 되고(app/globals.css),
          그 아래/1280px 미만에서는 이 wrapper가 아무 스타일도 없어 기존 세로 스택 그대로다.
          둘 중 하나만 있으면(:only-child) 전체 폭을 쓰도록 CSS에서 처리 — 억지 min-height
          없이 align-items:start로 각자 자연스러운 높이만 차지한다. */}
      <div className="center-info-2col">
      {/* 위치 */}
      {center.address && (
        <div className="center-info-col">
          <div className="menu-section-label">위치</div>
          <button className="center-map-link" onClick={() => setMapSheet(true)}>
            <div className="center-map-addr"><UiIcon name="location" size={14} /> {center.address}</div>
            <div className="center-map-open">지도 · 길찾기 ›</div>
          </button>
        </div>
      )}

      {/* 소개 (블로그식: 글/사진 번갈아) */}
      {(center.introBlocks.length > 0 || center.intro) && (
        <div className="center-info-col">
          <div className="menu-section-label">센터 소개</div>
          <div className="center-intro-blocks">
            {center.introBlocks.length > 0
              ? center.introBlocks.map((blk, i) => (
                  blk.type === "text"
                    ? (blk.html
                        ? <div
                            key={i}
                            className="center-intro-text"
                            style={{
                              textAlign: blk.align ?? "left",
                              fontSize: blk.fontSize ?? undefined,
                            }}
                            dangerouslySetInnerHTML={{ __html: blk.html }}
                          />
                        : <p
                            key={i}
                            className={`center-intro-text ${blk.bold ? "bold" : ""}`}
                            style={{
                              textAlign: blk.align ?? "left",
                              fontSize: blk.fontSize ?? undefined,
                            }}
                          >{blk.value}</p>)
                    : <ZoomableImage key={i} className="center-intro-img" src={centerPhotoUrl(blk.value) ?? ""} />
                ))
              : <p className="center-intro-text">{center.intro}</p>}
          </div>
        </div>
      )}
      </div>

      </>)}

      {tab === "class" && (<>
      {/* 운영 중인 수업 (종류별 가장 빠른 일정 + 이용 가능 수강권) */}
      <div className="menu-section-label">운영 중인 수업 ({classes.length})</div>
      {classes.length === 0 ? (
        <div className="daylist-empty" style={{ padding: "20px" }}>운영 중인 수업이 없어요</div>
      ) : (
        <div className="center-class-list">
          {classes.map((c) => {
            const full = c.reserved >= c.capacity;
            const passes = allowedPasses[c.title];
            return (
              <button key={c.id} className="center-class-row" onClick={handleReserveClick}>
                <div className="center-class-main">
                  <div className="center-class-title">{c.title}</div>
                  <div className="center-class-when">가장 빠른 일정 · {c.startText}</div>
                  <div className="center-class-passes">
                    {passes && passes.length > 0
                      ? passes.map((p) => <span key={p} className="class-pass-chip">{p}</span>)
                      : <span className="class-pass-chip all">모든 수강권 가능</span>}
                  </div>
                </div>
                <div className={`center-class-cap ${full ? "full" : ""}`}>
                  {full ? "대기" : `${c.reserved}/${c.capacity}`}
                </div>
              </button>
            );
          })}
        </div>
      )}

      </>)}

      {tab === "review" && (<>
      {/* 후기 */}
      <div className="menu-section-label">
        후기 {reviews.length > 0 && `(${reviews.length})`}
        {!myReview && (
          <button className="hist-more-btn" onClick={() => { setRvEditing(false); setRvRating(5); setRvContent(""); setRvAlign("left"); setRvFontSize(14); setRvPhotos([]); setReviewSheet(true); }}>후기 쓰기</button>
        )}
      </div>
      {reviews.length === 0 ? (
        <div className="daylist-empty" style={{ padding: "20px" }}>
          아직 후기가 없어요. 첫 후기를 남겨보세요!
        </div>
      ) : (
        <div className="review-list">
          {reviews.map((r) => (
            <div key={r.id} className="review-item">
              <div className="review-head">
                <span className="review-stars">{"★".repeat(r.rating)}<span className="review-stars-off">{"★".repeat(5 - r.rating)}</span></span>
                <span className="review-writer">{r.writerName}</span>
                <span className="review-date">{r.createdAt}</span>
              </div>
              <div className="review-content" dangerouslySetInnerHTML={{ __html: r.content }} />
              {r.photos && r.photos.length > 0 && (
                <div className="review-photos">
                  {r.photos.map((ph, i) => (
                    <ZoomableImage
                      key={i} className="review-photo" src={reviewPhotoUrl(ph) ?? ""}
                      group={r.photos!.map((p) => reviewPhotoUrl(p) ?? "")} groupIndex={i}
                    />
                  ))}
                </div>
              )}
              {r.reply && (
                <div className="review-reply">
                  <div className="review-reply-head">센터 답변</div>
                  <div className="review-reply-body" dangerouslySetInnerHTML={{ __html: r.reply }} />
                </div>
              )}
              {myReview && myReview.id === r.id ? (
                <div className="review-actions">
                  <button className="review-edit" disabled={rvBusy} onClick={openEditReview}>수정</button>
                  <button className="review-del" disabled={rvBusy} onClick={handleDeleteReview}>삭제</button>
                </div>
              ) : (
                <div className="review-actions">
                  <button
                    className="review-report"
                    onClick={() => { setReportTargetId(r.id); setReportReason("inappropriate"); setReportDetail(""); }}
                  >
                    신고
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      </>)}

      <div style={{ height: 90 }} />

      {/* 하단 고정 바: 예약하기 + 구매하기 */}
      <div className="center-bottom-bar">
        <button className="center-bar-btn buy" onClick={() => setBuySheet(true)}>수강권 구매</button>
        <button className="center-bar-btn reserve" onClick={handleReserveClick}>예약하기</button>
      </div>
    </div>
  );
}


// 구매 sheet의 상품 한 줄. 구매 횟수 선택형(회차별 가격표) 수강권/상품은 목록에 한 번만 나오고, 횟수(+사이즈) 선택 후 즉시 그 회차의
// 가격을 보여준다. 가격은 미리보기일 뿐 — 서버가 주문 생성 시 가격표에서 다시 확정한다. "판매 가능 N개"(max_quantity)는 이용 횟수와
// 무관한 판매 수량이라 제목 옆 badge가 아니라 보조 줄의 작은 글씨로만 표시한다. 선택값(횟수/사이즈)은 부모 state(value/onChange)에 있어
// 검색/필터로 row가 사라졌다 돌아와도 유지된다.
type ProductSelection = { count: number | null; size: string | null };
const won = (n: number) => n.toLocaleString("ko-KR") + "원";

function CenterProductRow({ p, rules, value, onChange, onDesc, onAddCart, onBuy }: {
  p: CenterProduct;
  rules?: ScheduleRule[];
  value?: Partial<ProductSelection>;
  onChange: (productId: string, patch: Partial<ProductSelection>) => void;
  onDesc: (p: CenterProduct) => void;
  onAddCart: (p: CenterProduct, sel?: ProductSelection) => void;
  onBuy: (p: CenterProduct, sel?: ProductSelection) => void;
}) {
  const selectable = isCountSelectable(p);
  const tiers = selectable ? sortedTiers(p) : [];
  const count = value?.count != null && tiers.some((t) => t.count === value.count) ? value.count : (tiers[0]?.count ?? null);
  const needsSize = selectable && !!p.sizes && p.sizes.length > 0;
  const size = value?.size ?? "";
  const total = selectable ? computeBaseAmount(p, count) : null;
  const avail = availabilityLabel(p.remaining);
  const soldOut = p.remaining === 0;
  const sel: ProductSelection | undefined = selectable ? { count, size: needsSize ? size : null } : undefined;
  const blocked = (needsSize && !size) || (selectable && count == null);
  return (
    <div className={`center-product-row${selectable ? " is-selectable" : ""}`}>
      <button className="center-product-info" style={{ background: "none", border: "none", textAlign: "left", flex: 1, cursor: p.description ? "pointer" : "default" }} onClick={() => p.description && onDesc(p)}>
        <div className="center-product-name">{p.name}{p.description ? " ⓘ" : ""}</div>
        <div className="center-product-detail">{priceSummary(p)}</div>
        {rules && rules.length > 0 && (
          <div className="center-product-detail" style={{ color: "var(--brand)" }}>
            {rules.map(ruleToText).join(" / ")}
          </div>
        )}
        {avail && <div className={`center-product-avail${soldOut ? " is-soldout" : ""}`}>{avail}</div>}
      </button>
      {selectable && !soldOut && (
        <div className="center-product-select">
          <label className="center-product-select-field">
            <span>횟수</span>
            <select aria-label={`${p.name} 구매 횟수`} value={count ?? ""} onChange={(e) => onChange(p.id, { count: Number(e.target.value) })}>
              {tiers.map((t) => <option key={t.count} value={t.count}>{countOptionLabel(t)}</option>)}
            </select>
          </label>
          {needsSize && (
            <label className="center-product-select-field">
              <span>사이즈</span>
              <select aria-label={`${p.name} 사이즈`} value={size} onChange={(e) => onChange(p.id, { size: e.target.value })}>
                <option value="">선택</option>
                {p.sizes!.map((sz) => <option key={sz} value={sz}>{sz}</option>)}
              </select>
            </label>
          )}
          <div className="center-product-total">{count != null ? `${count}회` : "-"} · {total != null ? won(total) : "-"}</div>
        </div>
      )}
      <div className="center-product-actions">
        {!soldOut && <AppButton variant="secondary" className="center-product-cart" disabled={blocked} onClick={() => onAddCart(p, sel)}>담기</AppButton>}
        {!soldOut && <AppButton className="center-product-buy" disabled={blocked} onClick={() => onBuy(p, sel)}>구매</AppButton>}
      </div>
    </div>
  );
}
