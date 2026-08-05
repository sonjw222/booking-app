"use client";

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
import BottomNav from "../../components/BottomNav";
import { ZoomableImage } from "../../components/ImageViewer";
import { addToCart } from "../../../lib/cart";
import { fetchReviews, myReviewFor, writeReview, deleteReview, uploadReviewPhoto, reviewPhotoUrl, type Review } from "../../../lib/reviews";
import { reservationReturnUrl } from "../../../lib/reservationNav";
import { extractPlainText } from "../../../lib/security";
import RichTextEditor from "../../components/RichTextEditor";

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
  const [descProduct, setDescProduct] = useState<CenterProduct | null>(null);
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
      setProducts(await fetchCenterProducts(centerId));
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

  function handlePurchase(p: CenterProduct) {
    // 결제 화면으로 이동 (예약창에서 넘어온 경우, 예약할 수업/필터 상태도 함께 전달해
    // 결제 완료 후 또는 뒤로가기 시 지금 이 화면 상태로 되돌아올 수 있게 함)
    let url = `/checkout?center=${centerId}&product=${p.id}`;
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
    if (!confirm("후기를 삭제할까요? (적립된 포인트는 회수되지 않아요)")) return;
    setRvBusy(true);
    try {
      await deleteReview(myReview.id);
      setReviews(await fetchReviews(centerId));
      setMyReview(null);
    } catch (e: any) { setError(e.message); }
    finally { setRvBusy(false); }
  }

  async function handleAddCart(p: CenterProduct) {
    // 사이즈 있는 상품은 결제화면에서 선택하도록 안내 (장바구니는 사이즈 없는 것 위주)
    try {
      await addToCart({ centerId, productId: p.id, productName: p.name, price: p.price });
      showToast(`'${p.name}' 장바구니에 담았어요`);
    } catch (e: any) { setError(e.message); }
  }

  if (loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href={backHref}>‹</a>
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
          <a className="side" href={backHref}>‹</a>
          <div className="title">센터 정보</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>센터를 찾을 수 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      {/* 수강권 구매 안내 시트 */}
      {/* 지도/길찾기 앱 선택 */}
      {mapSheet && center && (
        <div className="sheet-overlay" onClick={() => setMapSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">길찾기 앱 선택</div>
            <div className="perm-guide" style={{ margin: "0 0 12px" }}>
              📍 {center.address}<br />
              {center.latitude != null ? "목적지가 이 센터로 자동 설정돼요" : "정확한 길찾기는 센터 위치 좌표가 필요해요"}
            </div>
            <div className="map-app-list">
              {(() => {
                const addr = encodeURIComponent(center.address ?? "");
                const name = encodeURIComponent(center.name);
                const hasCoord = center.latitude != null && center.longitude != null;
                const lat = center.latitude, lng = center.longitude;
                const apps = [
                  { id: "kakao", label: "카카오맵으로 길찾기", emoji: "🟡",
                    url: hasCoord
                      ? `https://map.kakao.com/link/to/${name},${lat},${lng}`
                      : `https://map.kakao.com/link/search/${addr}` },
                  { id: "naver", label: "네이버 지도로 길찾기", emoji: "🟢",
                    // 앱: nmap 스킴(목적지 자동), 웹 대체: 검색
                    url: hasCoord
                      ? `nmap://route/car?dlat=${lat}&dlng=${lng}&dname=${name}&appname=woori.class`
                      : `https://map.naver.com/v5/search/${addr}` },
                  { id: "tmap", label: "티맵으로 길찾기", emoji: "🔵",
                    // 앱: tmap 스킴(목적지 자동)
                    url: hasCoord
                      ? `tmap://route?goalname=${name}&goalx=${lng}&goaly=${lat}`
                      : `https://tmap.life/route?goalname=${name}` },
                  { id: "google", label: "구글 지도로 길찾기", emoji: "🗺️",
                    url: hasCoord
                      ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
                      : `https://www.google.com/maps/search/?api=1&query=${addr}` },
                ];
                return apps.map((a) => (
                  <a key={a.id} className="map-app-item" href={a.url} target="_blank" rel="noreferrer" onClick={() => setMapSheet(false)}>
                    <span className="map-app-emoji">{a.emoji}</span>
                    <span>{a.label}</span>
                    <span className="map-app-go">›</span>
                  </a>
                ));
              })()}
            </div>
            <button className="ghost-btn" style={{ width: "100%", marginTop: 12 }} onClick={() => setMapSheet(false)}>닫기</button>
          </div>
        </div>
      )}

      {buySheet && (() => {
        const applyFilter = filterProductIds && !showAllProducts;
        const visibleProducts = applyFilter ? products.filter((p) => filterProductIds!.has(p.id)) : products;
        return (
        <div className="sheet-overlay" onClick={() => setBuySheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">수강권 · 상품 구매</div>
            <a href="/cart" className="cart-link-btn">🛒 장바구니 보기</a>
            {filterProductIds && (
              <div className="class-filter-notice">
                <span>{applyFilter ? "이 수업에 사용할 수 있는 수강권만 표시 중" : "전체 상품 표시 중"}</span>
                <button className="class-filter-clear-btn" onClick={() => setShowAllProducts((v) => !v)}>
                  {applyFilter ? "전체 상품 보기" : "이 수업에 맞는 수강권 보기"}
                </button>
              </div>
            )}
            {visibleProducts.length === 0 ? (
              <div className="daylist-empty" style={{ padding: 16 }}>
                {applyFilter ? "이 수업에 쓸 수 있는 판매중인 상품이 없어요" : "판매 중인 상품이 없어요"}
              </div>
            ) : (
              <>
                {visibleProducts.filter((p) => p.kind === "pass").length > 0 && (
                  <>
                    <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>수강권</div>
                    <div className="center-products">
                      {visibleProducts.filter((p) => p.kind === "pass").map((p) => (
                        <div key={p.id} className="center-product-row">
                          <button className="center-product-info" style={{ background: "none", border: "none", textAlign: "left", flex: 1, cursor: p.description ? "pointer" : "default" }} onClick={() => p.description && setDescProduct(p)}>
                            <div className="center-product-name">{p.name}{p.description ? " ⓘ" : ""}</div>
                            <div className="center-product-detail">
                              {p.unlimited ? "무제한" : p.totalCount ? `${p.totalCount}회` : ""} · {won(p.price)}
                            </div>
                          </button>
                          <div className="center-product-actions">
                            <button className="center-product-cart" onClick={() => handleAddCart(p)}>담기</button>
                            <button className="center-product-buy" onClick={() => handlePurchase(p)}>구매</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {visibleProducts.filter((p) => p.kind === "goods").length > 0 && (
                  <>
                    <div className="menu-section-label" style={{ padding: "10px 0 6px" }}>상품</div>
                    <div className="center-products">
                      {visibleProducts.filter((p) => p.kind === "goods").map((p) => (
                        <div key={p.id} className="center-product-row">
                          <button className="center-product-info" style={{ background: "none", border: "none", textAlign: "left", flex: 1, cursor: p.description ? "pointer" : "default" }} onClick={() => p.description && setDescProduct(p)}>
                            <div className="center-product-name">{p.name}{p.description ? " ⓘ" : ""}</div>
                            <div className="center-product-detail">
                              {p.unlimited ? "무제한" : p.totalCount ? `${p.totalCount}회` : ""} · {won(p.price)}
                            </div>
                          </button>
                          <div className="center-product-actions">
                            <button className="center-product-cart" onClick={() => handleAddCart(p)}>담기</button>
                            <button className="center-product-buy" onClick={() => handlePurchase(p)}>구매</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            <button className="ghost-btn" style={{ width: "100%", marginTop: 12 }} onClick={() => setBuySheet(false)}>닫기</button>
          </div>
        </div>
        );
      })()}

      {/* 후기 작성 */}
      {reviewSheet && (
        <div className="sheet-overlay" onClick={() => setReviewSheet(false)}>
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
                  <img src={reviewPhotoUrl(ph) ?? ""} alt="" />
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
        </div>
      )}

      {/* 상품 상세 설명 */}
      {descProduct && (
        <div className="sheet-overlay" onClick={() => setDescProduct(null)}>
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
        </div>
      )}

      <div className="back-header">
        <a className="side" href={backHref}>‹</a>
        <div className="title">센터 정보</div>
        <div className="side" />
      </div>

      {/* 센터 헤더 */}
      <div className="center-hero">
        {center.photoUrl
          ? <ZoomableImage className="center-hero-photo" src={centerPhotoUrl(center.photoUrl) ?? ""} />
          : <div className="center-hero-badge">{center.name.slice(0, 1)}</div>}
        <div className="center-hero-name">{center.name}</div>
        {center.address && <div className="center-hero-addr">📍 {center.address}</div>}
        {center.phone && (
          <a className="center-hero-phone" href={`tel:${center.phone}`}>📞 {center.phone}</a>
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
      {/* 위치 */}
      {center.address && (
        <>
          <div className="menu-section-label">위치</div>
          <button className="center-map-link" onClick={() => setMapSheet(true)}>
            <div className="center-map-addr">📍 {center.address}</div>
            <div className="center-map-open">지도 · 길찾기 ›</div>
          </button>
        </>
      )}

      {/* 소개 (블로그식: 글/사진 번갈아) */}
      {(center.introBlocks.length > 0 || center.intro) && (
        <>
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
        </>
      )}

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
              {myReview && myReview.id === r.id && (
                <div className="review-actions">
                  <button className="review-edit" disabled={rvBusy} onClick={openEditReview}>수정</button>
                  <button className="review-del" disabled={rvBusy} onClick={handleDeleteReview}>삭제</button>
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
        <button className="center-bar-btn buy" onClick={() => setBuySheet(true)}>구매하기</button>
        <button className="center-bar-btn reserve" onClick={handleReserveClick}>예약하러 가기</button>
      </div>
      <BottomNav />
    </div>
  );
}
