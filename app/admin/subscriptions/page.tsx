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
  adminReactivateCenterSubscription, adminSetCenterAlimtalkAddon, STATUS_LABEL,
  type AdminCenterSubscription, type SubscriptionStatus,
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
  const [addonPriceInput, setAddonPriceInput] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");

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

  async function handleEnableAlimtalkAddon(row: AdminCenterSubscription) {
    const raw = addonPriceInput[row.centerId] ?? String(row.alimtalkAddonUnitPrice ?? "");
    const price = Number(raw);
    if (!raw.trim() || !Number.isFinite(price) || price < 0) {
      setError("건당 요금을 숫자로 입력해주세요");
      return;
    }
    const ok = await globalThis.appConfirm(`'${row.centerName}'에 알림톡 애드온을 건당 ${price.toLocaleString()}원으로 켤까요?`);
    if (!ok) return;
    setBusyId(row.centerId); setError(null);
    try {
      await adminSetCenterAlimtalkAddon(row.centerId, true, price);
      showToast("알림톡 애드온을 켰어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusyId(null); }
  }

  async function handleDisableAlimtalkAddon(row: AdminCenterSubscription) {
    const ok = await globalThis.appConfirm(`'${row.centerName}'의 알림톡 애드온을 끌까요? 이후 이 센터의 알림톡/SMS 발송이 전부 막혀요.`);
    if (!ok) return;
    setBusyId(row.centerId); setError(null);
    try {
      await adminSetCenterAlimtalkAddon(row.centerId, false);
      showToast("알림톡 애드온을 껐어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusyId(null); }
  }

  async function handleReactivate(row: AdminCenterSubscription) {
    const ok = await globalThis.appConfirm(`'${row.centerName}'의 취소된 구독을 재개할까요?`);
    if (!ok) return;
    setBusyId(row.centerId); setError(null);
    try {
      await adminReactivateCenterSubscription(row.centerId);
      showToast("구독을 재개했어요");
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

      <div style={{ padding: "12px 20px" }}>
        <input
          className="input-field"
          placeholder="센터 이름으로 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>구독 정보가 있는 센터가 없어요</div>
      ) : (
        <div className="admin-list">
          {rows
            .filter((r) => r.centerName.toLowerCase().includes(search.trim().toLowerCase()))
            .map((r) => (
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

              <div className="admin-row"><span className="k" style={{ flex: "0 0 92px" }}>알림톡 애드온</span><span className="v">
                {r.alimtalkAddon ? `사용 중 · 건당 ${(r.alimtalkAddonUnitPrice ?? 0).toLocaleString()}원` : "미신청"}
              </span></div>
              {r.alimtalkAddon ? (
                <button className="profile-del admin-action-btn" disabled={busyId === r.centerId} onClick={() => handleDisableAlimtalkAddon(r)}>
                  알림톡 애드온 끄기
                </button>
              ) : (
                <div className="admin-row">
                  <input
                    className="input-field" type="number" min={0} style={{ flex: 1, minWidth: 0, minHeight: 40 }}
                    placeholder="건당 요금(원)" disabled={busyId === r.centerId}
                    value={addonPriceInput[r.centerId] ?? ""}
                    onChange={(e) => setAddonPriceInput((prev) => ({ ...prev, [r.centerId]: e.target.value }))}
                  />
                  <button className="profile-del" style={{ flex: "0 0 auto" }} disabled={busyId === r.centerId} onClick={() => handleEnableAlimtalkAddon(r)}>
                    알림톡 애드온 켜기
                  </button>
                </div>
              )}

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

              {r.status === "canceled" ? (
                <button className="profile-del admin-action-btn" disabled={busyId === r.centerId} onClick={() => handleReactivate(r)}>
                  구독 재개
                </button>
              ) : (
                <button className="profile-del admin-action-btn" disabled={busyId === r.centerId} onClick={() => handleCancel(r)}>
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
