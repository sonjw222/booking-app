"use client";

/*
  매니저 - 매출 관리 화면
  - 상단: 기간 선택 + 순매출/미수금 요약
  - 결제수단별 / 매출구분별 집계
  - 결제 내역 목록
  - "+ 결제 등록" 시트: 회원·매출구분·분할결제·미수금·담당강사
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import DatePicker from "../../components/DatePicker";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  registerPayment, fetchPayments, summarize, paymentsToCsv,
  fetchCenterMembersForPayment, fetchCenterStaffForPayment, fetchSaleProducts,
  SALE_TYPE_LABEL, METHOD_LABEL, won,
  registerExpense, fetchExpenses, deleteExpense, summarizeExpenses, EXPENSE_CATEGORIES,
  registerPoint, fetchPoints, computeAutoUnpaid,
  type PaymentRow, type RevenueSummary,
  type ExpenseRow, type PointRow,
} from "../../../lib/sales";
import { fetchSettings } from "../../../lib/settings";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";

function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
function monthStartStr() {
  const t = todayStr();
  return t.slice(0, 8) + "01";
}

const SALES_CSV_COLUMNS = [
  { key: "profileName", label: "회원" },
  { key: "saleType", label: "구분" },
  { key: "productName", label: "상품/수강권" },
  { key: "paidAt", label: "결제일" },
  { key: "trainerName", label: "담당" },
  { key: "cardAmount", label: "카드" },
  { key: "cashAmount", label: "현금" },
  { key: "transferAmount", label: "계좌이체" },
  { key: "pointAmount", label: "포인트" },
  { key: "totalAmount", label: "합계" },
  { key: "unpaidAmount", label: "미수금" },
  { key: "memo", label: "메모" },
];

export default function SalesPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [tab, setTab] = useState<"sales" | "expense" | "point">("sales");
  const [from, setFrom] = useState(monthStartStr());
  const [to, setTo] = useState(todayStr());
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [summary, setSummary] = useState<RevenueSummary | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [points, setPoints] = useState<PointRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 결제 등록 시트
  const [sheet, setSheet] = useState(false);
  const [members, setMembers] = useState<{ profileId: string; name: string }[]>([]);
  const [staff, setStaff] = useState<{ accountId: string; name: string }[]>([]);
  const [fProfile, setFProfile] = useState("");
  const [fSaleType, setFSaleType] = useState("new");
  const [saleProducts, setSaleProducts] = useState<{ id: string; name: string; price: number; totalCount: number | null; kind: "pass" | "goods"; unlimited: boolean }[]>([]);
  const [fProductId, setFProductId] = useState("");
  const [fGoodsId, setFGoodsId] = useState("");

  // 지출 등록 시트
  const [expSheet, setExpSheet] = useState(false);
  // 매출 드릴다운 (결제수단·매출구분·회원별 내역)
  const [drill, setDrill] = useState<{ kind: "method" | "saleType" | "member"; key: string; label: string } | null>(null);
  const [payDetail, setPayDetail] = useState<PaymentRow | null>(null);
  const [csvSheet, setCsvSheet] = useState(false);
  const [csvCols, setCsvCols] = useState<string[]>(["profileName", "saleType", "productName", "paidAt", "totalAmount", "unpaidAmount"]);
  const [eCategory, setECategory] = useState(EXPENSE_CATEGORIES[0]);
  const [eAmount, setEAmount] = useState("");
  const [eDate, setEDate] = useState(todayStr());
  const [eMemo, setEMemo] = useState("");

  // 포인트 등록 시트
  const [ptSheet, setPtSheet] = useState(false);
  const [ptProfile, setPtProfile] = useState("");
  const [ptSign, setPtSign] = useState<"earn" | "use">("earn");
  const [ptAmount, setPtAmount] = useState("");
  const [ptReason, setPtReason] = useState("");
  const [fCard, setFCard] = useState("");
  const [fCash, setFCash] = useState("");
  const [fTransfer, setFTransfer] = useState("");
  const [fPoint, setFPoint] = useState("");
  const [fUnpaid, setFUnpaid] = useState("");
  const [fTrainer, setFTrainer] = useState("");
  const [fPaidAt, setFPaidAt] = useState(todayStr());
  const [fMemo, setFMemo] = useState("");
  // 운영설정 "미수금 자동입력" — 켜져 있으면 상품가 - 입력된 결제수단 합계를 미수금에 자동 반영
  const [autoUnpaidInput, setAutoUnpaidInput] = useState(false);
  const [fUnpaidTouched, setFUnpaidTouched] = useState(false); // 사용자가 미수금을 직접 고쳤으면 자동계산 중단
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

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

  useEffect(() => {
    if (!centerId) return;
    fetchSettings(centerId).then((s) => setAutoUnpaidInput(s.autoUnpaidInput)).catch(() => setAutoUnpaidInput(false));
  }, [centerId]);

  // 미수금 자동입력: 상품을 고르고 결제수단 금액을 입력하는 동안, 사용자가 미수금 칸을 직접
  // 건드리지 않았다면 "상품가 - 입력된 결제수단 합계"(0 미만이면 0)를 자동으로 채운다.
  useEffect(() => {
    if (!autoUnpaidInput || fUnpaidTouched) return;
    const product = saleProducts.find((p) => p.id === fProductId);
    if (!product) return;
    const paid = num(fCard) + num(fCash) + num(fTransfer) + num(fPoint);
    const remaining = computeAutoUnpaid(product.price, paid);
    setFUnpaid(remaining > 0 ? String(remaining) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoUnpaidInput, fUnpaidTouched, fProductId, fCard, fCash, fTransfer, fPoint, saleProducts]);

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const [pay, exp, pts] = await Promise.all([
        fetchPayments(centerId, from, to),
        fetchExpenses(centerId, from, to),
        fetchPoints(centerId),
      ]);
      setRows(pay);
      setSummary(summarize(pay));
      setExpenses(exp);
      setPoints(pts);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId, from, to]);

  useEffect(() => { load(); }, [load]);

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
  const canCreatePayment = canDo("pass.payment.create");
  const canDeletePayment = canDo("pass.payment.delete");
  // registerPayment는 수강권/상품을 고르면 memberships에도 insert하므로(발급),
  // 그 경우엔 pass.payment.create뿐 아니라 customer.member.issue_pass도 필요하다.
  const canIssuePass = canDo("customer.member.issue_pass");

  async function openSheet() {
    if (!centerId) return;
    try {
      const [ms, st, prods] = await Promise.all([
        fetchCenterMembersForPayment(centerId),
        fetchCenterStaffForPayment(centerId),
        fetchSaleProducts(centerId),
      ]);
      setMembers(ms); setStaff(st); setSaleProducts(prods);
      setFProfile(ms[0]?.profileId ?? "");
      setFProductId("");
      setFUnpaidTouched(false);
      setSheet(true);
    } catch (e: any) { setError(e.message); }
  }

  const num = (s: string) => parseInt(s.replace(/[^0-9]/g, "") || "0", 10);
  const formTotal = num(fCard) + num(fCash) + num(fTransfer) + num(fPoint);

  function handleSalesCsvDownload() {
    if (csvCols.length === 0) { setError("내보낼 항목을 1개 이상 선택해주세요"); return; }
    const csv = paymentsToCsv(rows, csvCols);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `매출내역_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setCsvSheet(false);
    showToast(`${rows.length}건을 내보냈어요`);
  }

  async function handleRegister() {
    if (!centerId || !fProfile) { setError("회원을 선택해주세요"); return; }
    if (formTotal === 0 && num(fUnpaid) === 0) { setError("결제 금액을 입력해주세요"); return; }
    setBusy(true);
    try {
      const selectedProduct = saleProducts.find((p) => p.id === fProductId);
      const selectedGoods = saleProducts.find((p) => p.id === fGoodsId);
      await registerPayment({
        centerId, profileId: fProfile, saleType: fSaleType,
        productId: fProductId || null,
        productName: selectedProduct?.name ?? null,
        productCount: selectedProduct?.totalCount ?? null,
        extraProducts: selectedGoods
          ? [{ id: selectedGoods.id, name: selectedGoods.name, count: selectedGoods.totalCount, unlimited: selectedGoods.unlimited }]
          : [],
        cardAmount: num(fCard), cashAmount: num(fCash),
        transferAmount: num(fTransfer), pointAmount: num(fPoint),
        unpaidAmount: num(fUnpaid),
        trainerAccountId: fTrainer || null,
        paidAt: fPaidAt, memo: fMemo || undefined,
      });
      showToast("결제를 등록했어요");
      setSheet(false);
      // 폼 초기화
      setFCard(""); setFCash(""); setFTransfer(""); setFPoint(""); setFUnpaid(""); setFMemo("");
      setFSaleType("new"); setFProductId(""); setFGoodsId(""); setFUnpaidTouched(false);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function openPointSheet() {
    if (!centerId) return;
    try {
      const ms = await fetchCenterMembersForPayment(centerId);
      setMembers(ms);
      setPtProfile(ms[0]?.profileId ?? "");
      setPtSheet(true);
    } catch (e: any) { setError(e.message); }
  }

  async function handleRegisterExpense() {
    if (!centerId || num(eAmount) === 0) { setError("금액을 입력해주세요"); return; }
    setBusy(true);
    try {
      await registerExpense({ centerId, category: eCategory, amount: num(eAmount), spentAt: eDate, memo: eMemo || undefined });
      showToast("지출을 등록했어요");
      setExpSheet(false); setEAmount(""); setEMemo("");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteExpense(id: string) {
    if (!(await globalThis.appConfirm("이 지출을 삭제할까요?"))) return;
    setBusy(true);
    try { await deleteExpense(id); showToast("삭제했어요"); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleRegisterPoint() {
    if (!centerId || !ptProfile || num(ptAmount) === 0) { setError("회원과 금액을 확인해주세요"); return; }
    setBusy(true);
    try {
      const signed = ptSign === "use" ? -Math.abs(num(ptAmount)) : Math.abs(num(ptAmount));
      await registerPoint({ centerId, profileId: ptProfile, amount: signed, reason: ptReason || undefined });
      showToast(ptSign === "earn" ? "포인트를 적립했어요" : "포인트를 사용했어요");
      setPtSheet(false); setPtAmount(""); setPtReason(""); setPtSign("earn");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">매출 관리</div>
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
        <div className="title">매출 관리</div>
        {(tab !== "sales" || canCreatePayment) && (
          <button className="header-action" onClick={() => tab === "sales" ? openSheet() : tab === "expense" ? setExpSheet(true) : openPointSheet()}>+ 등록</button>
        )}
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div className="perm-tabs">
        <button className={`perm-tab ${tab === "sales" ? "on" : ""}`} onClick={() => setTab("sales")}>매출</button>
        <button className={`perm-tab ${tab === "expense" ? "on" : ""}`} onClick={() => setTab("expense")}>지출</button>
        <button className={`perm-tab ${tab === "point" ? "on" : ""}`} onClick={() => setTab("point")}>포인트</button>
      </div>

      {tab === "sales" && (
        <div style={{ padding: "0 20px 8px", textAlign: "right" }}>
          <a href="/manager/class-revenue" className="menu-section-label" style={{ display: "inline-block" }}>
            수업매출 캘린더(날짜별) 보기 ›
          </a>
        </div>
      )}

      {/* 기간 선택 (포인트 탭 제외) */}
      {tab !== "point" && (
        <div className="date-range">
          <DatePicker value={from} onChange={setFrom} label="매출 조회 시작일" />
          <span className="date-tilde">~</span>
          <DatePicker value={to} onChange={setTo} label="매출 조회 종료일" />
        </div>
      )}

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : tab === "sales" ? (
        <>
          {/* 순이익 = 순매출 - 지출 */}
          {summary && (
            <div className="sales-summary">
              <div className="sales-big">
                <div className="sales-big-label">순매출</div>
                <div className="sales-big-value">{won(summary.totalSales)}</div>
              </div>
              <div className="profit-line">
                <span>지출 {won(summarizeExpenses(expenses).total)}</span>
                <span className="profit-net">순이익 {won(summary.totalSales - summarizeExpenses(expenses).total)}</span>
              </div>
              {summary.totalUnpaid > 0 && (
                <div className="sales-unpaid">미수금 {won(summary.totalUnpaid)}</div>
              )}
            </div>
          )}

          {summary && (
            <>
              {/* 결제수단별 */}
              <div className="menu-section-label">결제수단별</div>
              <div className="sales-breakdown">
                {(["card", "cash", "transfer", "point", "direct"] as const).map((m) => (
                  <button key={m} className="sales-bd-item clickable" onClick={() => setDrill({ kind: "method", key: m, label: METHOD_LABEL[m] })}>
                    <span className="bd-label">{METHOD_LABEL[m]} ›</span>
                    <span className="bd-value">{won(summary.byMethod[m] ?? 0)}</span>
                  </button>
                ))}
              </div>

              {/* 매출구분별 */}
              {Object.keys(summary.bySaleType).length > 0 && (
                <>
                  <div className="menu-section-label">매출구분별</div>
                  <div className="sales-breakdown">
                    {Object.entries(summary.bySaleType).map(([k, v]) => (
                      <button key={k} className="sales-bd-item clickable" onClick={() => setDrill({ kind: "saleType", key: k, label: SALE_TYPE_LABEL[k] ?? k })}>
                        <span className="bd-label">{SALE_TYPE_LABEL[k] ?? k} ›</span>
                        <span className="bd-value">{won(v)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* 결제 내역 */}
          <div className="menu-section-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>결제 내역 {summary ? `(${summary.count}건)` : ""}</span>
            {rows.length > 0 && <button className="text-btn" onClick={() => setCsvSheet(true)}>엑셀 내보내기</button>}
          </div>
          {rows.length === 0 ? (
            <div className="daylist-empty" style={{ paddingTop: 20 }}>이 기간 결제 내역이 없어요</div>
          ) : (
            <div className="sales-list">
              {rows.map((r) => (
                <div key={r.id} className="sales-row">
                  <div className="sales-row-main">
                    <div className="sales-row-top">
                      <span className="sales-name clickable-name" onClick={() => setDrill({ kind: "member", key: r.profileName, label: r.profileName })}>{r.profileName} ›</span>
                      <span className={`sale-type-badge ${r.saleType === "refund" ? "refund" : ""}`}>
                        {SALE_TYPE_LABEL[r.saleType] ?? r.saleType}
                      </span>
                    </div>
                    {/* UX 감사(B-12) — 회원 이름만 있고 무엇이 팔렸는지가 없어 한 건씩
                        들어가야 알 수 있었다. 이미 조회돼 CSV/상세에만 쓰이던 productName을
                        목록 행에도 노출. */}
                    {r.productName && <div className="sales-row-product">{r.productName}</div>}
                    <div className="sales-row-sub">
                      {r.paidAt}
                      {r.trainerName && ` · ${r.trainerName}`}
                      {r.unpaidAmount > 0 && ` · 미수 ${won(r.unpaidAmount)}`}
                    </div>
                  </div>
                  <button className={`sales-amount clickable ${r.totalAmount < 0 ? "minus" : ""}`} onClick={() => setPayDetail(r)}>
                    {won(r.totalAmount)} ›
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : tab === "expense" ? (
        /* ---------- 지출 탭 ---------- */
        <>
          <div className="sales-summary">
            <div className="sales-big">
              <div className="sales-big-label">지출 합계</div>
              <div className="sales-big-value">{won(summarizeExpenses(expenses).total)}</div>
            </div>
          </div>

          {Object.keys(summarizeExpenses(expenses).byCategory).length > 0 && (
            <>
              <div className="menu-section-label">항목별</div>
              <div className="sales-breakdown">
                {Object.entries(summarizeExpenses(expenses).byCategory).map(([k, v]) => (
                  <div key={k} className="sales-bd-item">
                    <span className="bd-label">{k}</span>
                    <span className="bd-value">{won(v)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="menu-section-label">지출 내역 ({expenses.length}건)</div>
          {expenses.length === 0 ? (
            <div className="daylist-empty" style={{ paddingTop: 20 }}>이 기간 지출 내역이 없어요</div>
          ) : (
            <div className="sales-list">
              {expenses.map((e) => (
                <div key={e.id} className="sales-row">
                  <div className="sales-row-main">
                    <div className="sales-row-top">
                      <span className="sales-name">{e.category}</span>
                    </div>
                    <div className="sales-row-sub">{e.spentAt}{e.memo && ` · ${e.memo}`}</div>
                  </div>
                  <div className="sales-amount minus">-{won(e.amount)}</div>
                  <button className="text-btn danger" style={{ marginLeft: 8 }} disabled={busy} onClick={() => handleDeleteExpense(e.id)}>삭제</button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        /* ---------- 포인트 탭 ---------- */
        <>
          <div className="menu-section-label">포인트 내역 ({points.length}건)</div>
          {points.length === 0 ? (
            <div className="daylist-empty" style={{ paddingTop: 20 }}>포인트 내역이 없어요</div>
          ) : (
            <div className="sales-list">
              {points.map((p) => (
                <div key={p.id} className="sales-row">
                  <div className="sales-row-main">
                    <div className="sales-row-top">
                      <span className="sales-name">{p.profileName}</span>
                      <span className={`sale-type-badge ${p.amount < 0 ? "refund" : ""}`}>
                        {p.amount < 0 ? "사용" : "적립"}
                      </span>
                    </div>
                    <div className="sales-row-sub">{p.createdAt}{p.reason && ` · ${p.reason}`}</div>
                  </div>
                  <div className="point-right">
                    <div className={`sales-amount ${p.amount < 0 ? "minus" : ""}`}>
                      {p.amount > 0 ? "+" : ""}{p.amount.toLocaleString("ko-KR")}P
                    </div>
                    <div className="point-balance">잔여 {p.balanceAfter.toLocaleString("ko-KR")}P</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* 결제 등록 시트 */}
      {sheet && (
        <div className="sheet-overlay" onClick={() => setSheet(false)}>
          <div className="sheet tall payment-register-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">결제 등록</div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>회원</div>
            <select className="input-field" value={fProfile} onChange={(e) => setFProfile(e.target.value)}>
              {members.length === 0 && <option value="">등록된 회원이 없어요</option>}
              {members.map((m) => <option key={m.profileId} value={m.profileId}>{m.name}</option>)}
            </select>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>수강권 (선택 시 발급)</div>
            <select className="input-field" value={fProductId} onChange={(e) => setFProductId(e.target.value)}>
              <option value="">선택 안 함</option>
              {saleProducts.filter((p) => p.kind === "pass").map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.totalCount ? ` (${p.totalCount}회)` : ""} · {won(p.price)}
                </option>
              ))}
            </select>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>상품 (선택 시 발급, 수강권과 함께 가능)</div>
            <select className="input-field" value={fGoodsId} onChange={(e) => setFGoodsId(e.target.value)}>
              <option value="">선택 안 함</option>
              {saleProducts.filter((p) => p.kind === "goods").map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.unlimited ? " (무제한)" : p.totalCount ? ` (${p.totalCount}회)` : ""} · {won(p.price)}
                </option>
              ))}
            </select>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>매출 구분</div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {Object.entries(SALE_TYPE_LABEL).map(([k, v]) => (
                <button key={k} className={`filter-chip ${fSaleType === k ? "on" : ""}`} onClick={() => setFSaleType(k)}>{v}</button>
              ))}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>결제 금액 (분할 가능)</div>
            <div className="pay-grid">
              <label className="pay-field"><span>카드</span><input inputMode="numeric" className="input-field" value={fCard} onChange={(e) => setFCard(e.target.value)} placeholder="0" /></label>
              <label className="pay-field"><span>현금</span><input inputMode="numeric" className="input-field" value={fCash} onChange={(e) => setFCash(e.target.value)} placeholder="0" /></label>
              <label className="pay-field"><span>계좌이체</span><input inputMode="numeric" className="input-field" value={fTransfer} onChange={(e) => setFTransfer(e.target.value)} placeholder="0" /></label>
              <label className="pay-field"><span>포인트</span><input inputMode="numeric" className="input-field" value={fPoint} onChange={(e) => setFPoint(e.target.value)} placeholder="0" /></label>
            </div>
            <div className="pay-total">합계 <b>{won(formTotal)}</b></div>

            <label className="pay-field" style={{ marginTop: 8 }}>
              <span>미수금{autoUnpaidInput && !fUnpaidTouched && fUnpaid ? " (자동계산)" : ""}</span>
              <input
                inputMode="numeric" className="input-field" value={fUnpaid}
                onChange={(e) => { setFUnpaidTouched(true); setFUnpaid(e.target.value); }}
                placeholder="0"
              />
            </label>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>담당 강사 (선택)</div>
            <select className="input-field" value={fTrainer} onChange={(e) => setFTrainer(e.target.value)}>
              <option value="">지정 안 함</option>
              {staff.map((s) => <option key={s.accountId} value={s.accountId}>{s.name}</option>)}
            </select>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>결제일</div>
            <DatePicker value={fPaidAt} onChange={setFPaidAt} label="결제일 선택" />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>메모 (선택)</div>
            <input className="input-field" value={fMemo} onChange={(e) => setFMemo(e.target.value)} placeholder="예: 3개월 할인 적용" />

            {(fProductId || fGoodsId) && !canIssuePass && (
              <div className="perm-guide is-error" style={{ margin: "10px 0 0" }}>
                수강권/상품 발급 권한이 없어요 — 발급 없이 매출만 등록하려면 선택을 해제하세요.
              </div>
            )}
            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setSheet(false)}>취소</button>
              <button className="outline-action" disabled={busy || ((!!fProductId || !!fGoodsId) && !canIssuePass)} onClick={handleRegister}>
                {busy ? "등록 중..." : "등록"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 지출 등록 시트 */}
      {expSheet && (
        <div className="sheet-overlay" onClick={() => setExpSheet(false)}>
          <div className="sheet sales-export-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">지출 등록</div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>항목</div>
            <div className="mem-filters" style={{ padding: 0 }}>
              {EXPENSE_CATEGORIES.map((c) => (
                <button key={c} className={`filter-chip ${eCategory === c ? "on" : ""}`} onClick={() => setECategory(c)}>{c}</button>
              ))}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>금액</div>
            <input inputMode="numeric" className="input-field" value={eAmount} onChange={(e) => setEAmount(e.target.value)} placeholder="0" />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>지출일</div>
            <DatePicker value={eDate} onChange={setEDate} label="지출일 선택" />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>메모 (선택)</div>
            <input className="input-field" value={eMemo} onChange={(e) => setEMemo(e.target.value)} placeholder="예: 7월 임대료" />

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setExpSheet(false)}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleRegisterExpense}>{busy ? "등록 중..." : "등록"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 엑셀 내보내기 시트 */}
      {csvSheet && (
        <div className="sheet-overlay" onClick={() => setCsvSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">매출 엑셀 내보내기</div>
            <div className="menu-section-label" style={{ padding: "4px 0 8px" }}>내보낼 항목을 선택하세요 ({from} ~ {to})</div>
            <div className="csv-cols">
              {SALES_CSV_COLUMNS.map((c) => (
                <label key={c.key} className="csv-col">
                  <input type="checkbox" checked={csvCols.includes(c.key)}
                    onChange={(e) => setCsvCols((prev) => e.target.checked ? [...prev, c.key] : prev.filter((k) => k !== c.key))} />
                  {c.label}
                </label>
              ))}
            </div>
            <div className="add-profile-actions">
              <button className="ghost-btn" onClick={() => setCsvSheet(false)}>취소</button>
              <button className="outline-action" onClick={handleSalesCsvDownload}>{rows.length}건 내보내기</button>
            </div>
          </div>
        </div>
      )}

      {/* 결제 상세 시트 */}
      {payDetail && (
        <div className="sheet-overlay" onClick={() => setPayDetail(null)}>
          <div className="sheet payment-detail-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">결제 상세</div>
            <div className="admin-row"><span className="k">회원</span><span className="v">{payDetail.profileName}</span></div>
            <div className="admin-row"><span className="k">구분</span><span className="v">{SALE_TYPE_LABEL[payDetail.saleType] ?? payDetail.saleType}</span></div>
            <div className="admin-row"><span className="k">상품/수강권</span><span className="v">{payDetail.productName ?? "없음 (매출만)"}</span></div>
            <div className="admin-row"><span className="k">결제일</span><span className="v">{payDetail.paidAtFull ?? payDetail.paidAt}</span></div>
            {payDetail.trainerName && <div className="admin-row"><span className="k">담당</span><span className="v">{payDetail.trainerName}</span></div>}
            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>결제 수단</div>
            {payDetail.cardAmount !== 0 && <div className="admin-row"><span className="k">카드</span><span className="v">{won(payDetail.cardAmount)}</span></div>}
            {payDetail.cashAmount !== 0 && <div className="admin-row"><span className="k">현금</span><span className="v">{won(payDetail.cashAmount)}</span></div>}
            {payDetail.transferAmount !== 0 && <div className="admin-row"><span className="k">계좌이체</span><span className="v">{won(payDetail.transferAmount)}</span></div>}
            {payDetail.pointAmount !== 0 && <div className="admin-row"><span className="k">포인트</span><span className="v">{won(payDetail.pointAmount)}</span></div>}
            <div className="admin-row"><span className="k">합계</span><span className="v" style={{ fontWeight: 800 }}>{won(payDetail.totalAmount)}</span></div>
            {payDetail.unpaidAmount > 0 && <div className="admin-row"><span className="k">미수금</span><span className="v is-error-text">{won(payDetail.unpaidAmount)}</span></div>}
            {payDetail.memo && <><div className="menu-section-label" style={{ padding: "12px 0 6px" }}>메모</div><div className="perm-guide" style={{ margin: 0 }}>{payDetail.memo}</div></>}
            <div className="add-profile-actions" style={{ marginTop: 12 }}>
                <button className="outline-action" onClick={() => setPayDetail(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* 매출 드릴다운 시트 */}
      {drill && (() => {
        const filtered = rows.filter((r) => {
          if (drill.kind === "method") {
            if (drill.key === "card") return r.cardAmount !== 0;
            if (drill.key === "cash") return r.cashAmount !== 0;
            if (drill.key === "transfer") return r.transferAmount !== 0;
            if (drill.key === "point") return r.pointAmount !== 0;
            if (drill.key === "direct") return (r.directAmount ?? 0) !== 0;
          }
          if (drill.kind === "saleType") return r.saleType === drill.key;
          if (drill.kind === "member") return r.profileName === drill.key;
          return false;
        });
        const methodAmount = (r: PaymentRow) =>
          drill.kind === "method"
            ? (drill.key === "card" ? r.cardAmount : drill.key === "cash" ? r.cashAmount : drill.key === "transfer" ? r.transferAmount : drill.key === "direct" ? (r.directAmount ?? 0) : r.pointAmount)
            : r.totalAmount;
        const sum = filtered.reduce((s, r) => s + methodAmount(r), 0);
        return (
          <div className="sheet-overlay" onClick={() => setDrill(null)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-title">{drill.label} 내역</div>
              <div className="hist-summary" style={{ padding: "0 0 8px" }}>
                {from} ~ {to} · {filtered.length}건 · 합계 {won(sum)}
              </div>
              <div className="mem-detail-list">
                {filtered.length === 0 ? (
                  <div className="daylist-empty" style={{ padding: 16 }}>내역이 없어요</div>
                ) : (
                  filtered.map((r) => (
                    <div key={r.id} className="mem-detail-row">
                      <span className="mem-detail-date">{r.paidAt.slice(5)}</span>
                      <span className="mem-detail-main">
                        {drill.kind === "member" ? (SALE_TYPE_LABEL[r.saleType] ?? r.saleType) : r.profileName}
                        {r.unpaidAmount > 0 && <span className="drill-unpaid"> 미수 {won(r.unpaidAmount)}</span>}
                      </span>
                      <span className={`mem-detail-amt ${methodAmount(r) < 0 ? "minus" : ""}`}>{won(methodAmount(r))}</span>
                    </div>
                  ))
                )}
              </div>
              <div className="add-profile-actions" style={{ marginTop: 6 }}>
                <button className="ghost-btn" onClick={() => setDrill(null)}>닫기</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 포인트 등록 시트 */}
      {ptSheet && (
        <div className="sheet-overlay" onClick={() => setPtSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">포인트 {ptSign === "earn" ? "적립" : "사용"}</div>

            <div className="mem-filters" style={{ padding: "4px 0 8px" }}>
              <button className={`filter-chip ${ptSign === "earn" ? "on" : ""}`} onClick={() => setPtSign("earn")}>적립 (+)</button>
              <button className={`filter-chip ${ptSign === "use" ? "on" : ""}`} onClick={() => setPtSign("use")}>사용 (−)</button>
            </div>

            <div className="menu-section-label" style={{ padding: "8px 0 6px" }}>회원</div>
            <select className="input-field" value={ptProfile} onChange={(e) => setPtProfile(e.target.value)}>
              {members.length === 0 && <option value="">등록된 회원이 없어요</option>}
              {members.map((m) => <option key={m.profileId} value={m.profileId}>{m.name}</option>)}
            </select>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>포인트</div>
            <input inputMode="numeric" className="input-field" value={ptAmount} onChange={(e) => setPtAmount(e.target.value)} placeholder="0" />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>사유 (선택)</div>
            <input className="input-field" value={ptReason} onChange={(e) => setPtReason(e.target.value)} placeholder="예: 재등록 적립" />

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setPtSheet(false)}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleRegisterPoint}>{busy ? "등록 중..." : "등록"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
