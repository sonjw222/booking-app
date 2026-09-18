"use client";

/*
  매니저 - 수강권 상품 & 예약조건 설정
  - 상품(수강권 종류) 생성/삭제
  - 상품마다 "요일 + 시간 + 수업명" 조건을 여러 개 부여
  - 조건이 없으면 = 모든 수업 예약 가능
  - 예: "안무반 수강권" → 월 19:00 안무반, 수 21:00 안무반만 예약 가능
  - 수강권 관리 권한(pass.update) 필요
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchProducts, createProduct, updateProduct, deleteProduct, toggleProductSale,
  fetchRules, addRule, deleteRule, ruleToText, won, DAYS,
  type Product, type ScheduleRule, type ProductVisibility,
} from "../../../lib/passes";
import { fetchExistingClassOptions, type ExistingClassOption } from "../../../lib/classes";
import { fetchGrades, fetchMembers, type Grade, type CenterMember } from "../../../lib/members";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";
import ExpiryOptionField, { type ExpiryOptionValue } from "../../components/ExpiryOptionField";

export default function MembershipRulesPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [rulesByProduct, setRulesByProduct] = useState<Record<string, ScheduleRule[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 상품 추가/수정 시트 — editingId가 있으면 수정 모드(같은 시트 재사용)
  const [prodSheet, setProdSheet] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pName, setPName] = useState("");
  const [pGroupLabel, setPGroupLabel] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pAutoDays, setPAutoDays] = useState<number[]>([]);
  const [pAutoClasses, setPAutoClasses] = useState<string[]>([]);
  const [pPrice, setPPrice] = useState("");
  const [pCount, setPCount] = useState("");
  const [pUnlimited, setPUnlimited] = useState(false);
  const [pExpiry, setPExpiry] = useState<ExpiryOptionValue>({ mode: "none", days: "", date: "", cutoffDay: "", allowEarlyUse: false });
  const [pLimitSale, setPLimitSale] = useState(false);
  const [pMaxQty, setPMaxQty] = useState("");
  // MWHABIT Membership Visibility Batch(2026-09-18) — 공개범위
  const [pVisType, setPVisType] = useState<ProductVisibility["type"]>("all");
  const [pVisGradeIds, setPVisGradeIds] = useState<string[]>([]);
  const [pVisMemberIds, setPVisMemberIds] = useState<string[]>([]);
  const [pVisMemberLabels, setPVisMemberLabels] = useState<Record<string, string>>({}); // center_member_id -> "이름 전화"
  const [grades, setGrades] = useState<Grade[]>([]);
  const [visMemberSearch, setVisMemberSearch] = useState("");
  const [visMemberResults, setVisMemberResults] = useState<CenterMember[]>([]);
  const [visMemberSearchBusy, setVisMemberSearchBusy] = useState(false);

  // 조건 추가 시트 (어느 상품에)
  const [ruleFor, setRuleFor] = useState<Product | null>(null);
  const [rDays, setRDays] = useState<number[]>([]);
  const [rTime, setRTime] = useState("");
  const [rTitle, setRTitle] = useState("");
  const [rPick, setRPick] = useState("");
  const [existingClasses, setExistingClasses] = useState<ExistingClassOption[]>([]);
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
  // UX 감사(B-8) — 수강권 상품이 100개+(이름이 UUID로 끝나 구분도 안 됨)면 검색/페이징 없이
  // 전부 렌더돼 원하는 걸 찾기 어려웠다. 이름 검색 + 20개씩 "더보기"로 완화.
  const [search, setSearch] = useState("");
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

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

  // 이 화면 메뉴 게이트는 pass.create지만, "예약조건"(schedule_rules)은 별도로
  // pass.update RLS를 요구한다 — 상품 CRUD와는 다른 키라 여기서 따로 체크한다.
  const canEditRules = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "pass.update");
  // 상품 CRUD(등록=pass.create, 수정/삭제=pass.update)는 P1-5b에서 RLS를 실제로 좁힘
  // (fix_permission_products_rooms_rls.sql) — 그 전까지는 my_managed_center_ids()만 체크했다.
  const canCreateProduct = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "pass.create");
  const canToggleSale = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "pass.sale_toggle");

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const prods = await fetchProducts(centerId);
      setProducts(prods);
      // 각 상품의 조건 로드
      const map: Record<string, ScheduleRule[]> = {};
      await Promise.all(prods.map(async (p) => { map[p.id] = await fetchRules(p.id); }));
      setRulesByProduct(map);
      // MWHABIT Membership Visibility Batch — 공개범위 "특정 등급" 체크박스용 등급 목록.
      // 다른 센터 등급은 fetchGrades(centerId)가 애초에 이 센터 것만 가져오므로(RLS도
      // 이중 방어) 섞일 일 없음.
      setGrades(await fetchGrades(centerId));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  const num = (s: string) => parseInt(s.replace(/[^0-9]/g, "") || "0", 10);

  function resetProdSheet() {
    setProdSheet(false); setEditingId(null);
    setPName(""); setPGroupLabel(""); setPDesc(""); setPPrice(""); setPCount("");
    setPAutoDays([]); setPAutoClasses([]);
    setPUnlimited(false); setPExpiry({ mode: "none", days: "", date: "", cutoffDay: "", allowEarlyUse: false });
    setPLimitSale(false); setPMaxQty("");
    setPVisType("all"); setPVisGradeIds([]); setPVisMemberIds([]); setPVisMemberLabels({});
    setVisMemberSearch(""); setVisMemberResults([]);
  }

  function openCreateSheet() {
    resetProdSheet();
    setProdSheet(true);
  }

  async function openEditSheet(p: Product) {
    setEditingId(p.id);
    setPName(p.name);
    setPGroupLabel(p.groupLabel ?? "");
    setPDesc(p.description ?? "");
    setPPrice(String(p.price));
    setPCount(p.totalCount ? String(p.totalCount) : "");
    setPUnlimited(p.unlimitedPass);
    setPAutoDays(p.autoBookDays ?? []);
    setPAutoClasses([]);
    setPExpiry({
      mode: p.expiryMode,
      days: p.expiryDays ? String(p.expiryDays) : "",
      date: p.expiryDate ?? "",
      cutoffDay: p.rollingMonthCutoffDay != null ? String(p.rollingMonthCutoffDay) : "",
      allowEarlyUse: p.rollingMonthAllowEarlyUse ?? false,
    });
    setPLimitSale(p.maxQuantity != null);
    setPMaxQty(p.maxQuantity != null ? String(p.maxQuantity) : "");
    // MWHABIT Membership Visibility Batch — 공개범위 프리필. "지정 회원" 칩에 이름/전화를
    // 보여주려면 center_member_id뿐 아니라 표시용 라벨도 필요해서, 이 센터의 회원
    // 목록(기존 fetchMembers 재사용)에서 매칭해 채운다.
    setPVisType(p.visibility.type);
    setPVisGradeIds(p.visibility.gradeIds);
    setPVisMemberIds(p.visibility.memberIds);
    if (p.visibility.type === "selected_members" && p.visibility.memberIds.length > 0 && centerId) {
      const all = await fetchMembers(centerId);
      const labels: Record<string, string> = {};
      for (const cm of all) {
        if (p.visibility.memberIds.includes(cm.id)) labels[cm.id] = `${cm.name}${cm.phone ? " " + cm.phone : ""}`;
      }
      setPVisMemberLabels(labels);
    } else {
      setPVisMemberLabels({});
    }
    setProdSheet(true);
  }

  function toggleVisGrade(gradeId: string) {
    setPVisGradeIds((prev) => (prev.includes(gradeId) ? prev.filter((g) => g !== gradeId) : [...prev, gradeId]));
  }

  function addVisMember(cm: CenterMember) {
    setPVisMemberIds((prev) => (prev.includes(cm.id) ? prev : [...prev, cm.id])); // 중복 선택 방지
    setPVisMemberLabels((prev) => ({ ...prev, [cm.id]: `${cm.name}${cm.phone ? " " + cm.phone : ""}` }));
  }

  function removeVisMember(centerMemberId: string) {
    setPVisMemberIds((prev) => prev.filter((id) => id !== centerMemberId));
  }

  // 회원검색 재사용(요청 2-3번 "기존 회원검색 구조 재사용") — lib/members.ts의
  // fetchMembers(keyword)를 그대로 쓴다. 새 검색 컴포넌트/쿼리를 만들지 않음.
  // 150ms 디바운스(폴리시 배치가 정착시킨 관례와 동일한 대역).
  useEffect(() => {
    if (!centerId || pVisType !== "selected_members" || !visMemberSearch.trim()) {
      setVisMemberResults([]);
      return;
    }
    const kw = visMemberSearch.trim();
    setVisMemberSearchBusy(true);
    const t = setTimeout(() => {
      fetchMembers(centerId, { keyword: kw })
        .then((rows) => setVisMemberResults(rows.slice(0, 30))) // 회원 많아도 버벅이지 않게 상한
        .catch(() => setVisMemberResults([]))
        .finally(() => setVisMemberSearchBusy(false));
    }, 150);
    return () => clearTimeout(t);
  }, [centerId, pVisType, visMemberSearch]);

  async function handleCreateProduct() {
    if (!centerId || !pName.trim()) { setError("상품 이름을 입력해주세요"); return; }
    if (num(pPrice) <= 0) { setError("가격을 입력해주세요"); return; }
    if (!pUnlimited && num(pCount) <= 0) { setError("총 횟수를 입력해주세요 (또는 '횟수 제한 없음'을 켜주세요)"); return; }
    if (pExpiry.mode === "days" && !pExpiry.days.trim()) { setError("만료까지 며칠인지 입력해주세요"); return; }
    if (pExpiry.mode === "date" && !pExpiry.date) { setError("만료일을 선택해주세요"); return; }
    if (pExpiry.mode === "rolling_month" && (!pExpiry.cutoffDay.trim() || num(pExpiry.cutoffDay) < 1 || num(pExpiry.cutoffDay) > 31)) {
      setError("며칠부터 다음 달로 칠지 1~31 사이로 입력해주세요"); return;
    }
    if (pLimitSale && num(pMaxQty) <= 0) { setError("판매 수량을 입력해주세요 (또는 '판매 수량 제한'을 꺼주세요)"); return; }
    if (pVisType === "grades" && pVisGradeIds.length === 0) { setError("공개범위를 '특정 회원등급'으로 하려면 등급을 1개 이상 선택해주세요"); return; }
    if (pVisType === "selected_members" && pVisMemberIds.length === 0) { setError("공개범위를 '지정 회원만'으로 하려면 회원을 1명 이상 선택해주세요"); return; }
    setBusy(true);
    try {
      const extra = {
        autoBookDays: pAutoDays,
        unlimitedPass: pUnlimited,
        description: pDesc.trim(),
        expiry: {
          mode: pExpiry.mode, days: pExpiry.mode === "days" ? num(pExpiry.days) : null, date: pExpiry.mode === "date" ? pExpiry.date : null,
          cutoffDay: pExpiry.mode === "rolling_month" ? num(pExpiry.cutoffDay) : null, allowEarlyUse: pExpiry.allowEarlyUse,
        },
        groupLabel: pGroupLabel.trim() || undefined,
        maxQuantity: pLimitSale ? num(pMaxQty) : null,
        visibility: { type: pVisType, gradeIds: pVisGradeIds, memberIds: pVisMemberIds } as ProductVisibility,
      };
      if (editingId) {
        await updateProduct(editingId, pName.trim(), num(pPrice), num(pCount), false, extra);
        resetProdSheet();
        showToast("수강권을 수정했어요");
        await load();
        return;
      }
      await createProduct(centerId, pName.trim(), num(pPrice), num(pCount), "pass", false, extra);
      // 선택한 수업이 있으면 예약조건으로 자동 등록 — 실패한 조건이 있으면 조용히 넘어가지 않고 안내한다.
      let failedRuleCount = 0;
      if (pAutoClasses.length > 0) {
        const fresh = await fetchProducts(centerId, "pass");
        const made = fresh.find((x) => x.name === pName.trim());
        if (made) {
          for (const key of pAutoClasses) {
            const [dw, st2, ti] = key.split("|");
            try {
              await addRule(made.id, Number(dw), st2 || null, ti || null);
            } catch {
              failedRuleCount += 1;
            }
          }
        }
      }
      resetProdSheet();
      if (failedRuleCount > 0) {
        setError(`상품은 추가됐지만 예약조건 ${failedRuleCount}건은 등록에 실패했어요. 조건 추가에서 다시 시도해주세요.`);
      } else {
        showToast("상품을 추가했어요");
      }
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteProduct(p: Product) {
    if (!(await globalThis.appConfirm(`'${p.name}' 상품을 삭제할까요?`))) return;
    setBusy(true);
    try { await deleteProduct(p.id); showToast("삭제했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleToggleSale(p: Product) {
    const next = !p.isOnSale;
    if (!(await globalThis.appConfirm(next ? `'${p.name}' 판매를 다시 시작할까요?` : `'${p.name}' 판매를 정지할까요? (기존 보유자는 영향 없어요)`))) return;
    setBusy(true);
    try { await toggleProductSale(p.id, next); showToast(next ? "판매를 재개했어요" : "판매를 정지했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleAddRule() {
    if (!ruleFor) return;
    setBusy(true);
    try {
      const days: (number | null)[] = rDays.length > 0 ? rDays : [null];
      for (const d of days) {
        await addRule(ruleFor.id, d, rTime || null, rTitle.trim() || null);
      }
      setRDays([]); setRTime(""); setRTitle("");
      setRuleFor(null);
      showToast("조건을 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteRule(id: string) {
    setBusy(true);
    try { await deleteRule(id); showToast("조건을 삭제했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">수강권 관리</div>
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
        <div className="title">수강권 관리</div>
        {canCreateProduct && (
          <button className="header-action" onClick={openCreateSheet}>+ 수강권</button>
        )}
      </div>

      {centers.length > 1 && (
        <>
          <div className="menu-section-label" style={{ padding: "0 20px 4px" }}>지금 보는 센터</div>
          <div className="center-switcher">
            {centers.map((c) => (
              <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="perm-guide">
        수강권 상품마다 예약 가능한 <b>요일·시간·수업</b>을 정할 수 있어요.
        조건이 없으면 모든 수업을 예약할 수 있고, 조건을 넣으면 그에 맞는 수업만 예약돼요.
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {!loading && products.length > 10 && (
        <input
          className="input-field"
          style={{ margin: "0 20px 10px", width: "calc(100% - 40px)" }}
          placeholder="상품 이름 검색"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
        />
      )}

      {loading ? (
        <Loading />
      ) : products.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 30 }}>
          등록된 수강권이 없어요<br />
          <span style={{ fontSize: 12 }}>우측 상단 '+ 수강권'으로 추가하세요</span>
        </div>
      ) : (() => {
        const filtered = search.trim()
          ? products.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
          : products;
        if (filtered.length === 0) {
          return <div className="daylist-empty" style={{ paddingTop: 30 }}>"{search}"와(과) 일치하는 상품이 없어요</div>;
        }
        return (
        <div className="pass-list">
          {filtered.slice(0, visibleCount).map((p) => {
            const rules = rulesByProduct[p.id] ?? [];
            return (
              <div key={p.id} className="pass-card">
                <div className="pass-head">
                  <div>
                    <div className="pass-name">
                      {p.name}
                      {p.groupLabel && <span className="pass-group-tag">{p.groupLabel}</span>}
                      {!p.isOnSale && <span className="pass-group-tag" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>판매정지</span>}
                      {p.maxQuantity != null && (
                        <span className="pass-group-tag" style={p.soldCount >= p.maxQuantity ? { background: "var(--danger-soft)", color: "var(--danger)" } : undefined}>
                          {p.soldCount >= p.maxQuantity ? "매진" : `${p.maxQuantity - p.soldCount}개 남음`}
                        </span>
                      )}
                      {/* MWHABIT Membership Visibility Batch — 공개범위 subtle badge(요청
                          8번, "과도하게 복잡하지 않게"). 전체 공개는 굳이 표시 안 함(기본
                          상태라 노이즈만 됨) — 제한이 걸린 경우만 눈에 띄게 보여준다. */}
                      {p.visibility.type === "grades" && (
                        <span className="pass-group-tag" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                          {(() => {
                            const names = p.visibility.gradeIds.map((id) => grades.find((g) => g.id === id)?.name).filter(Boolean);
                            if (names.length === 0) return "등급 지정";
                            if (names.length === 1) return names[0];
                            return `${names[0]} 외 ${names.length - 1}개 등급`;
                          })()}
                        </span>
                      )}
                      {p.visibility.type === "selected_members" && (
                        <span className="pass-group-tag" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                          지정회원 {p.visibility.memberIds.length}명
                        </span>
                      )}
                    </div>
                    <div className="pass-sub">
                      {won(p.price)}{p.totalCount ? ` · ${p.totalCount}회` : ""}
                      {p.maxQuantity != null && ` · 판매 ${p.soldCount}/${p.maxQuantity}`}
                    </div>
                  </div>
                  {(canEditRules || canToggleSale) && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      {canToggleSale && (
                        <button className="quiet-action" disabled={busy} onClick={() => handleToggleSale(p)}>
                          {p.isOnSale ? "판매정지" : "판매재개"}
                        </button>
                      )}
                      {canEditRules && (
                        <>
                          <button className="quiet-action" disabled={busy} onClick={() => openEditSheet(p)}>수정</button>
                          <button className="quiet-action danger" disabled={busy} onClick={() => handleDeleteProduct(p)}>삭제</button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <button className="pass-rules-toggle" onClick={() => setExpandedProducts((prev) => {
                  const next = new Set(prev); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next;
                })}>
                  <span>예약 조건 {rules.length}개</span><b>{expandedProducts.has(p.id) ? "접기" : "보기"}⌄</b>
                </button>
                {expandedProducts.has(p.id) && <div className="pass-rules">
                  {rules.length === 0 ? (
                    <div className="pass-norule">모든 수업 예약 가능 (조건 없음)</div>
                  ) : (
                    rules.map((r) => (
                      <div key={r.id} className="pass-rule">
                        <span className="pass-rule-text">{ruleToText(r)}</span>
                        {canEditRules && (
                          <button className="pass-rule-del" disabled={busy} onClick={() => handleDeleteRule(r.id)} aria-label="규칙 삭제"><UiIcon name="close" size={13} /></button>
                        )}
                      </div>
                    ))
                  )}
                </div>}

                {canEditRules && (
                  <button className="prog-add-sub-btn" onClick={async () => { setRuleFor(p); setRPick(""); setRDays([]); setRTime(""); setRTitle(""); if (centerId) { try { setExistingClasses(await fetchExistingClassOptions(centerId)); } catch { setExistingClasses([]); } } }}>
                    예약조건 추가
                  </button>
                )}
              </div>
            );
          })}
          {filtered.length > visibleCount && (
            <button className="ghost-btn" style={{ margin: "12px 20px" }} onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
              더보기 ({filtered.length - visibleCount}건 더 있음)
            </button>
          )}
          <div style={{ height: 40 }} />
        </div>
        );
      })()}

      {/* 상품 추가/수정 시트 */}
      {prodSheet && (
        <div className="sheet-overlay" onClick={resetProdSheet}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{editingId ? "수강권 수정" : "수강권 추가"}</div>
            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>상품 이름</div>
            <input className="input-field" placeholder="예: 안무반 수강권" value={pName} onChange={(e) => setPName(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              그룹명 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 선택, 회원 화면에서 이 이름으로 묶여 보여요</span>
            </div>
            <input className="input-field" list="pass-group-label-options" placeholder="예: 요일고정, 자유이용" value={pGroupLabel} onChange={(e) => setPGroupLabel(e.target.value)} />
            <datalist id="pass-group-label-options">
              {Array.from(new Set(products.map((p) => p.groupLabel).filter((g): g is string => !!g))).map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              설명 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 선택, 회원이 이름을 누르면 보여요</span>
            </div>
            <textarea className="input-field" style={{ minHeight: 60, resize: "vertical", lineHeight: 1.5 }}
              placeholder="예: 화 19:00 안무반 전용 수강권이에요" value={pDesc} onChange={(e) => setPDesc(e.target.value)} />
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>가격</div>
            <input inputMode="numeric" className="input-field" placeholder="0" value={pPrice} onChange={(e) => setPPrice(e.target.value)} />
            <div className="set-row" style={{ padding: "12px 0 6px", borderBottom: "none" }}>
              <div className="set-label">횟수 제한 없음 (무제한)</div>
              <button className={`switch ${pUnlimited ? "on" : ""}`} onClick={() => setPUnlimited(!pUnlimited)}>
                <span className="knob" />
              </button>
            </div>
            {!pUnlimited && (
              <>
                <div className="menu-section-label" style={{ padding: "6px 0 6px" }}>총 횟수</div>
                <input inputMode="numeric" className="input-field" placeholder="예: 8" value={pCount} onChange={(e) => setPCount(e.target.value)} />
              </>
            )}

            {/* 판매 수량 제한 — "총 횟수"(수강권 1개당 사용 가능 횟수)와는 별개로, 이 상품
                자체를 몇 개까지만 판매할지(예: 정원 10명짜리 특강이면 10개) 설정 */}
            <div className="set-row" style={{ padding: "12px 0 6px", borderBottom: "none" }}>
              <div className="set-label">판매 수량 제한<br /><span style={{ fontSize: 11, color: "var(--text-dim)" }}>특강 등 — 정한 개수만큼 팔리면 자동으로 판매가 멈춰요</span></div>
              <button className={`switch ${pLimitSale ? "on" : ""}`} onClick={() => setPLimitSale(!pLimitSale)}>
                <span className="knob" />
              </button>
            </div>
            {pLimitSale && (
              <>
                <input inputMode="numeric" className="input-field" placeholder="예: 10" value={pMaxQty} onChange={(e) => setPMaxQty(e.target.value)} />
                {editingId && (() => {
                  const cur = products.find((x) => x.id === editingId);
                  if (!cur) return null;
                  return (
                    <div className="perm-guide" style={{ margin: "4px 0 0" }}>
                      지금까지 <b>{cur.soldCount}개</b> 판매됐어요. 이보다 적은 수로 줄이면 바로 추가 판매가 막혀요.
                    </div>
                  );
                })()}
              </>
            )}

            {/* 횟수와 별개로 기간을 걸 수 있음 — 예: 무제한+한 달 기간 = 기간권 효과,
                5회권+한 달 기간 = 5회 다 안 써도 한 달 뒤 자동 만료(사용자 요청, 2026-09-01) */}
            <ExpiryOptionField value={pExpiry} onChange={setPExpiry} />

            {/* MWHABIT Membership Visibility Batch(2026-09-18) — 공개 범위. 최종 강제는
                항상 서버(orders INSERT RLS + 결제 확정 RPC)에서 다시 하므로, 여기서
                뭘 고르든 UI 실수만으로 자격 없는 회원에게 판매되지는 않는다. */}
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>공개 범위</div>
            <div className="vis-type-options" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {([
                { v: "all", label: "전체 회원" },
                { v: "grades", label: "특정 회원등급" },
                { v: "selected_members", label: "지정 회원만" },
              ] as const).map((opt) => (
                <label key={opt.v} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input type="radio" name="pVisType" checked={pVisType === opt.v} onChange={() => setPVisType(opt.v)} />
                  {opt.label}
                </label>
              ))}
            </div>

            {pVisType === "grades" && (
              <div style={{ marginTop: 8 }}>
                {grades.length === 0 ? (
                  <div className="perm-guide">이 센터에 등록된 회원등급이 없어요. 회원 관리에서 등급을 먼저 만들어주세요.</div>
                ) : (
                  <div className="mem-filters" style={{ padding: 0, flexWrap: "wrap" }}>
                    {grades.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        className={`filter-chip ${pVisGradeIds.includes(g.id) ? "on" : ""}`}
                        style={g.color ? { borderColor: g.color } : undefined}
                        onClick={() => toggleVisGrade(g.id)}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {pVisType === "selected_members" && (
              <div style={{ marginTop: 8 }}>
                <input
                  className="input-field"
                  placeholder="회원 이름 또는 전화번호 검색"
                  value={visMemberSearch}
                  onChange={(e) => setVisMemberSearch(e.target.value)}
                />
                {visMemberSearchBusy && <div className="perm-guide" style={{ margin: "4px 0 0" }}>검색 중…</div>}
                {visMemberResults.length > 0 && (
                  <div className="vis-member-results" style={{ marginTop: 6, maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                    {visMemberResults.map((cm) => (
                      <button
                        key={cm.id}
                        type="button"
                        className="quiet-action"
                        style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "8px 10px", textAlign: "left" }}
                        disabled={pVisMemberIds.includes(cm.id)}
                        onClick={() => { addVisMember(cm); setVisMemberSearch(""); setVisMemberResults([]); }}
                      >
                        <span>{cm.name}</span>
                        <span style={{ color: "var(--text-dim)" }}>{cm.phone ?? ""}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="perm-guide" style={{ margin: "8px 0 4px" }}>선택된 회원 {pVisMemberIds.length}명</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {pVisMemberIds.map((id) => (
                    <span key={id} className="filter-chip on" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {pVisMemberLabels[id] ?? id}
                      <button type="button" onClick={() => removeVisMember(id)} aria-label="선택 해제" style={{ background: "none", border: "none", cursor: "pointer", color: "inherit" }}>×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              요일반 수강권 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 선택 시 회원이 자동예약을 고를 수 있어요</span>
            </div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {["일", "월", "화", "수", "목", "금", "토"].map((w, i) => (
                <button key={i} className={`filter-chip ${pAutoDays.includes(i) ? "on" : ""}`}
                  onClick={() => setPAutoDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}>
                  {w}
                </button>
              ))}
            </div>
            <div className="perm-guide" style={{ margin: "4px 0 0" }}>
              예) 화요일 4회권이면 <b>화</b>만 선택. 아무것도 안 고르면 일반 수강권이에요.
              {!editingId && " 여기서는 이미 등록된 수업 중에서만 골라요 — 더 자유롭게 조건을 걸고 싶으면(예: 특정 시간대만, 아직 안 만든 수업) 만든 뒤 카드의 \"예약조건 추가\"를 따로 이용하세요."}
            </div>

            {!editingId && pAutoDays.length > 0 && (() => {
              const dayClasses = existingClasses.filter((c) => pAutoDays.includes(c.dayOfWeek));
              return (
                <>
                  <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
                    수강 가능한 수업 <span style={{ fontSize: 11, color: "var(--text-dim)" }}>· 안 고르면 그 요일 전체</span>
                  </div>
                  {dayClasses.length === 0 ? (
                    <div className="daylist-empty" style={{ padding: 12 }}>
                      선택한 요일에 등록된 수업이 없어요
                    </div>
                  ) : (
                    <div className="copy-select-list" style={{ maxHeight: 160 }}>
                      {dayClasses.map((c, i) => {
                        const key = `${c.dayOfWeek}|${c.startTime}|${c.title}`;
                        return (
                          <label key={i} className="copy-select-row">
                            <input type="checkbox" checked={pAutoClasses.includes(key)}
                              onChange={() => setPAutoClasses((prev) =>
                                prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])} />
                            <span className="copy-select-main">
                              <b>{c.title}</b>
                              <span className="copy-select-sub">{DAYS[c.dayOfWeek]}요일 {c.startTime}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={resetProdSheet}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleCreateProduct}>{editingId ? "저장" : "추가"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 조건 추가 시트 */}
      {ruleFor && (
        <div className="sheet-overlay" onClick={() => setRuleFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{ruleFor.name} 조건 추가</div>

            {(() => {
              const lockDays = ruleFor.autoBookDays ?? [];
              const isWeekdayPass = lockDays.length > 0;
              const pickable = isWeekdayPass
                ? existingClasses.filter((c) => lockDays.includes(c.dayOfWeek))
                : existingClasses;
              return (
                <>
                  {isWeekdayPass && (
                    <div className="perm-guide" style={{ margin: "0 0 12px" }}>
                      이 수강권은 <b>{lockDays.map((d) => DAYS[d]).join("·")}요일반</b>이에요.
                      해당 요일 수업만 지정할 수 있어요.
                    </div>
                  )}
                  {pickable.length > 0 ? (
                    <>
                      <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>
                        {isWeekdayPass ? "이 요일의 수업에서 고르기" : "기존 수업에서 고르기 (선택하면 자동 입력)"}
                      </div>
                      <select className="input-field" value={rPick} onChange={(e) => {
                        setRPick(e.target.value);
                        const idx = Number(e.target.value);
                        if (isNaN(idx)) return;
                        const c = pickable[idx];
                        if (c) { setRDays([c.dayOfWeek]); setRTime(c.startTime); setRTitle(c.title); }
                      }}>
                        <option value="">직접 입력하기</option>
                        {pickable.map((c, i) => (
                          <option key={i} value={i}>{DAYS[c.dayOfWeek]} {c.startTime} · {c.title}</option>
                        ))}
                      </select>
                    </>
                  ) : isWeekdayPass ? (
                    <div className="daylist-empty" style={{ padding: 14 }}>
                      {lockDays.map((d) => DAYS[d]).join("·")}요일에 등록된 수업이 없어요
                    </div>
                  ) : null}
                </>
              );
            })()}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
              요일 {(ruleFor.autoBookDays ?? []).length > 0 ? "(요일반이라 고정)" : "(여러 개 선택 가능, 안 고르면 모든 요일)"}
            </div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {(ruleFor.autoBookDays ?? []).length > 0 ? (
                (ruleFor.autoBookDays ?? []).map((d) => (
                  <button key={d} className="filter-chip on" disabled>{DAYS[d]}</button>
                ))
              ) : (
                <>
                  <button className={`filter-chip ${rDays.length === 0 ? "on" : ""}`} onClick={() => setRDays([])}>모든 요일</button>
                  {DAYS.map((d, i) => (
                    <button key={i} className={`filter-chip ${rDays.includes(i) ? "on" : ""}`} onClick={() => setRDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}>{d}</button>
                  ))}
                </>
              )}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>시작 시간 (비우면 모든 시간)</div>
            <input type="time" className="input-field" value={rTime} onChange={(e) => setRTime(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>수업명 포함 (비우면 모든 수업)</div>
            <input className="input-field" placeholder="예: 안무반" value={rTitle} onChange={(e) => setRTitle(e.target.value)} />

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setRuleFor(null)}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleAddRule}>추가</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
