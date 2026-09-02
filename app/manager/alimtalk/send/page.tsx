"use client";

/*
  매니저 - 알림톡 보내기 (더보기 > 알림톡 > 알림톡 보내기)
  회원탭(app/manager/members/page.tsx)의 발송 시트와 같은 컴포저(AlimtalkComposer)·같은
  발송 함수(sendAlimtalkToMembers)를 재사용한다 — 여기는 회원탭 진입 없이 검색으로 대상을
  골라 바로 보내는 진입점.
*/

import { useCallback, useEffect, useState } from "react";
import Loading from "../../../components/Loading";
import AlimtalkComposer, {
  emptyAlimtalkBlocks, flattenAlimtalkBlocks, hasAlimtalkContent, type AlimtalkBlock,
} from "../../../components/AlimtalkComposer";
import { fetchMyCenters, type ManagedCenter } from "../../../../lib/manager";
import { fetchMembers, sendAlimtalkToMembers, type CenterMember } from "../../../../lib/members";

export default function AlimtalkSendPage() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [members, setMembers] = useState<CenterMember[]>([]);
  const [keyword, setKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [blocks, setBlocks] = useState<AlimtalkBlock[]>(emptyAlimtalkBlocks());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(m: string) { setToast(m); setTimeout(() => setToast(null), 2600); }

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
      setMembers(await fetchMembers(centerId));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [centerId]);

  useEffect(() => { load(); }, [load]);

  const filtered = members.filter((m) => {
    if (!keyword.trim()) return true;
    const kw = keyword.trim().replace(/-/g, "");
    return m.name.includes(keyword.trim()) || (m.phone ?? "").replace(/-/g, "").includes(kw);
  });

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds(new Set(filtered.map((m) => m.id)));
  }

  async function handleSend() {
    if (!centerId || selectedIds.size === 0 || !hasAlimtalkContent(blocks)) return;
    setSending(true);
    try {
      const targets = members.filter((m) => selectedIds.has(m.id));
      const content = flattenAlimtalkBlocks(blocks);
      const result = await sendAlimtalkToMembers(targets, content, centerId);
      const parts: string[] = [];
      if (result.sent > 0) parts.push(`${result.sent}명 발송`);
      if (result.skipped > 0) parts.push(`${result.skipped}명 번호 없음`);
      if (result.failed > 0) parts.push(`${result.failed}명 실패`);
      showToast(parts.join(" · "));
      setSelectedIds(new Set());
      setBlocks(emptyAlimtalkBlocks());
    } catch (e: any) { setError(e.message); }
    finally { setSending(false); }
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="back-header">
          <a className="side" href="/manager/alimtalk">‹</a>
          <div className="title">알림톡 보내기</div>
          <div className="side" />
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/manager/alimtalk">‹</a>
        <div className="title">알림톡 보내기</div>
        <div className="side" />
      </div>

      {centers.length > 1 && (
        <div className="center-switcher">
          {centers.map((c) => (
            <button key={c.id} className={`center-chip ${c.id === centerId ? "on" : ""}`} onClick={() => { setCenterId(c.id); setSelectedIds(new Set()); }}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {error && <div className="daylist-empty" style={{ margin: "0 20px 10px" }}>{error}</div>}

      <div style={{ padding: "0 20px 10px" }}>
        <input
          className="input-field"
          placeholder="이름 또는 전화번호로 검색"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      <div style={{ padding: "0 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="info">{selectedIds.size > 0 ? `${selectedIds.size}명 선택됨` : `${filtered.length}명`}</span>
        <button className="outline-action compact" onClick={selectAllFiltered} disabled={filtered.length === 0}>검색결과 전체 선택</button>
      </div>

      {loading ? (
        <Loading />
      ) : (
        <div className="mem-detail-list" style={{ padding: "0 20px" }}>
          {filtered.length === 0 ? (
            <div className="daylist-empty">회원이 없어요</div>
          ) : (
            filtered.map((m) => (
              <label key={m.id} className="mem-detail-row" style={{ cursor: "pointer" }}>
                <span className="mem-detail-main">
                  <input type="checkbox" checked={selectedIds.has(m.id)} onChange={() => toggle(m.id)} style={{ marginRight: 8 }} />
                  {m.name}{m.phone ? ` · ${m.phone}` : " · 번호없음"}
                </span>
              </label>
            ))
          )}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="sheet-overlay" onClick={() => !sending && setSelectedIds(new Set())}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">알림톡 보내기</div>
            <div className="perm-guide" style={{ margin: "0 0 10px" }}>
              선택한 {selectedIds.size}명에게 보내요. 전화번호가 없는 회원은 자동으로 건너뜁니다.
            </div>
            <AlimtalkComposer blocks={blocks} onChange={setBlocks} disabled={sending} />
            <div className="add-profile-actions">
              <button className="ghost-btn" disabled={sending} onClick={() => setSelectedIds(new Set())}>취소</button>
              <button className="primary-btn" disabled={sending || !hasAlimtalkContent(blocks)} onClick={handleSend}>
                {sending ? "발송 중..." : "발송"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
