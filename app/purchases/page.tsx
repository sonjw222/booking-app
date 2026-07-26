"use client";

/*
  구매 내역 (마이페이지)
  - 내가 구매한 수강권·상품 전체
  - 환불 가능한 건 환불 버튼 표시 (24시간 이내 · 미사용)
*/

import { useCallback, useEffect, useState } from "react";
import { fetchMyPurchases, type PurchaseItem } from "../../lib/orders";
import { requestRefund } from "../../lib/mypage";
import Loading from "../components/Loading";
import BottomNav from "../components/BottomNav";

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

  async function handleRefund(it: PurchaseItem) {
    if (!it.membershipId) {
      setError("아직 발급되지 않은 주문이라 앱에서 환불할 수 없어요. 센터에 문의해주세요.");
      return;
    }
    if (!confirm(`'${it.productName}'을(를) 환불할까요?\n\n· 수강권이 사라지고 센터 매출에도 반영돼요\n· 되돌릴 수 없어요`)) return;
    setBusy(true);
    try {
      await requestRefund(it.membershipId);
      showToast("환불 처리했어요");
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
    <div className="app-shell">
      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

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
        <input className="input-field" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <span className="time-sep">~</span>
        <input className="input-field" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
                  {it.refundable ? (
                    <button className="purchase-refund-btn" disabled={busy} onClick={() => handleRefund(it)}>
                      환불하기
                    </button>
                  ) : (
                    <span className="purchase-refund-note">{it.refundReason}</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ height: 20 }} />
      <BottomNav />
    </div>
  );
}
