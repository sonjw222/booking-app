"use client";

/*
  매니저 - 주문 관리
  - 회원이 앱에서 구매한 수강권/상품 주문 확인
  - 확인(발급 완료) 또는 취소 처리
  - 결제 연동 전이므로 주문은 pending으로 들어옴 → 매니저가 확인 후 발급
*/

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchCenterOrders, updateOrderStatus, fulfillResultMessage, type Order,
  fetchCenterProductExpiryMap, fetchExpiredOrderResolutions, resolveExpiredOrder, expiredOrderUiState, RECEIVED_METHOD_LABEL,
  type ExpiredOrderResolution, type ExpiredOrderAction,
} from "../../../lib/orders";
import { kstToday } from "../../../lib/servicePeriod";
import SheetOverlay from "../../components/SheetOverlay";
import Loading from "../../components/Loading";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";

type OrderRow = Order & { memberName: string; memberPhone: string | null };

const STATUS_LABEL: Record<string, string> = {
  pending: "확인 대기", paid: "결제완료", done: "처리 완료", cancelled: "취소됨",
};

export default function ManagerOrdersPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [filter, setFilter] = useState<"all" | "pending" | "done">("pending");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
  // 만료 상품 기존 pending 주문 처리(add_expired_order_resolution_20261031.sql)
  const [expiryByProduct, setExpiryByProduct] = useState<Record<string, { expiryMode: string | null; expiryDate: string | null }>>({});
  const [resolutions, setResolutions] = useState<Record<string, ExpiredOrderResolution>>({});
  const [resolutionsReady, setResolutionsReady] = useState(true);
  const [resolveFor, setResolveFor] = useState<OrderRow | null>(null);
  const [rStep, setRStep] = useState<"choose" | "paid">("choose");
  const [rMode, setRMode] = useState<"refund_plan" | "adjust_period">("adjust_period");
  const [rReason, setRReason] = useState("");
  const [rAmount, setRAmount] = useState("");
  const [rDate, setRDate] = useState("");
  const [rMethod, setRMethod] = useState("cash");
  const [rNewExpiry, setRNewExpiry] = useState("");
  const [rRefundDate, setRRefundDate] = useState("");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

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

  // fulfill_order() RPC가 실제로 요구하는 키는 카탈로그의 pass.order.fulfill이 아니라
  // pass.payment.create다(라이브 정의로 확인, SEC-116) — 결제 등록 권한과 같은 계층으로 취급.
  const canFulfillOrder = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "pass.payment.create");

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      setOrders(await fetchCenterOrders(centerId));
      // 만료 상품 주문 표시용 보조 정보(읽기 전용). 실패해도 일반 주문 목록은 그대로 보여준다.
      try { setExpiryByProduct(await fetchCenterProductExpiryMap(centerId)); } catch { setExpiryByProduct({}); }
      try { const r = await fetchExpiredOrderResolutions(centerId); setResolutions(r.byOrder); setResolutionsReady(r.serverReady); } catch { setResolutions({}); }
    }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);
  useEffect(() => { load(); }, [load]);

  async function handleDone(o: OrderRow) {
    if (!(await globalThis.appConfirm(`${o.memberName}님에게 '${o.productName}'을(를) 발급하고 매출에 반영할까요?`))) return;
    setBusy(true);
    try {
      const result = await updateOrderStatus(o.id, "done");
      // 자동예약 결과(예약 수/미배치 수/사유/오류)를 그대로 보여준다 — 실패 이유가 조용히 묻히지 않게.
      showToast(fulfillResultMessage(result));
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleCancel(o: OrderRow) {
    if (!(await globalThis.appConfirm(`${o.memberName}님의 '${o.productName}' 주문을 취소할까요?`))) return;
    setBusy(true);
    try {
      await updateOrderStatus(o.id, "cancelled");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const expState = (o: OrderRow) => expiredOrderUiState(o, expiryByProduct, resolutions[o.id]);
  function openResolve(o: OrderRow) {
    setResolveFor(o); setRStep("choose"); setRMode("adjust_period"); setRReason(""); setRAmount(String(o.amount));
    setRDate(kstToday()); setRMethod("cash"); setRNewExpiry(""); setRRefundDate(kstToday());
  }
  function closeResolve() { setResolveFor(null); }
  async function runResolve(action: ExpiredOrderAction) {
    if (!resolveFor) return;
    const o = resolveFor;
    const labels: Record<ExpiredOrderAction, string> = {
      unpaid_cancel: `실제로 수납되지 않은 것을 확인했어요. ${o.memberName}님의 '${o.productName}' 주문을 취소할까요? (수강권·매출은 생기지 않아요)`,
      refund_plan: `수납(${RECEIVED_METHOD_LABEL[rMethod]} ${Number(rAmount).toLocaleString("ko-KR")}원)을 확인했어요. 환불 예정으로 기록할까요? (환불은 센터에서 직접 하고, 완료 후 '환불 완료 확인'을 눌러야 주문이 정리돼요)`,
      refund_complete: `실제 환불을 마쳤어요. 이 주문을 환불 완료로 정리(취소)할까요?`,
      adjust_period: `수납(${RECEIVED_METHOD_LABEL[rMethod]} ${Number(rAmount).toLocaleString("ko-KR")}원)을 확인했어요. 새 만료일 ${rNewExpiry}로 수강권을 발급하고 매출에 반영할까요? (상품의 만료일은 바뀌지 않아요)`,
    };
    if (!(await globalThis.appConfirm(labels[action]))) return;
    setBusy(true);
    try {
      await resolveExpiredOrder({
        orderId: o.id, action, reason: rReason,
        receivedAmount: action === "refund_plan" || action === "adjust_period" ? Number(rAmount) : undefined,
        receivedAt: action === "refund_plan" || action === "adjust_period" ? rDate : undefined,
        receivedMethod: action === "refund_plan" || action === "adjust_period" ? rMethod : undefined,
        newExpiresOn: action === "adjust_period" ? rNewExpiry : undefined,
        refundedAt: action === "refund_complete" ? rRefundDate : undefined,
      });
      showToast(action === "adjust_period" ? "수납 확인 후 이용기간을 조정해 발급했어요" : action === "refund_plan" ? "환불 예정으로 기록했어요" : action === "refund_complete" ? "환불 완료로 정리했어요" : "주문을 취소했어요");
      closeResolve(); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const shown = orders.filter((o) => {
    if (filter === "pending") return o.status === "pending" || o.status === "paid";
    if (filter === "done") return o.status === "done";
    return true;
  });
  const pendingCount = orders.filter((o) => o.status === "pending" || o.status === "paid").length;

  function won(n: number) { return n.toLocaleString("ko-KR") + "원"; }
  function fmt(iso: string) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  return (
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <Link className="side" href="/manager" prefetch={false}>‹</Link>
        <div className="title">주문 관리</div>
        <div className="side" />
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>{c.name}</button>
          ))}
        </div>
      )}

      <div className="mem-filters">
        <button className={`filter-chip ${filter === "pending" ? "on" : ""}`} onClick={() => setFilter("pending")}>
          확인 대기 {pendingCount > 0 ? `(${pendingCount})` : ""}
        </button>
        <button className={`filter-chip ${filter === "done" ? "on" : ""}`} onClick={() => setFilter("done")}>처리 완료</button>
        <button className={`filter-chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>전체</button>
      </div>

      {loading ? <Loading /> : shown.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>
          {filter === "pending" ? "확인할 주문이 없어요" : "주문 내역이 없어요"}
        </div>
      ) : (
        <div className="order-list">
          {shown.map((o) => (
            <div key={o.id} className="order-row">
              <div className="order-main">
                <div className="order-name">
                  {o.memberName}
                  {o.memberPhone && <span className="order-phone">{o.memberPhone}</span>}
                  <span className={`order-status ${o.status}`}>{STATUS_LABEL[o.status]}</span>
                </div>
                <div className="order-product">
                  <span className={`product-kind-tag ${o.productId ? "pass" : "pass"}`}></span>{o.productName}
                  {/* 구매 횟수 선택형 상품/사이즈 상품은 선택 내용(횟수·사이즈)을 함께 보여준다 */}
                  {o.selectedCount != null && <span className="order-selection"> · {o.selectedCount}회</span>}
                  {o.selectedSize && <span className="order-selection"> · {o.selectedSize}</span>}
                </div>
                <div className="order-meta">{won(o.amount)} · {o.payMethod ?? "미지정"} · {fmt(o.createdAt)}</div>
              </div>
              {expState(o) === "needs_confirmation" && (
                <div className="perm-guide" data-testid="expired-order-notice" style={{ margin: "8px 0 0" }}>
                  판매 기간이 지난 상품의 주문이에요(만료일 {expiryByProduct[o.productId ?? ""]?.expiryDate}). 실제로 수납됐는지 확인하기 전에는 발급하지 않아요.
                </div>
              )}
              {expState(o) === "refund_planned" && resolutions[o.id] && (
                <div className="perm-guide" data-testid="expired-order-refund-planned" style={{ margin: "8px 0 0" }}>
                  <strong>환불 예정</strong> · 수납 {resolutions[o.id].receivedAmount?.toLocaleString("ko-KR")}원({RECEIVED_METHOD_LABEL[resolutions[o.id].receivedMethod ?? "other"]}, {resolutions[o.id].receivedAt}) · 사유: {resolutions[o.id].reason}. 센터에서 환불을 마친 뒤 ‘환불 완료 확인’을 눌러 주세요.
                </div>
              )}
              {(o.status === "pending" || o.status === "paid") && canFulfillOrder && expState(o) === "normal" && (
                <div className="order-actions">
                  <button className="order-done-btn" disabled={busy} onClick={() => handleDone(o)}>확정 · 발급</button>
                  <button className="order-cancel-btn" disabled={busy} onClick={() => handleCancel(o)}>취소</button>
                </div>
              )}
              {(o.status === "pending" || o.status === "paid") && canFulfillOrder && expState(o) !== "normal" && (
                <div className="order-actions">
                  <button className="order-done-btn" disabled={busy} data-testid="expired-order-resolve-btn" onClick={() => openResolve(o)}>
                    {expState(o) === "refund_planned" ? "환불 완료 확인" : "만료 상품 주문 처리"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ height: 40 }} />
      {resolveFor && (
        <SheetOverlay className="sheet-overlay" onClick={() => !busy && closeResolve()}>
          <div className="sheet" role="dialog" aria-label="만료 상품 주문 처리" data-testid="expired-order-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">만료 상품 주문 처리</div>
            <div className="perm-guide" style={{ margin: "0 0 10px" }}>
              {resolveFor.memberName}님의 ‘{resolveFor.productName}’ {won(resolveFor.amount)} 주문이에요. 상품 판매 기간이 지나 그대로 발급하면 처음부터 만료된 수강권이 돼요. 실제 수납 여부를 먼저 확인해 주세요.
            </div>
            {!resolutionsReady && <div className="perm-guide is-error" style={{ margin: "0 0 10px" }}>서버 업데이트(만료 상품 주문 처리 기능)가 아직 적용되지 않아 처리할 수 없어요. 주문은 대기 상태로 남아 있어요.</div>}

            {expState(resolveFor) === "refund_planned" ? (
              <>
                <div className="menu-section-label" style={{ padding: "6px 0" }}>환불 완료 확인</div>
                <div className="perm-guide" style={{ margin: "0 0 10px" }}>센터에서 실제 환불을 마쳤을 때만 누르세요. 환불이 끝나지 않았다면 닫고 나중에 다시 확인해 주세요.</div>
                <label className="menu-section-label" htmlFor="r-refund-date">환불일</label>
                <input id="r-refund-date" className="input-field" type="date" value={rRefundDate} max={kstToday()} onChange={(e) => setRRefundDate(e.target.value)} />
                <label className="menu-section-label" htmlFor="r-reason" style={{ paddingTop: 10 }}>환불 내용(환불 수단·계좌 등 메모)</label>
                <textarea id="r-reason" className="input-field" rows={3} value={rReason} onChange={(e) => setRReason(e.target.value)} placeholder="예: 계좌이체로 전액 환불 완료" />
                <div className="add-profile-actions" style={{ marginTop: 14 }}>
                  <button className="ghost-btn" disabled={busy} onClick={closeResolve}>닫기</button>
                  <button className="primary-btn" disabled={busy || !resolutionsReady || rReason.trim().length < 2} onClick={() => runResolve("refund_complete")}>환불 완료 확인</button>
                </div>
              </>
            ) : rStep === "choose" ? (
              <>
                <div className="menu-section-label" style={{ padding: "6px 0" }}>이 주문의 실제 수납 여부는요?</div>
                <label className="menu-section-label" htmlFor="r-reason">처리 사유</label>
                <textarea id="r-reason" className="input-field" rows={2} value={rReason} onChange={(e) => setRReason(e.target.value)} placeholder="예: 회원 확인 결과 입금 내역 없음" />
                <div className="add-profile-actions" style={{ marginTop: 14, flexDirection: "column", gap: 8 }}>
                  <button className="order-cancel-btn" data-testid="expired-unpaid-cancel" disabled={busy || !resolutionsReady || rReason.trim().length < 2} onClick={() => runResolve("unpaid_cancel")}>미수납 확인 → 주문 취소</button>
                  <button className="order-done-btn" data-testid="expired-paid" disabled={busy || !resolutionsReady} onClick={() => setRStep("paid")}>수납 완료 확인(환불 또는 이용기간 조정)</button>
                  <button className="ghost-btn" data-testid="expired-unknown" disabled={busy} onClick={closeResolve}>수납 여부 모름 → 대기 유지(아무것도 바꾸지 않아요)</button>
                </div>
              </>
            ) : (
              <>
                <div className="menu-section-label" style={{ padding: "6px 0" }}>수납 확인</div>
                <label className="menu-section-label" htmlFor="r-amount">수납 금액(원)</label>
                <input id="r-amount" className="input-field" inputMode="numeric" value={rAmount} onChange={(e) => setRAmount(e.target.value.replace(/[^0-9]/g, ""))} />
                <label className="menu-section-label" htmlFor="r-date" style={{ paddingTop: 10 }}>수납일</label>
                <input id="r-date" className="input-field" type="date" value={rDate} max={kstToday()} onChange={(e) => setRDate(e.target.value)} />
                <label className="menu-section-label" htmlFor="r-method" style={{ paddingTop: 10 }}>수납 수단</label>
                <select id="r-method" className="input-field" value={rMethod} onChange={(e) => setRMethod(e.target.value)}>
                  {Object.entries(RECEIVED_METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>처리 방식</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className={`filter-chip ${rMode === "adjust_period" ? "on" : ""}`} aria-pressed={rMode === "adjust_period"} onClick={() => setRMode("adjust_period")}>이용기간 조정 후 발급</button>
                  <button className={`filter-chip ${rMode === "refund_plan" ? "on" : ""}`} aria-pressed={rMode === "refund_plan"} onClick={() => setRMode("refund_plan")}>환불</button>
                </div>
                {rMode === "adjust_period" ? (
                  <>
                    <label className="menu-section-label" htmlFor="r-expiry" style={{ paddingTop: 10 }}>새 만료일(오늘 이후)</label>
                    <input id="r-expiry" className="input-field" type="date" value={rNewExpiry} min={kstToday()} onChange={(e) => setRNewExpiry(e.target.value)} />
                    <div className="perm-guide" style={{ margin: "6px 0 0" }}>이 주문의 수강권 1건에만 적용돼요. 상품의 만료일은 바뀌지 않아요.</div>
                  </>
                ) : (
                  <div className="perm-guide" style={{ margin: "10px 0 0" }}>환불은 센터에서 직접 해 주세요(현금·계좌이체 등). 여기서는 ‘환불 예정’으로만 기록하고, 환불을 마친 뒤 ‘환불 완료 확인’을 눌러야 주문이 정리돼요. 그때까지 수강권·매출은 생기지 않아요.</div>
                )}
                <label className="menu-section-label" htmlFor="r-reason2" style={{ paddingTop: 10 }}>처리 사유</label>
                <textarea id="r-reason2" className="input-field" rows={2} value={rReason} onChange={(e) => setRReason(e.target.value)} placeholder={rMode === "adjust_period" ? "예: 만료 전 입금 확인, 회원과 합의해 이용기간 조정" : "예: 회원 요청으로 환불"} />
                <div className="add-profile-actions" style={{ marginTop: 14 }}>
                  <button className="ghost-btn" disabled={busy} onClick={() => setRStep("choose")}>뒤로</button>
                  <button className="primary-btn" data-testid="expired-paid-submit" disabled={busy || !resolutionsReady || rReason.trim().length < 2 || !rAmount || !rDate || (rMode === "adjust_period" && !rNewExpiry)}
                    onClick={() => runResolve(rMode)}>{rMode === "adjust_period" ? "발급하고 매출 반영" : "환불 예정으로 기록"}</button>
                </div>
              </>
            )}
          </div>
        </SheetOverlay>
      )}
    </div>
  );
}
