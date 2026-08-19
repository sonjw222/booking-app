"use client";

/*
  매니저 - 회원 관리 화면
  - 센터 선택 → 회원 목록 (등급/상태 필터 + 이름·전화 검색)
  - 회원 등급 부여, 메모 작성 (메모는 회원에게 안 보임)
  - 엑셀(CSV) 내보내기: 내보낼 항목 선택
*/

import { Suspense, useCallback, useEffect, useState, useRef } from "react";
import Loading from "../../components/Loading";
import { useSearchParams } from "next/navigation";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import {
  fetchMembers, fetchGrades, createGrade, deleteGrade,
  updateMemberGrade, updateMemberMemo, updateMemberAddress, updateMemberStatus, syncMembersFromReservations,
  membersToCsv, fetchMemberDetail, searchAccountsForMember, addMemberToCenter,
  type CenterMember, type Grade, type MemberDetailData,
} from "../../../lib/members";

const RES_STATUS: Record<string, string> = {
  confirmed: "확정", waitlisted: "대기", cancelled: "취소", attended: "출석", no_show: "노쇼",
};
const SALE_LABEL: Record<string, string> = {
  new: "신규", renew: "재결제", trial: "체험", upgrade: "업그레이드", refund: "환불", unpaid_pay: "미수금", transfer_fee: "양도",
};

const STATUS_LABEL: Record<string, string> = {
  active: "이용중", expired: "만료", dormant: "휴면",
};

const CSV_COLUMNS = [
  { key: "name", label: "이름" },
  { key: "grade", label: "등급" },
  { key: "phone", label: "전화번호" },
  { key: "registeredAt", label: "등록일" },
  { key: "lastAttendedAt", label: "최근출석일" },
  { key: "appLinked", label: "앱연결여부" },
  { key: "status", label: "상태" },
  { key: "passName", label: "수강권명" },
  { key: "remainingCount", label: "잔여횟수" },
  { key: "expiresAt", label: "만료일" },
  { key: "memo", label: "메모" },
];

const GRADE_COLORS = ["#E86A5E", "#F0B429", "#EC8FA8", "#5B8DEF", "#3E9C8C", "#8B6BB1"];

export default function MembersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <MembersContent />
    </Suspense>
  );
}

function MembersContent() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [members, setMembers] = useState<CenterMember[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 필터
  const [gradeFilter, setGradeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [searchField, setSearchField] = useState<"all" | "name" | "phone" | "address">("all");

  // 시트
  const [detail, setDetail] = useState<CenterMember | null>(null);
  const [detailData, setDetailData] = useState<MemberDetailData | null>(null);
  const [detailTab, setDetailTab] = useState<"info" | "reservations" | "progress" | "payments">("info");
  const [showAllPasses, setShowAllPasses] = useState(false);
  const [showAllGoods, setShowAllGoods] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [memoText, setMemoText] = useState("");
  const [addressText, setAddressText] = useState("");
  // 회원 추가 시트
  const [addSheet, setAddSheet] = useState(false);
  const [searchKw, setSearchKw] = useState("");
  const [searchResults, setSearchResults] = useState<{ profileId: string; name: string; phone: string | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const [gradeSheet, setGradeSheet] = useState(false);
  const [newGradeName, setNewGradeName] = useState("");
  const [newGradeColor, setNewGradeColor] = useState(GRADE_COLORS[0]);
  const [csvSheet, setCsvSheet] = useState(false);
  const [csvCols, setCsvCols] = useState<string[]>(["name", "grade", "phone", "passName", "remainingCount", "expiresAt"]);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2400); }

  async function handleSearch() {
    setSearching(true);
    setError(null);
    try {
      setSearchResults(await searchAccountsForMember(searchKw));
    } catch (e: any) { setError(e.message); }
    finally { setSearching(false); }
  }

  async function handleAddMember(profileId: string) {
    if (!centerId) return;
    setBusy(true);
    try {
      await addMemberToCenter(centerId, profileId);
      showToast("회원을 등록했어요");
      setAddSheet(false);
      setSearchKw(""); setSearchResults([]);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function openDetail(m: CenterMember) {
    setMemoText(m.memo ?? "");
    setAddressText(m.address ?? "");
    setDetailTab("info");
    setShowAllPasses(false); setShowAllGoods(false);
    setDetailData(null);
    setDetailLoading(true);
    setDetail(m);   // 시트를 열되, 내용은 로딩 후 한 번에 표시
    try {
      setDetailData(await fetchMemberDetail(m.profileId));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDetailLoading(false);
    }
  }

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

  const load = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const [ms, gs] = await Promise.all([
        fetchMembers(centerId, { gradeId: gradeFilter, status: statusFilter, keyword, searchField }),
        fetchGrades(centerId),
      ]);
      setMembers(ms); setGrades(gs);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId, gradeFilter, statusFilter, keyword, searchField]);

  // 검색어 입력 중엔 300ms 기다렸다 조회 (결과 깜빡임 방지)
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  // URL ?profile=<profileId> 로 들어오면 그 회원 상세를 자동으로 열기 (1회)
  const searchParams = useSearchParams();
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current) return;
    const pid = searchParams.get("profile");
    if (!pid || members.length === 0) return;
    const target = members.find((m) => m.profileId === pid);
    if (target) {
      autoOpened.current = true;
      openDetail(target);
    }
  }, [searchParams, members]);

  async function handleSync() {
    if (!centerId) return;
    setBusy(true);
    try {
      const n = await syncMembersFromReservations(centerId);
      showToast(n > 0 ? `예약 이력에서 회원 ${n}명을 등록했어요` : "새로 등록할 회원이 없어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleSaveMemo() {
    if (!detail) return;
    setBusy(true);
    try {
      await updateMemberMemo(detail.id, memoText);
      if (addressText !== (detail.address ?? "")) await updateMemberAddress(detail.profileId, addressText);
      showToast("저장했어요");
      setDetail(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleSetGrade(gradeId: string | null) {
    if (!detail) return;
    setBusy(true);
    try {
      await updateMemberGrade(detail.id, gradeId);
      showToast("등급을 변경했어요");
      setDetail(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleSetStatus(status: "active" | "expired" | "dormant") {
    if (!detail) return;
    setBusy(true);
    try {
      await updateMemberStatus(detail.id, status);
      showToast(status === "active" ? "활성 회원으로 전환했어요" : status === "expired" ? "만료 처리했어요" : "휴면 처리했어요");
      setDetail(null);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleCreateGrade() {
    if (!centerId || !newGradeName.trim()) { setError("등급 이름을 입력해주세요"); return; }
    setBusy(true);
    try {
      await createGrade(centerId, newGradeName.trim(), newGradeColor);
      setNewGradeName("");
      showToast("등급을 추가했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDeleteGrade(g: Grade) {
    if (!confirm(`'${g.name}' 등급을 삭제할까요?\n이 등급을 쓰던 회원은 등급 없음이 됩니다.`)) return;
    setBusy(true);
    try {
      await deleteGrade(g.id);
      showToast("등급을 삭제했어요");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  function handleCsvDownload() {
    if (csvCols.length === 0) { setError("내보낼 항목을 1개 이상 선택해주세요"); return; }
    const csv = membersToCsv(members, csvCols);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const centerName = centers.find((c) => c.id === centerId)?.name ?? "회원목록";
    a.href = url;
    a.download = `${centerName}_회원목록_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setCsvSheet(false);
    showToast(`${members.length}명을 내보냈어요`);
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell manager-members-v2">
        <div className="back-header">
          <div className="side" />
          <div className="title">내 회원</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell manager-members-v2">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <div className="side" />
        <div className="title">내 회원</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="header-action" onClick={() => { setAddSheet(true); setSearchKw(""); setSearchResults([]); }}>+회원</button>
          <button className="header-action" onClick={() => setGradeSheet(true)}>등급</button>
        </div>
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

      {/* 검색 + 필터 */}
      <>
      <div className="mem-search" style={{ display: "flex", gap: 8 }}>
        <select className="input-field" style={{ flex: "0 0 96px" }} value={searchField} onChange={(e) => setSearchField(e.target.value as any)}>
          <option value="all">전체</option>
          <option value="name">이름</option>
          <option value="phone">휴대폰</option>
          <option value="address">주소</option>
        </select>
        <input
          className="input-field"
          style={{ flex: 1 }}
          placeholder={searchField === "address" ? "주소 검색" : searchField === "phone" ? "휴대폰 번호 검색" : "이름 검색"}
          value={keyword}
          onChange={(e) => { setKeyword(e.target.value); setLoading(true); }}
        />
      </div>

      <div className="mem-filters">
        <button className={`filter-chip ${!gradeFilter ? "on" : ""}`} onClick={() => setGradeFilter(null)}>등급 전체</button>
        {grades.map((g) => (
          <button key={g.id} className={`filter-chip ${gradeFilter === g.id ? "on" : ""}`} onClick={() => setGradeFilter(g.id)}>
            <span className="grade-dot" style={{ background: g.color ?? "#ccc" }} />{g.name}
          </button>
        ))}
      </div>

      <div className="mem-filters">
        <button className={`filter-chip ${!statusFilter ? "on" : ""}`} onClick={() => setStatusFilter(null)}>상태 전체</button>
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <button key={k} className={`filter-chip ${statusFilter === k ? "on" : ""}`} onClick={() => setStatusFilter(k)}>{v}</button>
        ))}
      </div>
      <div className="perm-guide" style={{ margin: "0 16px 4px", fontSize: 11.5 }}>
        수강권을 구매한 사람만 회원으로 표시돼요. 횟수 소진·기간 만료는 '만료', 휴면 처리 시 기간권 시간이 정지돼요.
      </div>

      <div className="mem-toolbar">
        <span className="mem-count">전체 {members.length}명</span>
        <div className="mem-tools member-toolbar-actions">
          <button className="quiet-action" disabled={busy} onClick={handleSync}>예약자 동기화</button>
          <button className="quiet-action" onClick={() => setCsvSheet(true)}>엑셀 내보내기</button>
        </div>
      </div>
      </>

      {error && <div className="error-toast">{error}<button onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <Loading />
      ) : members.length === 0 ? (
        statusFilter || keyword.trim() ? (
          <div className="daylist-empty" style={{ padding: "50px 20px", lineHeight: 1.7 }}>
            {keyword.trim()
              ? "검색 결과가 없어요"
              : statusFilter === "expired" ? "만료된 회원이 없어요"
              : statusFilter === "dormant" ? "휴면 회원이 없어요"
              : statusFilter === "active" ? "이용 중인 회원이 없어요"
              : "해당하는 회원이 없어요"}
          </div>
        ) : (
          <div className="empty-action">
            <div className="empty-action-text">
              아직 등록된 회원이 없어요.<br />
              회원을 추가하거나, 예약 이력이 있으면 동기화해보세요.
            </div>
            <button className="empty-action-btn" onClick={() => setAddSheet(true)}>+ 첫 회원 등록하기</button>
          </div>
        )
      ) : (
        <div className="mem-list">
          {members.map((m) => (
            <button key={m.id} className="mem-row" onClick={() => openDetail(m)}>
              <div className="mem-main">
                <div className="mem-name-line">
                  <span className="mem-name">{m.name}</span>
                  {m.gradeName && (
                    <span className="grade-badge" style={{ background: (m.gradeColor ?? "#999") + "22", color: m.gradeColor ?? "#666" }}>
                      {m.gradeName}
                    </span>
                  )}
                  {!m.appLinked && <span className="mem-flag">앱 미연결</span>}
                  {m.status === "dormant" && <span className="mem-status-badge dormant">휴면</span>}
                  {m.status === "expired" && <span className="mem-status-badge expired">만료</span>}
                </div>
                <div className="mem-sub">
                  {m.phone ?? "번호 없음"}
                  {m.passName && ` · ${m.passName}`}
                  {m.remainingCount != null && ` (${m.remainingCount}회)`}
                </div>
              </div>
              <span className="chevron">›</span>
            </button>
          ))}
        </div>
      )}

      {/* 회원 상세 시트 */}
      {detail && (
        <div className="sheet-overlay" onClick={() => setDetail(null)}>
          <div className="sheet member-detail-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{detail.name}</div>
            {detailLoading && <Loading />}
            {!detailLoading && (<>

            {/* 보유 수강권 / 상품 요약 (각 최대 3개 + 전체보기) */}
            {detailData && (() => {
              const passes = detailData.activePasses.filter((p) => p.kind !== "goods");
              const goods = detailData.activePasses.filter((p) => p.kind === "goods");
              return (
                <>
                  {passes.length > 0 && (
                    <div className="mem-pass-block">
                      <div className="mem-pass-head">
                        <span className="mem-pass-head-title">보유 수강권 {passes.length}</span>
                        {passes.length > 3 && (
                          <button className="mem-pass-more" onClick={() => setShowAllPasses((v) => !v)}>
                            {showAllPasses ? "접기" : "전체보기"}
                          </button>
                        )}
                      </div>
                      <div className="mem-pass-summary">
                        {(showAllPasses ? passes : passes.slice(0, 3)).map((p) => (
                          <div key={p.id} className="mem-pass-chip">
                            {p.name}{p.remaining != null ? ` · ${p.remaining}회` : ""} <span className="mem-pass-exp">~{p.expiresAt}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {goods.length > 0 && (
                    <div className="mem-pass-block">
                      <div className="mem-pass-head">
                        <span className="mem-pass-head-title">보유 상품 {goods.length}</span>
                        {goods.length > 3 && (
                          <button className="mem-pass-more" onClick={() => setShowAllGoods((v) => !v)}>
                            {showAllGoods ? "접기" : "전체보기"}
                          </button>
                        )}
                      </div>
                      <div className="mem-pass-summary">
                        {(showAllGoods ? goods : goods.slice(0, 3)).map((p) => (
                          <div key={p.id} className="mem-pass-chip goods">
                            {p.name}{p.remaining != null ? ` · ${p.remaining}회` : ""} <span className="mem-pass-exp">~{p.expiresAt}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {/* 탭 */}
            <div className="perm-tabs" style={{ marginTop: 4 }}>
              <button className={`perm-tab ${detailTab === "info" ? "on" : ""}`} onClick={() => setDetailTab("info")}>정보</button>
              <button className={`perm-tab ${detailTab === "reservations" ? "on" : ""}`} onClick={() => setDetailTab("reservations")}>예약</button>
              <button className={`perm-tab ${detailTab === "progress" ? "on" : ""}`} onClick={() => setDetailTab("progress")}>진도</button>
              <button className={`perm-tab ${detailTab === "payments" ? "on" : ""}`} onClick={() => setDetailTab("payments")}>결제</button>
            </div>

            {detailTab === "info" && (
              <>
                <div className="admin-row"><span className="k">전화</span><span className="v">{detail.phone ?? "-"}</span></div>
                <div className="admin-row"><span className="k">등록일</span><span className="v">{detail.registeredAt}</span></div>
                <div className="admin-row"><span className="k">최근출석</span><span className="v">{detail.lastAttendedAt ?? "-"}</span></div>
                <div className="admin-row"><span className="k">앱연결</span><span className="v">{detail.appLinked ? "연결됨" : "미연결"}</span></div>

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>등급</div>
                <div className="mem-filters" style={{ padding: 0 }}>
                  <button className={`filter-chip ${!detail.gradeId ? "on" : ""}`} disabled={busy} onClick={() => handleSetGrade(null)}>없음</button>
                  {grades.map((g) => (
                    <button key={g.id} className={`filter-chip ${detail.gradeId === g.id ? "on" : ""}`} disabled={busy} onClick={() => handleSetGrade(g.id)}>
                      <span className="grade-dot" style={{ background: g.color ?? "#ccc" }} />{g.name}
                    </button>
                  ))}
                </div>

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>회원 상태</div>
                <div className="mem-filters" style={{ padding: 0 }}>
                  <button className={`filter-chip ${detail.status === "active" ? "on" : ""}`} disabled={busy} onClick={() => handleSetStatus("active")}>활성</button>
                  <button className={`filter-chip ${detail.status === "dormant" ? "on" : ""}`} disabled={busy} onClick={() => handleSetStatus("dormant")}>휴면</button>
                  <button className={`filter-chip ${detail.status === "expired" ? "on" : ""}`} disabled={busy} onClick={() => handleSetStatus("expired")}>만료</button>
                </div>
                <div className="perm-guide" style={{ margin: "6px 0 0" }}>
                  휴면·만료 처리해도 기록은 남아요. 회원 목록 상단 상태 필터로 볼 수 있어요.
                </div>

                {detailData?.profileInfo && (() => {
                  const pi = detailData.profileInfo;
                  const rows = [
                    ["생년월일", pi.birthDate],
                    ["성별", pi.gender === "female" ? "여성" : pi.gender === "male" ? "남성" : pi.gender],
                    ["발 사이즈", pi.shoeSize ? `${pi.shoeSize}mm` : null],
                    ["옷 사이즈", pi.clothSize],
                    ["주소", pi.address],
                    ["추가 연락처", pi.phone],
                    ["특이사항", pi.memo],
                  ].filter(([, v]) => v);
                  if (rows.length === 0) return null;
                  return (
                    <>
                      <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
                        회원이 입력한 정보
                      </div>
                      <div className="mem-profile-info">
                        {rows.map(([k, v]) => (
                          <div key={k as string} className="mem-profile-row">
                            <span className="mem-profile-key">{k}</span>
                            <span className="mem-profile-val">{v}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()}

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>주소 (관리자 기록용)</div>
                <input className="input-field" placeholder="예: 서울 강남구 ..." value={addressText} onChange={(e) => setAddressText(e.target.value)} />

                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>관리자 메모 (회원에게 보이지 않음)</div>
                <input className="input-field" placeholder="예: 무릎 부상 이력" value={memoText} onChange={(e) => setMemoText(e.target.value)} />
                <div className="add-profile-actions">
                  <button className="ghost-btn" onClick={() => setDetail(null)}>닫기</button>
                  <button className="primary-btn" disabled={busy} onClick={handleSaveMemo}>메모 저장</button>
                </div>
              </>
            )}

            {detailTab === "reservations" && (
              <div className="mem-detail-list">
                {!detailData ? <Loading />
                  : detailData.reservations.length === 0 ? <div className="daylist-empty" style={{ padding: 20 }}>예약 내역이 없어요</div>
                  : detailData.reservations.map((r) => (
                    <div key={r.id} className="mem-detail-row">
                      <span className="mem-detail-date">{r.date}</span>
                      <span className="mem-detail-main">{r.title}</span>
                      <span className={`hist-status s-${r.status}`}>{RES_STATUS[r.status] ?? r.status}</span>
                    </div>
                  ))}
              </div>
            )}

            {detailTab === "progress" && (
              <div className="mem-detail-list">
                {!detailData ? <Loading />
                  : detailData.progress.length === 0 ? <div className="daylist-empty" style={{ padding: 20 }}>진도 기록이 없어요</div>
                  : detailData.progress.map((p) => (
                    <div key={p.id} className="mem-prog-row">
                      <div className="mem-prog-line">
                        <span className="mem-detail-date">{p.date}</span>
                        <span className="mem-detail-main">{p.skill}</span>
                      </div>
                      {p.note && <div className="mem-prog-note">{p.note}</div>}
                    </div>
                  ))}
              </div>
            )}

            {detailTab === "payments" && (
              <div className="mem-detail-list">
                {!detailData ? <Loading />
                  : detailData.payments.length === 0 ? <div className="daylist-empty" style={{ padding: 20 }}>결제 내역이 없어요</div>
                  : detailData.payments.map((p) => (
                    <div key={p.id} className="mem-detail-row">
                      <span className="mem-detail-date">{p.date}</span>
                      <span className="mem-detail-main">
                        {SALE_LABEL[p.saleType] ?? p.saleType}
                        {p.unpaid > 0 && <span className="drill-unpaid"> 미수 {p.unpaid.toLocaleString("ko-KR")}원</span>}
                      </span>
                      <span className={`mem-detail-amt ${p.amount < 0 ? "minus" : ""}`}>{p.amount.toLocaleString("ko-KR")}원</span>
                    </div>
                  ))}
              </div>
            )}
            </>)}
          </div>
        </div>
      )}

      {/* 등급 관리 시트 */}
      {gradeSheet && (
        <div className="sheet-overlay" onClick={() => setGradeSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">회원 등급 관리</div>

            {grades.length === 0 ? (
              <div className="daylist-empty" style={{ padding: "16px 0" }}>등급이 없어요</div>
            ) : (
              <div className="grade-list">
                {grades.map((g) => (
                  <div key={g.id} className="grade-item">
                    <span className="grade-dot" style={{ background: g.color ?? "#ccc" }} />
                    <span className="grade-name">{g.name}</span>
                    <button className="text-btn danger" disabled={busy} onClick={() => handleDeleteGrade(g)}>삭제</button>
                  </div>
                ))}
              </div>
            )}

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>등급 추가</div>
            <input className="input-field" placeholder="등급 이름 (예: VIP)" value={newGradeName} onChange={(e) => setNewGradeName(e.target.value)} />
            <div className="color-picker">
              {GRADE_COLORS.map((c) => (
                <button key={c} className={`color-dot ${newGradeColor === c ? "on" : ""}`} style={{ background: c }} onClick={() => setNewGradeColor(c)} />
              ))}
            </div>

            <div className="add-profile-actions">
              <button className="ghost-btn" onClick={() => setGradeSheet(false)}>닫기</button>
              <button className="primary-btn" disabled={busy} onClick={handleCreateGrade}>추가</button>
            </div>
          </div>
        </div>
      )}

      {/* 엑셀 내보내기 시트 */}
      {csvSheet && (
        <div className="sheet-overlay" onClick={() => setCsvSheet(false)}>
          <div className="sheet csv-export-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">엑셀 내보내기</div>
            <div className="sheet-lead">필요한 회원 정보만 선택해서 내보낼 수 있어요.</div>

            <div className="csv-cols">
              {CSV_COLUMNS.map((c) => (
                <label key={c.key} className="csv-col">
                  <input
                    type="checkbox"
                    checked={csvCols.includes(c.key)}
                    onChange={(e) =>
                      setCsvCols((prev) => e.target.checked ? [...prev, c.key] : prev.filter((k) => k !== c.key))
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>

            <div className="add-profile-actions csv-export-actions">
              <button className="ghost-btn" onClick={() => setCsvSheet(false)}>취소</button>
              <button className="primary-btn" onClick={handleCsvDownload}>{members.length}명 내보내기</button>
            </div>
          </div>
        </div>
      )}

      {/* 회원 추가 시트 */}
      {addSheet && (
        <div className="sheet-overlay" onClick={() => setAddSheet(false)}>
          <div className="sheet member-add-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">회원 추가</div>
            <div className="perm-guide" style={{ margin: "0 0 10px" }}>
              앱에 가입한 회원을 이름·전화번호로 검색해 센터에 등록해요.
              등록해야 수강권 발급·예약 대상이 됩니다.
            </div>
            <div className="hol-add member-add-search" style={{ padding: 0 }}>
              <div className="member-add-search-row">
                <input
                  className="input-field"
                  placeholder="이름 또는 전화번호 (2글자 이상)"
                  value={searchKw}
                  onChange={(e) => setSearchKw(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                />
                <button className="outline-action" disabled={searching} onClick={handleSearch}>검색</button>
              </div>
            </div>

            <div className="mem-detail-list" style={{ marginTop: 10 }}>
              {searching ? (
                <div className="daylist-empty" style={{ padding: 16 }}>검색 중...</div>
              ) : searchResults.length === 0 ? (
                <div className="daylist-empty" style={{ padding: 16 }}>
                  {searchKw ? "검색 결과가 없어요" : "이름으로 검색해보세요"}
                </div>
              ) : (
                searchResults.map((r) => (
                  <div key={r.profileId} className="mem-detail-row">
                    <span className="mem-detail-main">
                      {r.name}{r.phone ? ` · ${r.phone}` : ""}
                    </span>
                    <button className="outline-action compact" disabled={busy} onClick={() => handleAddMember(r.profileId)}>등록</button>
                  </div>
                ))
              )}
            </div>

            <div className="add-profile-actions" style={{ marginTop: 6 }}>
              <button className="ghost-btn" onClick={() => setAddSheet(false)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
