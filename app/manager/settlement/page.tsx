"use client";

/*
  매니저 - 정산계좌 (Toss 지급대행 — 회원 결제 대금을 센터 계좌로 자동 정산)
  - 스튜디오 오너 전용(플랫폼 구독과 동일한 이유 — center_roles.is_owner로 직접 고정,
    위임 가능한 권한 키가 아니다). 오너가 아니면 화면 자체를 막는다.
  - 회원 결제(카드/카카오페이/토스페이)는 각 센터가 아니라 플랫폼(대표 개인사업자)
    명의 Toss 가맹점으로 직접 수납되고, 센터에는 별도 정산하는 구조다(사용자 결정,
    2026-09-02). 이 화면은 그 정산을 자동화(Toss 지급대행)하기 위한 계좌 등록 화면이며,
    실제 등록은 PAYOUTS_ENABLED 플래그가 꺼져 있는 동안 비활성화된다(계약 확정 전).
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchCenterPayoutAccount, PAYOUTS_ENABLED, STATUS_LABEL, type CenterPayoutAccount } from "../../../lib/payouts";

export default function ManagerSettlementPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [account, setAccount] = useState<CenterPayoutAccount | null>(null);
  const [acctLoading, setAcctLoading] = useState(true);
  const [acctError, setAcctError] = useState<string | null>(null);

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

  const loadAccount = useCallback(async () => {
    if (!centerId) return;
    setAcctLoading(true); setAcctError(null);
    try {
      setAccount(await fetchCenterPayoutAccount(centerId));
    } catch (e: any) { setAcctError(e.message); }
    finally { setAcctLoading(false); setLoading(false); }
  }, [centerId]);

  useEffect(() => { loadAccount(); }, [loadAccount]);

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">정산계좌</div>
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
        <div className="title">정산계좌</div>
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
          <div className="perm-guide" style={{ margin: "0 0 12px" }}>
            회원 결제 대금은 지금 대표 사업자 계좌로 먼저 들어오고, 이 센터로는 별도
            정산됩니다. 정산 자동화(계좌 등록)는 준비 중이에요.
          </div>

          {acctError && <div className="error-toast">{acctError}<button onClick={() => setAcctError(null)}>×</button></div>}
          {acctLoading ? (
            <div className="set-row"><div className="set-label">불러오는 중...</div></div>
          ) : !account ? (
            <div className="set-row"><div className="set-label">정산계좌 정보가 아직 없어요</div></div>
          ) : (
            <>
              <div className="set-row">
                <div className="set-label">상태</div>
                <span className={`hist-status s-${
                  account.status === "approved" ? "attended"
                  : account.status === "not_registered" ? "waitlisted"
                  : account.status === "rejected" || account.status === "suspended" ? "cancelled"
                  : "waitlisted"
                }`}>{STATUS_LABEL[account.status]}</span>
              </div>
              {account.bankName && account.bankAccountLast4 && (
                <div className="set-row">
                  <div className="set-label">등록된 계좌</div>
                  <div className="set-inline">{account.bankName} {account.accountHolderName ?? ""} ****{account.bankAccountLast4}</div>
                </div>
              )}
              {account.rejectionReason && (
                <div className="set-row">
                  <div className="set-label">반려 사유</div>
                  <div className="set-inline">{account.rejectionReason}</div>
                </div>
              )}

              <div className="set-row col">
                <div className="set-label">정산계좌 등록</div>
                {PAYOUTS_ENABLED ? (
                  <button className="primary-btn" disabled>등록</button>
                ) : (
                  <>
                    <button className="ghost-btn" disabled>계좌 등록</button>
                    <div className="set-soon-note">
                      정산 자동화 연동 준비 중이에요 — 계약이 확정되면 이 화면에서
                      계좌를 등록할 수 있어요. 그때까지는 기존처럼 매니저 매출 화면에서
                      확인해주세요.
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
