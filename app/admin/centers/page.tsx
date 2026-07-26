"use client";

/*
  플랫폼 운영자 - 센터 승인 관리 화면
  - 대기 / 승인 / 반려 탭
  - 사업자 정보 확인 후 승인 또는 반려(사유 입력)
  - is_platform_admin = true 인 계정만 접근 가능
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../components/Loading";
import {
  checkPlatformAdmin, fetchCenters, approveCenter, rejectCenter, resetToPending,
  type PendingCenter,
} from "../../../lib/admin";
import { getBusinessLicenseUrl } from "../../../lib/storage";

type Tab = "pending" | "approved" | "rejected";

const TAB_LABEL: Record<Tab, string> = {
  pending: "승인대기",
  approved: "승인됨",
  rejected: "반려됨",
};

export default function AdminCentersPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const [centers, setCenters] = useState<PendingCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 반려 사유 입력 시트
  const [rejectTarget, setRejectTarget] = useState<PendingCenter | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async (t: Tab) => {
    setLoading(true);
    setError(null);
    try {
      setCenters(await fetchCenters(t));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      if (admin) await load(tab);
      else setLoading(false);
    })();
  }, [tab, load]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function openLicense(path: string) {
    const url = await getBusinessLicenseUrl(path);
    if (url) window.open(url, "_blank");
    else setError("서류를 열 수 없어요. 파일이 없거나 권한이 없어요.");
  }

  async function handleApprove(c: PendingCenter) {
    if (!confirm(`'${c.name}'을(를) 승인할까요?\n승인하면 회원들에게 센터와 수업이 노출됩니다.`)) return;
    setBusy(true);
    try {
      await approveCenter(c.id);
      showToast(`${c.name} 승인 완료`);
      await load(tab);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!rejectTarget) return;
    if (!rejectReason.trim()) {
      setError("반려 사유를 입력해주세요");
      return;
    }
    setBusy(true);
    try {
      await rejectCenter(rejectTarget.id, rejectReason.trim());
      showToast(`${rejectTarget.name} 반려 처리`);
      setRejectTarget(null);
      setRejectReason("");
      await load(tab);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReset(c: PendingCenter) {
    setBusy(true);
    try {
      await resetToPending(c.id);
      showToast("대기 상태로 되돌렸어요");
      await load(tab);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // 권한 없음
  if (isAdmin === false) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/">‹</a>
          <div className="title">센터 승인 관리</div>
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
      {toast && <div className="toast">{toast}</div>}

      <div className="mgr-mode-bar">
        <span className="mgr-mode-label">🛡️ 플랫폼 운영자</span>
        <a className="mgr-mode-switch" href="/">회원 모드로 ↩</a>
      </div>

      <div className="section-title" style={{ paddingTop: 14 }}>센터 승인 관리</div>

      {/* 상태 탭 */}
      <div className="center-switcher">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            className={`center-chip ${t === tab ? "on" : ""}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {centers.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>
          {tab === "pending" ? "승인 대기중인 센터가 없어요" : `${TAB_LABEL[tab]} 센터가 없어요`}
        </div>
      ) : (
        <div className="admin-list">
          {centers.map((c) => (
            <div key={c.id} className="admin-card">
              <div className="admin-card-head">
                <div className="admin-center-name">{c.name}</div>
                <span className={`hist-status s-${c.status === "approved" ? "attended" : c.status === "rejected" ? "cancelled" : "waitlisted"}`}>
                  {TAB_LABEL[c.status]}
                </span>
              </div>

              <div className="admin-row"><span className="k">대표자</span><span className="v">{c.ownerName ?? "-"} {c.ownerPhone ? `(${c.ownerPhone})` : ""}</span></div>
              <div className="admin-row"><span className="k">주소</span><span className="v">{c.address ?? "-"}</span></div>
              <div className="admin-row"><span className="k">대표번호</span><span className="v">{c.phone ?? "-"}</span></div>
              <div className="admin-row"><span className="k">사업자번호</span><span className="v">{c.businessNumber ?? "-"}</span></div>
              <div className="admin-row"><span className="k">등록증</span><span className="v">
                {c.businessLicenseUrl
                  ? <button className="text-btn" onClick={() => openLicense(c.businessLicenseUrl!)}>📎 서류 보기</button>
                  : "미첨부"}
              </span></div>
              <div className="admin-row"><span className="k">신청일</span><span className="v">{c.createdAt}</span></div>

              {c.status === "rejected" && c.rejectReason && (
                <div className="admin-reject-reason">반려 사유: {c.rejectReason}</div>
              )}

              <div className="admin-actions">
                {c.status === "pending" && (
                  <>
                    <button className="ghost-btn" disabled={busy} onClick={() => setRejectTarget(c)}>반려</button>
                    <button className="primary-btn" disabled={busy} onClick={() => handleApprove(c)}>승인</button>
                  </>
                )}
                {c.status === "rejected" && (
                  <button className="ghost-btn" disabled={busy} onClick={() => handleReset(c)}>대기로 되돌리기</button>
                )}
                {c.status === "approved" && (
                  <button className="ghost-btn" disabled={busy} onClick={() => setRejectTarget(c)}>승인 취소(반려)</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 반려 사유 입력 시트 */}
      {rejectTarget && (
        <div className="sheet-overlay" onClick={() => setRejectTarget(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{rejectTarget.name} 반려</div>
            <input
              className="input-field"
              placeholder="반려 사유 (예: 사업자등록증 확인 불가)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="add-profile-actions">
              <button className="ghost-btn" onClick={() => { setRejectTarget(null); setRejectReason(""); }}>취소</button>
              <button className="primary-btn" disabled={busy} onClick={handleReject}>
                {busy ? "처리 중..." : "반려하기"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
