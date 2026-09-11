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

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchCenterSubscription, requestCenterBillingAuth, confirmCenterBilling, centerChangeOwnSubscriptionPlan,
  centerCancelOwnSubscription, BILLING_ENABLED, STATUS_LABEL, type CenterSubscription,
} from "../../../lib/centerSubscription";
import { fetchSubscriptionPlans, type SubscriptionPlan } from "../../../lib/operator";
import { BUSINESS_INFO } from "../../../lib/businessInfo";

export default function ManagerSubscriptionPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ManagerSubscriptionContent />
    </Suspense>
  );
}

function ManagerSubscriptionContent() {
  const sp = useSearchParams();
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [subscription, setSubscription] = useState<CenterSubscription | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);

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

  // 토스 카드 등록창(requestBillingAuth)이 successUrl/failUrl로 돌아온 뒤의 후속 처리.
  // billing=success면 authKey/customerKey를 서버(app/api/billing/confirm)로 넘겨
  // billingKey 교환 + 최초 결제까지 확정한다. 처리 후 쿼리를 지워 새로고침 시 중복
  // 청구되지 않게 한다(app/checkout/success/page.tsx와 동일한 관례).
  useEffect(() => {
    const billing = sp.get("billing");
    if (!billing) return;
    const qsCenterId = sp.get("center");
    window.history.replaceState(null, "", window.location.pathname);
    if (billing === "fail") {
      setBillingNotice("카드 등록이 취소됐거나 실패했어요. 다시 시도해주세요.");
      return;
    }
    if (billing !== "success" || !qsCenterId) return;
    const authKey = sp.get("authKey");
    const customerKey = sp.get("customerKey");
    if (!authKey || !customerKey) {
      setBillingNotice("카드 등록 응답이 올바르지 않아요. 다시 시도해주세요.");
      return;
    }
    (async () => {
      setBillingNotice("카드 등록을 확인하는 중이에요...");
      try {
        await confirmCenterBilling(authKey, customerKey, qsCenterId);
        setBillingNotice("카드 등록과 첫 결제가 완료돼서 구독이 시작됐어요.");
        setCenterId(qsCenterId);
        await loadSubscription();
      } catch (e: any) {
        setBillingNotice(e.message ?? "카드 등록 확정에 실패했어요");
      }
    })();
    // 마운트 시점 쿼리만 처리하면 됨(중복 확정 방지) — sp/loadSubscription 재실행 불필요.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      {billingNotice && <div className="error-toast">{billingNotice}<button onClick={() => setBillingNotice(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : (
        <div className="settings-wrap">
          {subError && <div className="error-toast">{subError}<button onClick={() => setSubError(null)}>×</button></div>}
          {subscription && (
            <div className="set-row col" style={{ background: "var(--card-bg, #f7f7f9)", borderRadius: 12, padding: "14px 16px", marginBottom: 12 }}>
              <div className="set-label" style={{ fontWeight: 600, marginBottom: 6 }}>상품 안내 — {subscription.planName}</div>
              <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--text-muted, #666)" }}>
                {subscription.monthlyPrice > 0 ? (
                  <>월 {subscription.monthlyPrice.toLocaleString()}원 (부가세 포함) · 신용카드 자동(정기)결제<br /></>
                ) : (
                  <>가격 미정 — 운영자가 플랜을 확정하는 대로 표시돼요<br /></>
                )}
                1회 결제당 서비스 제공기간은 1개월이며, 별도로 해지하지 않으면 매월 자동으로
                갱신·청구돼요. 결제일은 최초 카드 등록일과 같은 날짜(매월)이며, 등록된
                신용카드로 자동 청구돼요.<br />
                제공 기능: 센터 회원·수업·예약·수강권 관리 등 모하빗 매니저 기능 전체.<br />
                해지는 이 화면의 &ldquo;구독 취소&rdquo; 버튼으로 언제든 가능하며, 해지해도
                이미 결제된 기간 동안은 계속 이용할 수 있고 다음 결제일부터 청구가 중단돼요.
                <br />
                자세한 환불 기준은{" "}
                <a href="/legal/refund" target="_blank" rel="noopener noreferrer">환불·취소 정책</a>,
                이용 약관은{" "}
                <a href="/legal/terms" target="_blank" rel="noopener noreferrer">이용약관</a>,
                개인정보 처리는{" "}
                <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">개인정보처리방침</a>
                을 확인해주세요.
              </div>
            </div>
          )}
          {subLoading ? (
            <div className="set-row"><div className="set-label">불러오는 중...</div></div>
          ) : !subscription ? (
            <div className="set-row"><div className="set-label">구독 정보가 아직 없어요</div></div>
          ) : (
            <>
              <div className="set-row">
                <div className="set-label">플랜</div>
                <div className="set-inline">{subscription.planName}
                  {subscription.monthlyPrice > 0 ? ` (월 ${subscription.monthlyPrice.toLocaleString()}원, 부가세 포함)` : " (가격 미정)"}</div>
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
              <div className="set-row">
                <div className="set-label">카카오 알림톡</div>
                <div className="set-inline">
                  {subscription.alimtalkAddon
                    ? `사용 중 · 건당 ${(subscription.alimtalkAddonUnitPrice ?? 0).toLocaleString()}원`
                    : "미신청 — 신청은 플랫폼 운영자에게 문의해주세요"}
                </div>
              </div>
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

          {/* 토스페이먼츠 자동결제 계약 심사 요구사항 — 사업자등록증과 일치하는 사업자
              정보를 결제 상품 화면 하단에 표시. 이 앱은 모바일 앱 셸 구조(전역 하단
              네비게이션 바)라 전통적인 웹사이트 footer가 없어, 결제 상품 화면 자체의
              맨 아래에 배치한다(lib/businessInfo.ts가 단일 출처, /legal/business와 동일 값). */}
          <div className="set-row col" style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border-color, #e5e5e5)", fontSize: 12, color: "var(--text-muted, #888)", lineHeight: 1.8 }}>
            <div>{BUSINESS_INFO.serviceName} · 상호 {BUSINESS_INFO.companyName} · 대표 {BUSINESS_INFO.ceoName}</div>
            <div>사업자등록번호 {BUSINESS_INFO.businessRegNo} · 통신판매업 신고번호 {BUSINESS_INFO.mailOrderRegNo}</div>
            <div>{BUSINESS_INFO.address}</div>
            <div>고객센터 {BUSINESS_INFO.customerServicePhone} · {BUSINESS_INFO.email}</div>
            <div><a href="/legal/business" target="_blank" rel="noopener noreferrer">사업자 정보 전체보기</a></div>
          </div>
        </div>
      )}
    </div>
  );
}
