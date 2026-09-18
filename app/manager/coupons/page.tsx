"use client";

/*
  매니저 - 쿠폰 관리 (MWHABIT Membership Visibility + Member Coupon Batch, 2026-09-18)
  - 쿠폰 정의 생성/보관
  - 회원에게 일괄 지급(RPC — 서버가 센터 격리/중복 지급 방지)
  - 지급/사용 현황 조회, 회수

  기존 수강권 관리(app/manager/membership-rules)와 같은 위치 맥락(관리자 메뉴)에 두되
  별도 화면으로 분리했다 — 쿠폰은 "상품"이 아니라 회원별로 지급하는 별개 개념이라
  membership-rules 화면에 욱여넣으면 오히려 더 헷갈린다.

  구매 자격/최종 할인금액은 전부 서버(orders INSERT RLS, 결제 확정 RPC)가 강제한다 —
  이 화면에서 하는 건 정의/지급/조회/회수뿐, 실제 사용 검증과는 무관하다.
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";
import { fetchProducts, won, type Product } from "../../../lib/passes";
import { fetchMembers, type CenterMember } from "../../../lib/members";
import {
  fetchCoupons, createCoupon, archiveCoupon, fetchCouponProductIds,
  issueCouponToMembers, revokeMemberCoupon, fetchIssuedMemberCoupons,
  type Coupon, type IssuedMemberCoupon, type DiscountType,
} from "../../../lib/coupons";

export default function CouponsPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);

  // 생성 시트
  const [sheet, setSheet] = useState(false);
  const [cName, setCName] = useState("");
  const [cType, setCType] = useState<DiscountType>("fixed");
  const [cValue, setCValue] = useState("");
  const [cMaxDiscount, setCMaxDiscount] = useState("");
  const [cMinOrder, setCMinOrder] = useState("");
  const [cAppliesTo, setCAppliesTo] = useState<"all" | "selected">("all");
  const [cProductIds, setCProductIds] = useState<string[]>([]);
  const [cValidFrom, setCValidFrom] = useState("");
  const [cValidUntil, setCValidUntil] = useState("");

  // 지급 시트
  const [issueFor, setIssueFor] = useState<Coupon | null>(null);
  const [issueSearch, setIssueSearch] = useState("");
  const [issueResults, setIssueResults] = useState<CenterMember[]>([]);
  const [issueSelected, setIssueSelected] = useState<Record<string, CenterMember>>({});

  // 상세 시트
  const [detailFor, setDetailFor] = useState<Coupon | null>(null);
  const [detailRows, setDetailRows] = useState<IssuedMemberCoupon[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailSearch, setDetailSearch] = useState("");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        setCenters(list);
        if (list.length > 0) setCenterId(list[0].id);
        else setLoading(false);
      } catch (e: any) { setError(e.message); setLoading(false); }
    })();
  }, []);

  const activeCenter = centers.find((c) => c.id === centerId);

  useEffect(() => {
    if (!activeCenter) return;
    if (activeCenter.isOwner) { setMyPerms(null); return; }
    let cancelled = false;
    setMyPerms(null);
    fetchMyEffectivePermissionKeys(activeCenter.managerCenterId, activeCenter.roleId)
      .then((keys) => { if (!cancelled) setMyPerms(keys); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [activeCenter]);

  function canDo(key: string): boolean {
    return canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, key);
  }
  // 쿠폰 지급은 수강권 발급과 같은 권한을 재사용한다(요청 13번 — 이미 있는 권한
  // 키, 새 권한 체계를 만들지 않음). 생성/보관/회수도 동일 권한으로 묶는다.
  const canManageCoupons = canDo("customer.member.issue_pass");

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const [c, p] = await Promise.all([fetchCoupons(centerId), fetchProducts(centerId)]);
      setCoupons(c);
      setProducts(p);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  const num = (s: string) => parseInt(s.replace(/[^0-9]/g, "") || "0", 10);

  function resetSheet() {
    setSheet(false);
    setCName(""); setCType("fixed"); setCValue(""); setCMaxDiscount(""); setCMinOrder("");
    setCAppliesTo("all"); setCProductIds([]); setCValidFrom(""); setCValidUntil("");
  }

  async function handleCreateCoupon() {
    if (!centerId || !cName.trim()) { setError("쿠폰 이름을 입력해주세요"); return; }
    if (num(cValue) <= 0) { setError("할인값을 입력해주세요"); return; }
    if (cType === "percentage" && num(cValue) > 100) { setError("정률 할인은 100%를 넘을 수 없어요"); return; }
    if (cAppliesTo === "selected" && cProductIds.length === 0) { setError("적용 대상 수강권을 1개 이상 선택해주세요"); return; }
    setBusy(true);
    try {
      await createCoupon(centerId, {
        name: cName.trim(),
        discountType: cType,
        discountValue: num(cValue),
        maxDiscountAmount: cType === "percentage" && cMaxDiscount.trim() ? num(cMaxDiscount) : null,
        minimumOrderAmount: cMinOrder.trim() ? num(cMinOrder) : null,
        appliesTo: cAppliesTo,
        productIds: cAppliesTo === "selected" ? cProductIds : undefined,
        validFrom: cValidFrom || null,
        validUntil: cValidUntil || null,
      });
      resetSheet();
      showToast("쿠폰을 만들었어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleArchive(c: Coupon) {
    if (!(await globalThis.appConfirm(`'${c.name}' 쿠폰을 보관할까요? 이미 지급된 쿠폰에는 영향 없고, 앞으로 새로 지급만 막혀요.`))) return;
    setBusy(true);
    try { await archiveCoupon(c.id); showToast("보관했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  // ---------------- 지급 ----------------
  function openIssueSheet(c: Coupon) {
    setIssueFor(c); setIssueSearch(""); setIssueResults([]); setIssueSelected({});
  }

  useEffect(() => {
    if (!centerId || !issueFor || !issueSearch.trim()) { setIssueResults([]); return; }
    const kw = issueSearch.trim();
    const t = setTimeout(() => {
      fetchMembers(centerId, { keyword: kw }).then((rows) => setIssueResults(rows.slice(0, 30))).catch(() => setIssueResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [centerId, issueFor, issueSearch]);

  function toggleIssueMember(cm: CenterMember) {
    setIssueSelected((prev) => {
      const next = { ...prev };
      if (next[cm.id]) delete next[cm.id]; else next[cm.id] = cm;
      return next;
    });
  }

  async function handleIssue() {
    if (!issueFor) return;
    const ids = Object.keys(issueSelected);
    if (ids.length === 0) { setError("지급할 회원을 1명 이상 선택해주세요"); return; }
    setBusy(true);
    try {
      const result = await issueCouponToMembers(issueFor.id, ids);
      setIssueFor(null); setIssueSelected({}); setIssueSearch(""); setIssueResults([]);
      showToast(
        result.skippedCount > 0
          ? `${result.issuedCount}명에게 지급했어요(이미 보유 중이라 ${result.skippedCount}명은 건너뜀)`
          : `${result.issuedCount}명에게 지급했어요`
      );
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  // ---------------- 상세/회수 ----------------
  async function openDetail(c: Coupon) {
    setDetailFor(c); setDetailSearch(""); setDetailLoading(true);
    try { setDetailRows(await fetchIssuedMemberCoupons(c.id)); }
    catch (e: any) { setError(e.message); }
    finally { setDetailLoading(false); }
  }

  async function handleRevoke(row: IssuedMemberCoupon) {
    if (!(await globalThis.appConfirm(`${row.memberName}님의 쿠폰을 회수할까요?`))) return;
    setBusy(true);
    try {
      await revokeMemberCoupon(row.id);
      showToast("회수했어요");
      if (detailFor) setDetailRows(await fetchIssuedMemberCoupons(detailFor.id));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const statusLabel: Record<string, string> = { available: "사용가능", used: "사용완료", expired: "만료", revoked: "회수됨" };
  const filteredDetailRows = detailSearch.trim()
    ? detailRows.filter((r) => r.memberName.includes(detailSearch.trim()) || (r.memberPhone ?? "").includes(detailSearch.trim()))
    : detailRows;

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">쿠폰 관리</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">쿠폰 관리</div>
        {canManageCoupons && <button className="header-action" onClick={() => setSheet(true)}>+ 쿠폰</button>}
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      <div className="perm-guide">
        회원에게 할인쿠폰을 지급하면, 허용된 수강권 구매 시 회원이 직접 골라 쓸 수 있어요.
        할인금액은 항상 결제 확정 시점에 서버가 다시 계산해요.
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : coupons.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 30 }}>
          만든 쿠폰이 없어요<br />
          <span style={{ fontSize: 12 }}>우측 상단 &apos;+ 쿠폰&apos;으로 추가하세요</span>
        </div>
      ) : (
        <div className="pass-list">
          {coupons.map((c) => (
            <div key={c.id} className="pass-card">
              <div className="pass-head">
                <div>
                  <div className="pass-name">
                    {c.name}
                    {c.status === "archived" && <span className="pass-group-tag">보관됨</span>}
                  </div>
                  <div className="pass-sub">
                    {c.discountType === "fixed" ? `${won(c.discountValue)} 할인` : `${c.discountValue}% 할인${c.maxDiscountAmount ? ` (최대 ${won(c.maxDiscountAmount)})` : ""}`}
                    {c.minimumOrderAmount ? ` · ${won(c.minimumOrderAmount)} 이상 구매 시` : ""}
                  </div>
                  <div className="pass-sub">
                    지급 {c.issuedCount}명 · 사용 {c.usedCount}명
                    {c.validUntil && ` · ${new Date(c.validUntil).toLocaleDateString("ko-KR")}까지`}
                  </div>
                </div>
                {canManageCoupons && (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {c.status === "active" && <button className="quiet-action" disabled={busy} onClick={() => openIssueSheet(c)}>지급</button>}
                    <button className="quiet-action" disabled={busy} onClick={() => openDetail(c)}>상세</button>
                    {c.status === "active" && <button className="quiet-action danger" disabled={busy} onClick={() => handleArchive(c)}>보관</button>}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div style={{ height: 40 }} />
        </div>
      )}

      {/* 쿠폰 생성 시트 */}
      {sheet && (
        <div className="sheet-overlay" onClick={resetSheet}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">쿠폰 만들기</div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>쿠폰명</div>
            <input className="input-field" placeholder="예: VIP 특별 3만원 할인" value={cName} onChange={(e) => setCName(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>할인 방식</div>
            <div style={{ display: "flex", gap: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={cType === "fixed"} onChange={() => setCType("fixed")} /> 정액 할인
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={cType === "percentage"} onChange={() => setCType("percentage")} /> 정률 할인
              </label>
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>할인값{cType === "percentage" ? " (%)" : " (원)"}</div>
            <input inputMode="numeric" className="input-field" placeholder={cType === "percentage" ? "예: 20" : "예: 30000"} value={cValue} onChange={(e) => setCValue(e.target.value)} />

            {cType === "percentage" && (
              <>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>최대 할인금액 (선택)</div>
                <input inputMode="numeric" className="input-field" placeholder="예: 30000" value={cMaxDiscount} onChange={(e) => setCMaxDiscount(e.target.value)} />
              </>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>최소 결제금액 (선택)</div>
            <input inputMode="numeric" className="input-field" placeholder="예: 100000" value={cMinOrder} onChange={(e) => setCMinOrder(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>사용 시작일 (선택)</div>
            <input type="date" className="input-field" value={cValidFrom} onChange={(e) => setCValidFrom(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>사용 종료일 (선택)</div>
            <input type="date" className="input-field" value={cValidUntil} onChange={(e) => setCValidUntil(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>적용 대상</div>
            <div style={{ display: "flex", gap: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={cAppliesTo === "all"} onChange={() => setCAppliesTo("all")} /> 모든 수강권
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={cAppliesTo === "selected"} onChange={() => setCAppliesTo("selected")} /> 지정 수강권
              </label>
            </div>

            {cAppliesTo === "selected" && (() => {
              // 상품 자체가 "쿠폰 적용 불가"(add_product_coupon_eligibility.sql)면 여기서
              // 골라도 결제 시점에 서버가 항상 막으므로, 애초에 고를 수 없게 목록에서
              // 뺀다 — 매니저가 골랐다가 나중에 "왜 안 되지" 하는 혼란을 미리 없앤다.
              const eligibleProducts = products.filter((p) => p.couponEligible);
              return (
                <div className="mem-filters" style={{ padding: "8px 0 0", flexWrap: "wrap" }}>
                  {eligibleProducts.length === 0 ? (
                    <div className="perm-guide">
                      {products.length === 0
                        ? "먼저 수강권 관리에서 상품을 만들어주세요."
                        : "쿠폰 적용 가능한 상품이 없어요(전부 '쿠폰 적용 불가'로 설정됨 — 수강권 관리에서 바꿀 수 있어요)."}
                    </div>
                  ) : (
                    eligibleProducts.map((p) => (
                      <button
                        key={p.id} type="button"
                        className={`filter-chip ${cProductIds.includes(p.id) ? "on" : ""}`}
                        onClick={() => setCProductIds((prev) => prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id])}
                      >
                        {p.name}
                      </button>
                    ))
                  )}
                </div>
              );
            })()}

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={resetSheet}>취소</button>
              <button className="outline-action" disabled={busy} onClick={handleCreateCoupon}>쿠폰 생성</button>
            </div>
          </div>
        </div>
      )}

      {/* 지급 시트 */}
      {issueFor && (
        <div className="sheet-overlay" onClick={() => setIssueFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">쿠폰 지급 — {issueFor.name}</div>
            <input className="input-field" placeholder="이름 또는 전화번호 검색" value={issueSearch} onChange={(e) => setIssueSearch(e.target.value)} />
            {issueResults.length > 0 && (
              <div style={{ marginTop: 6, maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                {issueResults.map((cm) => (
                  <label key={cm.id} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", cursor: "pointer" }}>
                    <input type="checkbox" checked={!!issueSelected[cm.id]} onChange={() => toggleIssueMember(cm)} />
                    <span>{cm.name}</span>
                    <span style={{ color: "var(--text-dim)", marginLeft: "auto" }}>{cm.phone ?? ""}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="perm-guide" style={{ margin: "10px 0 4px" }}>선택 {Object.keys(issueSelected).length}명</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.values(issueSelected).map((cm) => (
                <span key={cm.id} className="filter-chip on" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {cm.name}
                  <button type="button" onClick={() => toggleIssueMember(cm)} aria-label="선택 해제" style={{ background: "none", border: "none", cursor: "pointer", color: "inherit" }}>×</button>
                </span>
              ))}
            </div>
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setIssueFor(null)}>취소</button>
              <button className="outline-action" disabled={busy} onClick={handleIssue}>쿠폰 지급</button>
            </div>
          </div>
        </div>
      )}

      {/* 상세 시트 */}
      {detailFor && (
        <div className="sheet-overlay" onClick={() => setDetailFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{detailFor.name} — 지급 내역</div>
            <input className="input-field" placeholder="회원명 또는 전화번호 검색" value={detailSearch} onChange={(e) => setDetailSearch(e.target.value)} />
            {detailLoading ? (
              <Loading />
            ) : filteredDetailRows.length === 0 ? (
              <div className="daylist-empty" style={{ paddingTop: 20 }}>지급 내역이 없어요</div>
            ) : (
              <div style={{ marginTop: 8, maxHeight: 320, overflowY: "auto" }}>
                {filteredDetailRows.map((r) => (
                  <div key={r.id} className="pass-card" style={{ marginBottom: 8 }}>
                    <div className="pass-head">
                      <div>
                        <div className="pass-name">{r.memberName}</div>
                        <div className="pass-sub">
                          {statusLabel[r.status] ?? r.status} · 지급 {new Date(r.issuedAt).toLocaleDateString("ko-KR")}
                          {r.usedAt && ` · 사용 ${new Date(r.usedAt).toLocaleDateString("ko-KR")}`}
                        </div>
                      </div>
                      {canManageCoupons && r.status === "available" && (
                        <button className="quiet-action danger" disabled={busy} onClick={() => handleRevoke(r)}>회수</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setDetailFor(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
