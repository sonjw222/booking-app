"use client";

/*
  운영자 - 후기 신고 관리 (Release Blocker Cleanup Batch A)
  - 신고된 후기를 상태별(대기/확인완료/기각)로 조회
  - 신고 확인 완료 / 기각 처리
  - 필요하면 기존 매니저/운영자 후기 삭제 경로(deleteReviewAsManager) 그대로 재사용
    (새 삭제 경로를 만들지 않음 — 자동 삭제/차단은 이번 범위 밖)
*/

import { useCallback, useEffect, useState } from "react";
import {
  fetchReviewReportsForAdmin, resolveReviewReport, deleteReviewAsManager,
  REVIEW_REPORT_REASON_LABELS, type ReviewReportForAdmin, type ReviewReportStatus,
} from "../../../lib/reviews";
import { checkPlatformAdmin } from "../../../lib/admin";
import Loading from "../../components/Loading";

const STATUS_TABS: { key: ReviewReportStatus; label: string }[] = [
  { key: "pending", label: "대기" },
  { key: "reviewed", label: "확인 완료" },
  { key: "dismissed", label: "기각" },
];

export default function AdminReviewReportsPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [status, setStatus] = useState<ReviewReportStatus>("pending");
  const [reports, setReports] = useState<ReviewReportForAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2000); }

  const load = useCallback(async (s: ReviewReportStatus) => {
    setLoading(true); setError(null);
    try { setReports(await fetchReviewReportsForAdmin(s)); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      if (admin) await load(status);
      else setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isAdmin) load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function handleResolve(reportId: string, next: "reviewed" | "dismissed") {
    setBusyId(reportId);
    try {
      await resolveReviewReport(reportId, next);
      showToast(next === "reviewed" ? "확인 완료로 처리했어요" : "신고를 기각했어요");
      await load(status);
    } catch (e: any) { setError(e.message); }
    finally { setBusyId(null); }
  }

  async function handleDeleteReview(report: ReviewReportForAdmin) {
    if (!(await globalThis.appConfirm("이 후기를 삭제할까요? 되돌릴 수 없어요."))) return;
    setBusyId(report.id);
    try {
      await deleteReviewAsManager(report.reviewId);
      await resolveReviewReport(report.id, "reviewed");
      showToast("후기를 삭제하고 신고를 처리했어요");
      await load(status);
    } catch (e: any) { setError(e.message); }
    finally { setBusyId(null); }
  }

  if (isAdmin === false) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/admin">‹</a>
          <div className="title">후기 신고 관리</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>
          플랫폼 운영자만 접근할 수 있는 화면이에요
        </div>
      </div>
    );
  }
  if (isAdmin === null) return <div className="app-shell"><Loading /></div>;

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/admin">‹</a>
        <div className="title">후기 신고 관리</div>
        <div className="side" />
      </div>

      <div style={{ display: "flex", gap: 8, padding: "10px 16px" }}>
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`filter-chip ${status === t.key ? "on" : ""}`}
            onClick={() => setStatus(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="auth-msg error" style={{ margin: "0 16px 8px" }}>{error}</div>}
      {toast && <div className="toast">{toast}</div>}

      {loading ? (
        <Loading />
      ) : reports.length === 0 ? (
        <div className="daylist-empty" style={{ padding: "40px 20px" }}>
          {status === "pending" ? "대기 중인 신고가 없어요" : "해당 상태의 신고가 없어요"}
        </div>
      ) : (
        <div style={{ padding: "0 16px 40px" }}>
          {reports.map((r) => (
            <div key={r.id} className="admin-card" style={{ marginBottom: 12 }}>
              <div className="admin-row">
                <span className="k">신고 사유</span>
                <span className="v">{REVIEW_REPORT_REASON_LABELS[r.reason]}</span>
              </div>
              {r.detail && (
                <div className="admin-row">
                  <span className="k">상세</span>
                  <span className="v">{r.detail}</span>
                </div>
              )}
              <div className="admin-row">
                <span className="k">신고자</span>
                <span className="v">{r.reporterName}</span>
              </div>
              <div className="admin-row">
                <span className="k">신고 시각</span>
                <span className="v">{r.createdAt}</span>
              </div>
              <div className="admin-row">
                <span className="k">후기 작성자</span>
                <span className="v">{r.reviewWriterName} ({"★".repeat(r.reviewRating)})</span>
              </div>
              <div className="admin-row" style={{ alignItems: "flex-start" }}>
                <span className="k">후기 내용</span>
                <span className="v" dangerouslySetInnerHTML={{ __html: r.reviewContent }} />
              </div>

              {status === "pending" && (
                <div className="add-profile-actions" style={{ marginTop: 12 }}>
                  <button className="ghost-btn" disabled={busyId === r.id} onClick={() => handleResolve(r.id, "dismissed")}>
                    기각
                  </button>
                  <button className="ghost-btn" disabled={busyId === r.id} onClick={() => handleDeleteReview(r)}>
                    후기 삭제
                  </button>
                  <button className="primary-btn" disabled={busyId === r.id} onClick={() => handleResolve(r.id, "reviewed")}>
                    확인 완료
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
