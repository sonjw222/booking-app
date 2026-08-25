"use client";

/*
  플랫폼 운영자 - 센터별 플랫폼 구독 현황
  - 전체 센터가 어떤 플랜인지, 카드 등록/결제 상태가 어떤지 목록으로 확인
  - 플랜 변경 / 구독 취소 액션 포함(add_admin_center_subscription_actions.sql RPC 경유,
    사용자 QA 피드백으로 추가 — 원래는 조회 전용이었음)
  - is_platform_admin = true 인 계정만 접근 가능
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import { checkPlatformAdmin } from "../../../lib/admin";
import {
  fetchAllCenterSubscriptions, adminSetCenterSubscriptionPlan, adminCancelCenterSubscription,
  STATUS_LABEL, type AdminCenterSubscription, type SubscriptionStatus,
} from "../../../lib/centerSubscription";
import { fetchSubscriptionPlans, type SubscriptionPlan } from "../../../lib/operator";

const STATUS_BADGE: Record<SubscriptionStatus, string> = {
  pending_billing_setup: "s-waitlisted",
  active: "s-attended",
  past_due: "s-cancelled",
  canceled: "s-cancelled",
};

export default function AdminSubscriptionsPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [rows, setRows] = useState<AdminCenterSubscription[]>([]);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

  const load = useCallback(async () => {
    try {
      const [subs, planList] = await Promise.all([fetchAllCenterSubscriptions(), fetchSubscriptionPlans()]);
      setRows(subs);
      setPlans(planList);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      if (!admin) { setLoading(false); return; }
      await load();
      setLoading(false);
    })();
  }, [load]);

  async function handleChangePlan(row: AdminCenterSubscription, planId: string) {
    if (!planId || planId === row.planId) return;
    setBusyId(row.centerId); setError(null);
    try {
      await adminSetCenterSubscriptionPlan(row.centerId, planId);
      showToast("플랜을 변경했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusyId(null); }
  }

  async function handleCancel(row: AdminCenterSubscription) {
    const ok = await globalThis.appConfirm(`'${row.centerName}'의 플랫폼 구독을 취소할까요?`);
    if (!ok) return;
    setBusyId(row.centerId); setError(null);
    try {
      await adminCancelCenterSubscription(row.centerId);
      showToast("구독을 취소했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusyId(null); }
  }

  if (isAdmin === false) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/">‹</a>
          <div className="title">구독 현황</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>
          플랫폼 운영자만 접근할 수 있는 화면이에요
        </div>
      </div>
    );
  }

  if (isAdmin === null || loading) {
    return (
      <div className="app-shell">
        <Loading />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="mgr-mode-bar">
        <span className="mgr-mode-label"><UiIcon name="shield" size={15} /> 플랫폼 운영자</span>
        <a className="mgr-mode-switch" href="/">회원 모드로 ↩</a>
      </div>

      <div className="back-header">
        <a className="side" href="/admin">‹</a>
        <div className="title">구독 현황</div>
        <div className="side" />
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}
      {toast && <div className="toast">{toast}</div>}

      {rows.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>구독 정보가 있는 센터가 없어요</div>
      ) : (
        <div className="admin-list">
          {rows.map((r) => (
            <div key={r.id} className="admin-card">
              <div className="admin-card-head">
                <div className="admin-center-name">{r.centerName}</div>
                <span className={`hist-status ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              </div>

              <div className="admin-row"><span className="k">플랜</span><span className="v">
                {r.planName}{r.monthlyPrice > 0 ? ` (월 ${r.monthlyPrice.toLocaleString()}원)` : " (가격 미정)"}
              </span></div>
              {r.status === "active" && r.nextBillingDate && (
                <div className="admin-row"><span className="k">다음 결제일</span><span className="v">{r.nextBillingDate}</span></div>
              )}
              <div className="admin-row"><span className="k">등록된 카드</span><span className="v">
                {r.cardLast4 ? `${r.cardCompany ?? ""} ${r.cardLast4}****` : "미등록"}
              </span></div>

              <div className="admin-row">
                <span className="k">플랜 변경</span>
                <select
                  className="input-field" style={{ width: "auto" }}
                  value="" disabled={busyId === r.centerId}
                  onChange={(e) => handleChangePlan(r, e.target.value)}
                >
                  <option value="">플랜 선택...</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id} disabled={p.id === r.planId}>
                      {p.name}{p.id === r.planId ? " (현재)" : ""}{!p.isActive ? " (비활성)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              {r.status !== "canceled" && (
                <button className="profile-del" style={{ marginTop: 6 }} disabled={busyId === r.centerId} onClick={() => handleCancel(r)}>
                  구독 취소
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
