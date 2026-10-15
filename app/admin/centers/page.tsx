"use client";

/*
  플랫폼 운영자 - 센터 승인 관리 화면
  - 대기 / 승인 / 반려 탭
  - 사업자 정보 확인 후 승인 또는 반려(사유 입력)
  - is_platform_admin = true 인 계정만 접근 가능
*/

import { useCallback, useEffect, useRef, useState } from "react";
import Loading from "../../components/Loading";
import UiIcon from "../../components/UiIcon";
import {
  checkPlatformAdmin, fetchCenterPage, approveCenter, rejectCenter, resetToPending,
  type PendingCenter, type CenterCursor,
} from "../../../lib/admin";
import { getBusinessLicenseUrl } from "../../../lib/storage";
import { replaceTabNavigation } from "../../../lib/navState";

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
  // 6번 — 검색어는 탭(상태)과 독립적인 state라 탭을 바꿔도 유지되고, 검색어를 지워도
  // 방금 고른 상태 탭은 그대로 유지된다(요구사항: "검색어=지워도 상태 filter 유지,
  // 상태 변경해도 검색어 유지").
  const requestId = useRef(0);
  const [nextCursor, setNextCursor] = useState<CenterCursor | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [keyword, setKeyword] = useState("");

  // 반려 사유 입력 시트
  const [rejectTarget, setRejectTarget] = useState<PendingCenter | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async (t: Tab, search = "", cursor: CenterCursor | null = null) => {
    const request = ++requestId.current;
    setLoading(true);
    if (!cursor) setNextCursor(null);
    setError(null);
    try {
      const result = await fetchCenterPage(t, search, cursor);
      if (request === requestId.current) {
        setCenters(previous => cursor ? [...previous, ...result.centers] : result.centers);
        setNextCursor(result.nextCursor);
      }
    } catch (e: any) {
      if (request === requestId.current) setError(e.message);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const admin = await checkPlatformAdmin();
      setIsAdmin(admin);
      if (admin) await load("pending");
      else setLoading(false);
    })().catch(() => { setIsAdmin(false); setLoading(false); });
    return () => { ++requestId.current; if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [load]);

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
    if (!(await globalThis.appConfirm(`'${c.name}'을(를) 승인할까요?\n승인하면 회원들에게 센터와 수업이 노출됩니다.`))) return;
    setBusy(true);
    try {
      await approveCenter(c.id);
      showToast(`${c.name} 승인 완료`);
      await load(tab, keyword);
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
      await load(tab, keyword);
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
      await load(tab, keyword);
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

  if (isAdmin === null) {
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
        <span className="mgr-mode-label"><UiIcon name="shield" size={15} /> 플랫폼 운영자</span>
        <a className="mgr-mode-switch" href="/" onClick={(e) => replaceTabNavigation(e, "/")}>회원 모드로 ↩</a>
      </div>

      <div className="section-title" style={{ paddingTop: 14 }}>센터 승인 관리</div>

      {/* 릴리스 폴리시 배치 8차(2026-09-18), 6-1/6-3 — 검색창을 제목 아래, 상태 탭
          위에 배치(권장 레이아웃). 입력 후 300ms 대기하여 검색, 기존 다른 검색 input과 동일하게 .input-field 재사용. */}
      <div className="admin-center-search">
        <UiIcon name="search" size={16} />
        <input
          className="input-field"
          placeholder="센터명, 대표자, 주소, 전화번호로 검색"
          value={keyword}
          maxLength={200}
          onChange={(e) => {
            const value = e.target.value; setKeyword(value);
            ++requestId.current; setNextCursor(null);
            if (searchTimer.current) clearTimeout(searchTimer.current);
            searchTimer.current = setTimeout(() => { void load(tab, value); }, 300);
          }}
        />
        {keyword && (
          <button
            type="button"
            className="admin-center-search-clear"
            aria-label="검색어 지우기"
            onClick={() => { if (searchTimer.current) clearTimeout(searchTimer.current); setKeyword(""); void load(tab); }}
          >
            <UiIcon name="close" size={14} />
          </button>
        )}
      </div>

      {/* 상태 탭 */}
      <div className="center-switcher">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            className={`center-chip ${t === tab ? "on" : ""}`}
            onClick={() => { if (t !== tab) { if (searchTimer.current) clearTimeout(searchTimer.current); setTab(t); setCenters([]); void load(t, keyword); } }}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading && <div role="status">센터 목록을 불러오는 중이에요</div>}
      {!loading && centers.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>
          {/* 6-4 — "필터 자체에 데이터가 없음"과 "검색어 때문에 없음"을 구분한다. */}
          {keyword.trim()
            ? `'${keyword.trim()}' 검색 결과가 없어요`
            : tab === "pending" ? "승인 대기중인 센터가 없어요" : `${TAB_LABEL[tab]} 센터가 없어요`}
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
                  ? <button className="text-btn" onClick={() => openLicense(c.businessLicenseUrl!)}><UiIcon name="paperclip" size={15} /> 서류 보기</button>
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
          {nextCursor && <button type="button" className="ghost-btn" disabled={loading} onClick={() => { void load(tab, keyword, nextCursor); }}>센터 더 보기</button>}
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
