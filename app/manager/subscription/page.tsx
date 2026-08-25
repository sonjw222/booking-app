"use client";

/*
  매니저 - 플랫폼 구독 (센터 → 우리에게 내는 월 구독료)
  - 원래 app/manager/settings(운영 설정) 안의 한 섹션이었는데, 회원/예약 운영 설정과
    성격이 완전히 다른 축(우리 쪽 매출/계약)이라 사용자 요청으로 별도 메뉴로 분리함.
  - 오너 또는 운영정보 설정 권한(facility.operation) 필요 — 기존 운영 설정과 동일한
    권한 키를 재사용(원래 그 페이지의 일부였으므로 접근 범위를 그대로 유지).
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";
import {
  fetchCenterSubscription, requestCenterBillingAuth, BILLING_ENABLED, STATUS_LABEL,
  type CenterSubscription,
} from "../../../lib/centerSubscription";

export default function ManagerSubscriptionPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myPerms, setMyPerms] = useState<Set<string> | null>(null);

  const [subscription, setSubscription] = useState<CenterSubscription | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);
  const [subBusy, setSubBusy] = useState(false);

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

  const canManage = canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, "facility.operation");

  const loadSubscription = useCallback(async () => {
    if (!centerId) return;
    setSubLoading(true); setSubError(null);
    try {
      setSubscription(await fetchCenterSubscription(centerId));
    } catch (e: any) { setSubError(e.message); }
    finally { setSubLoading(false); setLoading(false); }
  }, [centerId]);

  useEffect(() => { loadSubscription(); }, [loadSubscription]);

  async function handleCardRegister() {
    if (!centerId) return;
    setSubBusy(true); setSubError(null);
    try {
      await requestCenterBillingAuth(centerId);
      // 성공 시 토스 결제창이 successUrl/failUrl로 브라우저를 이동시키므로
      // 여기서는 별도 후처리가 필요 없음(플래그가 꺼진 지금은 이 경로 자체가 실행되지 않음).
    } catch (e: any) {
      setSubError(e.message);
    } finally {
      setSubBusy(false);
    }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">플랫폼 구독</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">플랫폼 구독</div>
        <div className="side" />
      </div>

      {!loading && activeCenter && !canManage && (
        <div className="error-toast">구독 정보를 변경할 권한이 없어요 — 오너에게 문의하세요.</div>
      )}

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => setCenterId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : (
        <div className="settings-wrap">
          {subError && <div className="error-toast">{subError}<button onClick={() => setSubError(null)}>×</button></div>}
          {subLoading ? (
            <div className="set-row"><div className="set-label">불러오는 중...</div></div>
          ) : !subscription ? (
            <div className="set-row"><div className="set-label">구독 정보가 아직 없어요</div></div>
          ) : (
            <>
              <div className="set-row">
                <div className="set-label">플랜</div>
                <div className="set-inline">{subscription.planName}
                  {subscription.monthlyPrice > 0 ? ` (월 ${subscription.monthlyPrice.toLocaleString()}원)` : " (가격 미정)"}</div>
              </div>
              <div className="set-row">
                <div className="set-label">상태</div>
                <span className={`hist-status s-${
                  subscription.status === "active" ? "attended"
                  : subscription.status === "pending_billing_setup" ? "waitlisted"
                  : "cancelled"
                }`}>{STATUS_LABEL[subscription.status]}</span>
              </div>
              {subscription.status === "active" && subscription.nextBillingDate && (
                <div className="set-row">
                  <div className="set-label">다음 결제일</div>
                  <div className="set-inline">{subscription.nextBillingDate}</div>
                </div>
              )}
              {subscription.cardLast4 && (
                <div className="set-row">
                  <div className="set-label">등록된 카드</div>
                  <div className="set-inline">{subscription.cardCompany ?? ""} {subscription.cardLast4}****</div>
                </div>
              )}
              {subscription.status === "pending_billing_setup" && (
                <div className="set-row col">
                  <div className="set-label">카드 등록</div>
                  {BILLING_ENABLED ? (
                    <button className="primary-btn" disabled={subBusy || !canManage} onClick={handleCardRegister}>
                      {subBusy ? "처리 중..." : "카드 등록"}
                    </button>
                  ) : (
                    <>
                      <button className="ghost-btn" disabled>카드 등록</button>
                      <div className="set-soon-note">구독 결제 연동 준비 중이에요 — 자동결제 계약 심사가 끝나면 이용할 수 있어요.</div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
