"use client";

/*
  플랫폼 운영자 - 센터별 플랫폼 구독 현황 (조회 전용)
  - 전체 센터가 어떤 플랜인지, 카드 등록/결제 상태가 어떤지 목록으로 확인
  - 상태 변경 액션은 없음(이번 배치 범위 밖 — docs/TODO.md 참고)
  - is_platform_admin = true 인 계정만 접근 가능
*/

import { useEffect, useState } from "react";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import { checkPlatformAdmin } from "../../../lib/admin";
import {
  fetchAllCenterSubscriptions, STATUS_LABEL, type AdminCenterSubscription, type SubscriptionStatus,
} from "../../../lib/centerSubscription";

const STATUS_BADGE: Record<SubscriptionStatus, string> = {
  pending_billing_setup: "s-waitlisted",
  active: "s-attended",
  past_due: "s-cancelled",
  canceled: "s-cancelled",
};

export default function AdminSubscriptionsPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [rows, setRows] = useState<AdminCenterSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      if (!admin) { setLoading(false); return; }
      try {
        setRows(await fetchAllCenterSubscriptions());
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
