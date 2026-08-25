"use client";

/*
  매니저 - 플랫폼 구독 (센터 → 우리에게 내는 월 구독료)
  - 원래 app/manager/settings(운영 설정) 안의 한 섹션이었는데, 회원/예약 운영 설정과
    성격이 완전히 다른 축(우리 쪽 매출/계약)이라 별도 메뉴로 분리함.
  - 스튜디오 오너 전용(사용자 결정, 2026-08-26) — facility.operation 같은 위임 가능한
    권한 키가 아니라 center_roles.is_owner로 직접 고정. 스태프에게 위임할 성격의 화면이
    아니라고 판단(플랫폼과의 결제 계약 상태). 오너가 아니면 화면 자체를 막는다(메뉴에서
    숨기는 것과 별개로, 직접 URL 접근도 차단).
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchCenterSubscription, requestCenterBillingAuth, centerChangeOwnSubscriptionPlan,
  centerCancelOwnSubscription, BILLING_ENABLED, STATUS_LABEL, type CenterSubscription,
} from "../../../lib/centerSubscription";
import { fetchSubscriptionPlans, type SubscriptionPlan } from "../../../lib/operator";

export default function ManagerSubscriptionPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [subscription, setSubscription] = useState<CenterSubscription | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchMyCenters();
        // 오너인 센터만 이 화면의 대상 — 스태프로만 소속된 센터는 전환 목록에서도 뺀다.
        setCenters(list.filter((c) => c.isOwner));
        if (list.some((c) => c.isOwner)) setCenterId(list.find((c) => c.isOwner)!.id);
        else setLoading(false);
      } catch (e: any) { setError(e.message); setLoading(false); }
    })();
  }, []);

  const activeCenter = centers.find((c) => c.id === centerId);

  const loadSubscription = useCallback(async () => {
    if (!centerId) return;
    setSubLoading(true); setSubError(null);
    try {
      const [sub, planList] = await Promise.all([fetchCenterSubscription(centerId), fetchSubscriptionPlans()]);
      setSubscription(sub);
      setPlans(planList.filter((p) => p.isActive));
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

  async function handleChangePlan(planId: string) {
    if (!centerId || !planId || planId === subscription?.planId) return;
    setSubBusy(true); setSubError(null);
    try {
      await centerChangeOwnSubscriptionPlan(centerId, planId);
      await loadSubscription();
    } catch (e: any) { setSubError(e.message); }
    finally { setSubBusy(false); }
  }

  // 실제 결제 연동(BILLING_ENABLED) 전에는 구독 취소도 막아둔다 — 취소해도 상태만
  // 'canceled'로 바뀔 뿐 플랜 제한은 그대로 적용되는데(사용자 결정), 지금은 어차피
  // 실제로 요금이 청구되는 것도 아니라 "취소"가 아무 의미 없는 상태 전환만 만들어
  // 오히려 혼란스럽다(QA 중 발견). 버튼 자체는 남겨두되 비활성화 + 안내 문구로 카드
  // 등록 버튼과 동일한 패턴을 쓰고, 실결제 연동 후 이 게이트를 풀 것.
  async function handleCancel() {
    if (!centerId || !BILLING_ENABLED) return;
    const ok = await globalThis.appConfirm("플랫폼 구독을 취소할까요? 취소해도 지금 쓰고 있는 기능은 그대로 이용할 수 있어요.");
    if (!ok) return;
    setSubBusy(true); setSubError(null);
    try {
      await centerCancelOwnSubscription(centerId);
      await loadSubscription();
    } catch (e: any) { setSubError(e.message); }
    finally { setSubBusy(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">플랫폼 구독</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>
          스튜디오 오너만 접근할 수 있는 화면이에요
        </div>
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
                    <button className="primary-btn" disabled={subBusy} onClick={handleCardRegister}>
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
              {plans.length > 0 && (
                <div className="set-row">
                  <div className="set-label">플랜 변경</div>
                  <select
                    className="input-field" style={{ width: "auto" }}
                    value="" disabled={subBusy}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) handleChangePlan(v);
                      e.target.value = "";
                    }}
                  >
                    <option value="">플랜 선택...</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id} disabled={p.id === subscription.planId}>
                        {p.name}{p.id === subscription.planId ? " (현재)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {subscription.status !== "canceled" && (
                BILLING_ENABLED ? (
                  <button className="profile-del" style={{ marginTop: 6 }} disabled={subBusy} onClick={handleCancel}>
                    구독 취소
                  </button>
                ) : (
                  <div className="set-row col">
                    <button className="ghost-btn" disabled>구독 취소</button>
                    <div className="set-soon-note">구독 취소는 아직 지원하지 않아요 — 실제 결제 연동(자동결제 심사)이 끝나면 이용할 수 있어요.</div>
                  </div>
                )
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
