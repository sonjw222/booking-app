"use client";

/*
  매니저 - 진도 기록 (2단계)
  - 회원 선택 → 오늘 가르친 기술 여러 개 체크 → 저장
  - 회원의 진도 이력 표시
  - 진도표 관리 권한(customer.progress) 필요
  - 기술 목록은 1단계에서 만든 progress_categories 에서 실제로 불러옴
*/

import { useCallback, useEffect, useState } from "react";
import ManagerNav from "../../../components/ManagerNav";
import { useSearchParams } from "next/navigation";
import Loading from "../../../components/Loading";
import { fetchMyCenters, type ManagedCenter } from "../../../../lib/manager";
import {
  fetchCategories, buildCategoryTree, type CategoryNode,
  fetchProgressMembers, fetchMemberProgress, recordProgress, deleteProgressRecord,
  deleteProgressByDate, updateProgressNote,
  type ProgressRecord,
} from "../../../../lib/progress";

function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
function fmtMD(d: string) {
  return d.slice(5).replace("-", "/");
}

export default function ProgressRecordPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [members, setMembers] = useState<{ profileId: string; name: string }[]>([]);
  const searchParams = useSearchParams();
  const preProfile = searchParams.get("profile") ?? "";
  const [profileId, setProfileId] = useState(preProfile);
  const [history, setHistory] = useState<ProgressRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 오늘 가르친 기술 선택 상태
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lessonDate, setLessonDate] = useState(todayStr());
  const [note, setNote] = useState("");
  const [addSheet, setAddSheet] = useState(false);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2200); }

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

  const loadBase = useCallback(async () => {
    if (!centerId) return;
    setLoading(true); setError(null);
    try {
      const [cats, ms] = await Promise.all([
        fetchCategories(centerId), fetchProgressMembers(centerId),
      ]);
      setTree(buildCategoryTree(cats));
      setMembers(ms);
      if (preProfile && ms.some((m: any) => m.profileId === preProfile)) setProfileId(preProfile);
      if (ms.length > 0 && !profileId) setProfileId(ms[0].profileId);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { loadBase(); }, [loadBase]);

  const loadHistory = useCallback(async () => {
    if (!profileId) { setHistory([]); return; }
    try { setHistory(await fetchMemberProgress(profileId)); }
    catch (e: any) { setError(e.message); }
  }, [profileId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  function toggleSkill(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    if (!profileId) { setError("회원을 선택해주세요"); return; }
    if (selected.size === 0) { setError("가르친 기술을 1개 이상 선택해주세요"); return; }
    setBusy(true);
    try {
      // 같은 날짜 기존 기록을 지우고 다시 기록 → 수정/중복방지
      await deleteProgressByDate(profileId, lessonDate);
      await recordProgress(profileId, Array.from(selected), lessonDate, note.trim() || null);
      showToast("진도를 기록했어요");
      setSelected(new Set());
      setNote("");
      setAddSheet(false);
      await loadHistory();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm("이 진도 기록을 삭제할까요?")) return;
    setBusy(true);
    try { await deleteProgressRecord(id); showToast("삭제했어요"); await loadHistory(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  // 날짜별 카드: 삭제 (그 날 전체)
  async function handleDeleteDate(date: string) {
    if (!confirm(`${fmtMD(date)} 진도 기록을 삭제할까요?`)) return;
    setBusy(true);
    try { await deleteProgressByDate(profileId, date); showToast("삭제했어요"); await loadHistory(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  // 진도 추가 시트 열기 (새 기록)
  function openAddSheet() {
    setSelected(new Set());
    setNote("");
    setLessonDate(todayStr());
    setAddSheet(true);
  }

  // 날짜별 카드: 수정 (그 날 내용을 입력 시트로 불러오기)
  function handleEditDate(date: string, recs: ProgressRecord[]) {
    setLessonDate(date);
    setSelected(new Set(recs.map((r) => r.categoryId)));
    const noteRec = recs.find((r) => r.note);
    setNote(noteRec?.note ?? "");
    setAddSheet(true);
  }

  // 이력을 날짜별로 묶기
  const historyByDate: Record<string, ProgressRecord[]> = {};
  for (const r of history) {
    (historyByDate[r.lessonDate] ??= []).push(r);
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager">‹</a>
          <div className="title">진도 기록</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}

      <div className="back-header">
        <a className="side" href="/manager">‹</a>
        <div className="title">진도 기록</div>
        <a className="header-action" href="/manager/progress">기술 목록</a>
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

      {error && <div className="auth-msg error" style={{ margin: "8px 20px" }}>{error}</div>}

      {loading ? (
        <Loading />
      ) : tree.length === 0 ? (
        <div className="daylist-empty" style={{ paddingTop: 40 }}>
          먼저 기술 목록을 만들어주세요<br />
          <a href="/manager/progress" className="more-link" style={{ display: "inline-block", marginTop: 8 }}>진도표 기술 목록 ›</a>
        </div>
      ) : (
        <>
          {/* 회원 선택 */}
          <div className="menu-section-label">회원</div>
          <div style={{ padding: "0 20px 8px" }}>
            <select className="input-field" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {members.length === 0 && <option value="">회원이 없어요</option>}
              {members.map((m) => <option key={m.profileId} value={m.profileId}>{m.name}</option>)}
            </select>
          </div>

          {/* 진도 추가 버튼 */}
          <div style={{ padding: "4px 20px 12px" }}>
            <button className="primary-btn" disabled={!profileId} onClick={openAddSheet}>+ 진도 기록 추가</button>
          </div>

          <div className="divider" />

          {/* 진도 이력 (메인) */}
          <div className="menu-section-label">진도 이력</div>
          {history.length === 0 ? (
            <div className="daylist-empty" style={{ paddingTop: 20 }}>아직 기록이 없어요</div>
          ) : (
            <div className="prog-hist">
              {Object.entries(historyByDate).map(([date, recs]) => (
                <div key={date} className="prog-hist-day">
                  <div className="prog-hist-line">
                    <span className="prog-hist-date">{fmtMD(date)}</span>
                    <span className="prog-hist-skills-inline">
                      {recs.map((r) => (
                        <span key={r.id} className="skill-tag">{r.skillName}</span>
                      ))}
                    </span>
                  </div>
                  {[...new Set(recs.filter((r) => r.note).map((r) => r.note))].map((note, ni) => (
                    <div key={ni} className="prog-hist-note">{note}</div>
                  ))}
                  <div className="prog-hist-actions">
                    <button className="ph-edit" onClick={() => handleEditDate(date, recs)}>수정</button>
                    <button className="ph-del" disabled={busy} onClick={() => handleDeleteDate(date)}>삭제</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ height: 40 }} />
        </>
      )}

      {/* 진도 기록 입력 시트 */}
      {addSheet && (
        <div className="sheet-overlay" onClick={() => setAddSheet(false)}>
          <div className="sheet prog-add-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">진도 기록</div>

            <div className="menu-section-label" style={{ padding: "4px 0 6px" }}>수업 날짜</div>
            <input type="date" className="input-field" value={lessonDate} onChange={(e) => setLessonDate(e.target.value)} />

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>가르친 기술 (여러 개 가능)</div>
            <div className="prog-rec-wrap" style={{ padding: 0, maxHeight: 240, overflowY: "auto" }}>
              {tree.map((top) => (
                <div key={top.id} className="prog-rec-group">
                  <div className="prog-rec-top">{top.name}</div>
                  <div className="prog-rec-skills">
                    {top.children.length === 0 ? (
                      <span className="prog-rec-empty">세부기술 없음</span>
                    ) : (
                      top.children.map((c) => (
                        <button key={c.id} className={`skill-chip ${selected.has(c.id) ? "on" : ""}`} onClick={() => toggleSkill(c.id)}>
                          {c.name}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>메모 (선택)</div>
            <input className="input-field" placeholder="예: 왈츠점프 약간 애매함" value={note} onChange={(e) => setNote(e.target.value)} />

            <div className="add-profile-actions" style={{ marginTop: 14 }}>
              <button className="ghost-btn" onClick={() => setAddSheet(false)}>취소</button>
              <button className="primary-btn" disabled={busy || selected.size === 0} onClick={handleSave}>
                {busy ? "저장 중..." : selected.size === 0 ? "기술 선택" : `${selected.size}개 기록`}
              </button>
            </div>
          </div>
        </div>
      )}
      <ManagerNav />
    </div>
  );
}
