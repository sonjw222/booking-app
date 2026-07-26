"use client";

/*
  매니저 - 주문 관리
  - 회원이 앱에서 구매한 수강권/상품 주문 확인
  - 확인(발급 완료) 또는 취소 처리
  - 결제 연동 전이므로 주문은 pending으로 들어옴 → 매니저가 확인 후 발급
*/

import { useCallback, useEffect, useState } from "react";
import ManagerNav from "../../components/ManagerNav";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchCenterOrders, updateOrderStatus, type Order } from "../../../lib/orders";
import Loading from "../../components/Loading";

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

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try { setOrders(await fetchCenterOrders(centerId)); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);
  useEffect(() => { load(); }, [load]);

  async function handleDone(o: OrderRow) {
    if (!confirm(`${o.memberName}님에게 '${o.productName}'을(를) 발급하고 매출에 반영할까요?`)) return;
    setBusy(true);
    try {
      const r = await updateOrderStatus(o.id, "done");
      if (r && r.autoBooked > 0) {
        showToast(
          r.remaining > 0
            ? `발급 완료 · ${r.autoBooked}개 수업 자동예약 (${r.remaining}회는 자리가 없어 미배치)`
            : `발급 완료 · ${r.autoBooked}개 수업에 자동예약했어요`
        );
      } else {
        showToast("수강권을 발급하고 매출에 반영했어요");
      }
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleCancel(o: OrderRow) {
    if (!confirm(`${o.memberName}님의 '${o.productName}' 주문을 취소할까요?`)) return;
    setBusy(true);
    try {
      await updateOrderStatus(o.id, "cancelled");
      await load();
    } catch (e: any) { setError(e.message); }
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
        <a className="side" href="/manager">‹</a>
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
                </div>
                <div className="order-meta">{won(o.amount)} · {o.payMethod ?? "미지정"} · {fmt(o.createdAt)}</div>
              </div>
              {(o.status === "pending" || o.status === "paid") && (
                <div className="order-actions">
                  <button className="order-done-btn" disabled={busy} onClick={() => handleDone(o)}>확정 · 발급</button>
                  <button className="order-cancel-btn" disabled={busy} onClick={() => handleCancel(o)}>취소</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ height: 40 }} />
      <ManagerNav />
    </div>
  );
}
