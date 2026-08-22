"use client";

/*
  구매 내역 (마이페이지)
  - 내가 구매한 수강권·상품 전체
  - 환불 가능한 건 환불 버튼 표시 (24시간 이내 · 미사용)
  - 아직 발급 안 된(미처리) 주문은 취소 버튼 표시 (P1-2, add_order_self_cancel.sql —
    매니저가 처리하기 전이라 시간 제한 없이 언제든 회원이 직접 취소 가능. 매니저 화면
    (app/manager/orders/page.tsx)과 동일하게 updateOrderStatus()를 그대로 재사용 —
    RLS 정책만 "본인 소유 + 아직 미발급"으로 다르게 좁혀져 있다.)
*/

import { useCallback, useEffect, useState } from "react";
import { fetchMyPurchases, updateOrderStatus, type PurchaseItem } from "../../lib/orders";
import { requestRefund } from "../../lib/mypage";
import Loading from "../components/Loading";
import ConfirmDialog from "../components/ConfirmDialog";
import DatePicker from "../components/DatePicker";

const STATUS_LABEL: Record<string, string> = {
  active: "이용중",
  expired: "만료",
  refunded: "환불됨",
  paused: "정지",
  pending: "확인 대기",
  paid: "결제완료",
  done: "발급완료",
  cancelled: "취소됨",
};

export default function PurchasesPage() {
  const [items, setItems] = useState<PurchaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refundTarget, setRefundTarget] = useState<PurchaseItem | null>(null);
  const [cancelTarget, setCancelTarget] = useState<PurchaseItem | null>(null);
  // 필터
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "pass" | "goods">("all");

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems(await fetchMyPurchases()); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function handleRefund(it: PurchaseItem) {
    setRefundTarget(it);
  }

  async function confirmRefund() {
    const it = refundTarget;
    if (!it?.membershipId) return;
    setBusy(true);
    try {
      await requestRefund(it.membershipId);
      showToast("환불 처리했어요");
      setRefundTarget(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function confirmCancel() {
    const it = cancelTarget;
    if (!it?.orderId) return;
    setBusy(true);
    try {
      await updateOrderStatus(it.orderId, "cancelled");
      showToast("주문을 취소했어요");
      setCancelTarget(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  function won(n: number) { return n.toLocaleString("ko-KR") + "원"; }

  const shown = items.filter((it) => {
    const d = it.createdAtIso.slice(0, 10);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    if (kindFilter !== "all" && (it.kind ?? "pass") !== kindFilter) return false;
    return true;
  });

  return (
    <div className="app-shell purchase-page-v2">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}
      <ConfirmDialog
        open={!!refundTarget}
        title="이 수강권을 환불할까요?"
        description={`${refundTarget?.productName ?? "선택한 상품"}이 사라지고 센터 매출에도 반영돼요. 이 작업은 되돌릴 수 없어요.`}
        confirmLabel="환불하기"
        danger
        busy={busy}
        onCancel={() => setRefundTarget(null)}
        onConfirm={confirmRefund}
      />
      <ConfirmDialog
        open={!!cancelTarget}
        title="이 주문을 취소할까요?"
        description={`${cancelTarget?.productName ?? "선택한 상품"} 주문이 취소돼요. 아직 발급 전이라 결제는 없었던 것으로 처리돼요.`}
        cancelLabel="닫기"
        confirmLabel="주문 취소"
        danger
        busy={busy}
        onCancel={() => setCancelTarget(null)}
        onConfirm={confirmCancel}
      />

      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">구매 내역</div>
        <div className="side" />
      </div>

      {/* 필터 */}
      <div className="mem-filters">
        <button className={`filter-chip ${kindFilter === "all" ? "on" : ""}`} onClick={() => setKindFilter("all")}>전체</button>
        <button className={`filter-chip ${kindFilter === "pass" ? "on" : ""}`} onClick={() => setKindFilter("pass")}>수강권</button>
        <button className={`filter-chip ${kindFilter === "goods" ? "on" : ""}`} onClick={() => setKindFilter("goods")}>상품</button>
      </div>
      <div className="purchase-daterange">
        <DatePicker value={fromDate} onChange={setFromDate} label="조회 시작일" />
        <span className="time-sep">~</span>
        <DatePicker value={toDate} onChange={setToDate} label="조회 종료일" />
        {(fromDate || toDate) && (
          <button className="text-btn" onClick={() => { setFromDate(""); setToDate(""); }}>초기화</button>
        )}
      </div>

      {loading ? <Loading /> : shown.length === 0 ? (
        <div className="daylist-empty" style={{ padding: "60px 20px" }}>
          {items.length === 0 ? "구매 내역이 없어요" : "조건에 맞는 내역이 없어요"}
        </div>
      ) : (
        <div className="purchase-list">
          {shown.map((it) => (
            <div key={it.id} className="purchase-item">
              <div className="purchase-kind-mark">{it.kind === "goods" ? "G" : "P"}</div>
              <div className="purchase-content">
              <div className="purchase-head">
                <span className="purchase-center">{it.centerName}</span>
                <span className={`purchase-status s-${it.status}`}>{STATUS_LABEL[it.status] ?? it.status}</span>
              </div>
              <div className="purchase-name">{it.productName}</div>
              <div className="purchase-meta">
                {it.amount > 0 && <>{won(it.amount)} · </>}
                {it.purchasedAt}
                {it.totalCount != null && (
                  <> · {it.remainingCount ?? 0}/{it.totalCount}회 남음</>
                )}
              </div>

              {it.status !== "refunded" && (
                <div className="purchase-refund">
                  {it.cancellable ? (
                    <button className="purchase-refund-btn" disabled={busy} onClick={() => setCancelTarget(it)}>
                      주문 취소하기
                    </button>
                  ) : it.refundable ? (
                    <button className="purchase-refund-btn" disabled={busy} onClick={() => handleRefund(it)}>
                      환불하기
                    </button>
                  ) : (
                    <span className="purchase-refund-note">{it.refundReason}</span>
                  )}
                </div>
              )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ height: 20 }} />
    </div>
  );
}
