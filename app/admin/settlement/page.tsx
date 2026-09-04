"use client";

/*
  플랫폼 운영자 - 센터 정산 (수동 대량이체 참고용)
  - 기간을 고르면 센터별로 그 기간 동안 실제 PG(카드/카카오페이/토스페이/계좌이체)로
    확정된 결제 합계와 정산 계좌를 보여준다. 은행 인터넷뱅킹의 "대량이체" 업로드에 쓸
    CSV로 내보낼 수 있다(add_center_settlement_accounts.sql의 admin_center_settlement_summary
    RPC, 원본 payments 행에 대한 새 조회 권한은 아무에게도 주지 않고 이 집계 결과만 노출).
  - Toss 지급대행(자동 정산)이 아직 계약 전이라(2026-09-02) 그 사이 임시로 쓰는 도구 —
    지급대행이 실제로 붙으면 이 화면 역할은 줄어들 것.
  - is_platform_admin = true 인 계정만 접근 가능
*/

import { useEffect, useState } from "react";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import { checkPlatformAdmin } from "../../../lib/admin";
import { fetchAdminSettlementSummary, toSettlementCsv, type AdminSettlementRow } from "../../../lib/settlementAccounts";

// toISOString()은 UTC로 변환하므로 UTC+9(KST)에서는 자정 직후 값이 전날로 밀린다
// (예: 9/1 00:00 KST → 8/31 15:00 UTC) — 로컬 날짜 그대로 YYYY-MM-DD로 포맷한다.
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayStr() {
  return toLocalDateStr(new Date());
}
function firstOfMonthStr() {
  const d = new Date();
  return toLocalDateStr(new Date(d.getFullYear(), d.getMonth(), 1));
}

export default function AdminSettlementPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  const [startDate, setStartDate] = useState(firstOfMonthStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [rows, setRows] = useState<AdminSettlementRow[]>([]);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      setLoading(false);
    })();
  }, []);

  async function handleSearch() {
    setFetching(true); setError(null);
    try {
      setRows(await fetchAdminSettlementSummary(startDate, endDate));
      setSearched(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setFetching(false);
    }
  }

  function handleDownload() {
    const csv = toSettlementCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `정산_${startDate}_${endDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (isAdmin === false) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/">‹</a>
          <div className="title">센터 정산</div>
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

  const total = rows.reduce((sum, r) => sum + r.totalAmount, 0);
  const missingAccount = rows.filter((r) => !r.accountNumber);

  return (
    <div className="app-shell">
      <div className="mgr-mode-bar">
        <span className="mgr-mode-label"><UiIcon name="shield" size={15} /> 플랫폼 운영자</span>
        <a className="mgr-mode-switch" href="/">회원 모드로 ↩</a>
      </div>

      <div className="back-header">
        <a className="side" href="/admin">‹</a>
        <div className="title">센터 정산</div>
        <div className="side" />
      </div>

      <div className="perm-guide" style={{ margin: "0 20px 12px" }}>
        선택한 기간에 실제 결제(카드·카카오페이·토스페이·계좌이체)로 확정된 금액을
        센터별로 합산해요. 현장 결제 건은 대상이 아니에요. 은행 대량이체에 참고하세요.
      </div>

      <div className="login-wrap" style={{ padding: "0 20px 16px", alignItems: "stretch" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input-field" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <input className="input-field" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <button className="primary-btn" onClick={handleSearch} disabled={fetching}>
          {fetching ? "조회 중..." : "조회"}
        </button>
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {searched && (
        rows.length === 0 ? (
          <div className="daylist-empty" style={{ paddingTop: 20 }}>이 기간에 정산할 금액이 없어요</div>
        ) : (
          <div style={{ padding: "0 20px" }}>
            <div className="set-row">
              <div className="set-label">합계</div>
              <div className="set-inline" style={{ fontWeight: 800 }}>{total.toLocaleString()}원 · {rows.length}개 센터</div>
            </div>

            {missingAccount.length > 0 && (
              <div className="legal-note" style={{ margin: "10px 0" }}>
                {missingAccount.map((r) => r.centerName).join(", ")}는 정산 계좌가 아직
                등록 안 됐어요 — 센터에 `/manager/settlement`에서 입력해달라고 안내해주세요.
              </div>
            )}

            <button className="ghost-btn" style={{ margin: "10px 0" }} onClick={handleDownload}>
              CSV로 내보내기
            </button>

            <div className="admin-list">
              {rows.map((r) => (
                <div key={r.centerId} className="admin-card">
                  <div className="admin-card-head">
                    <div className="admin-center-name">{r.centerName}</div>
                    <span className="admin-row v" style={{ fontWeight: 800 }}>{r.totalAmount.toLocaleString()}원</span>
                  </div>
                  <div className="admin-row"><span className="k">계좌</span><span className="v">
                    {r.accountNumber ? `${r.bankName ?? ""} ${r.accountHolderName ?? ""} ${r.accountNumber}` : "미등록"}
                  </span></div>
                </div>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
}
