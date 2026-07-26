"use client";

/*
  회원 1:1 문의
  - 내 문의방 목록
  - 새 문의: 센터 선택(내 수강권 센터 + 검색) → 채팅방
  - 채팅방: 사진/글 전송, 실시간
*/

import { useEffect, useState } from "react";
import Loading from "../components/Loading";
import BottomNav from "../components/BottomNav";
import InquiryChat from "../components/InquiryChat";
import {
  fetchMyThreads, openThread, fetchInquiryCenters, searchCentersForInquiry,
  type InquiryThread, type SelectableCenter,
} from "../../lib/inquiries";

export default function InquiriesPage() {
  const [threads, setThreads] = useState<InquiryThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<{ id: string; title: string } | null>(null);

  // 새 문의 시트
  const [picker, setPicker] = useState(false);
  const [myCenters, setMyCenters] = useState<SelectableCenter[]>([]);
  const [searchKw, setSearchKw] = useState("");
  const [searchResults, setSearchResults] = useState<SelectableCenter[]>([]);

  async function loadThreads() {
    setThreads(await fetchMyThreads());
  }

  useEffect(() => {
    (async () => {
      await loadThreads();
      setLoading(false);
    })();
  }, []);

  async function openPicker() {
    setPicker(true);
    setSearchKw(""); setSearchResults([]);
    setMyCenters(await fetchInquiryCenters());
  }

  async function handleSearch(kw: string) {
    setSearchKw(kw);
    if (kw.trim().length >= 1) {
      setSearchResults(await searchCentersForInquiry(kw));
    } else {
      setSearchResults([]);
    }
  }

  async function startInquiry(c: SelectableCenter) {
    const threadId = await openThread(c.id);
    setPicker(false);
    setActive({ id: threadId, title: c.name });
  }

  async function openExisting(t: InquiryThread) {
    setActive({ id: t.id, title: t.centerName });
  }

  async function backToList() {
    setActive(null);
    await loadThreads();
  }

  if (loading) return <Loading />;

  // 채팅방 열림
  if (active) {
    return (
      <div className="app-shell">
        <InquiryChat threadId={active.id} title={active.title} onBack={backToList} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>1:1 문의</div>
        <button className="primary-btn" style={{ width: "auto", padding: "8px 14px", fontSize: 13 }} onClick={openPicker}>
          + 새 문의
        </button>
      </div>

      {threads.length === 0 ? (
        <div className="empty-note" style={{ padding: "50px 20px", textAlign: "center", color: "var(--text-dim)" }}>
          아직 문의가 없어요. 센터에 궁금한 걸 물어보세요!
        </div>
      ) : (
        <div className="thread-list">
          {threads.map((t) => (
            <button key={t.id} className="thread-row" onClick={() => openExisting(t)}>
              <div className="thread-avatar">{t.centerName.slice(0, 1)}</div>
              <div className="thread-main">
                <div className="thread-top">
                  <span className="thread-name">{t.centerName}</span>
                  {t.lastMessageAt && <span className="thread-time">{t.lastMessageAt}</span>}
                </div>
                <div className="thread-preview">{t.lastMessage ?? "대화를 시작해보세요"}</div>
              </div>
              {t.unread > 0 && <span className="thread-unread">{t.unread}</span>}
            </button>
          ))}
        </div>
      )}

      {/* 새 문의 - 센터 선택 시트 */}
      {picker && (
        <div className="sheet-overlay" onClick={() => setPicker(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">어느 센터에 문의할까요?</div>

            <input className="input-field" style={{ marginTop: 8 }}
              placeholder="센터 이름 검색"
              value={searchKw} onChange={(e) => handleSearch(e.target.value)} />

            {searchKw.trim() ? (
              <div className="center-pick-list">
                {searchResults.length === 0 ? (
                  <div className="perm-guide" style={{ margin: "10px 0" }}>검색 결과가 없어요</div>
                ) : searchResults.map((c) => (
                  <button key={c.id} className="center-pick-row" onClick={() => startInquiry(c)}>
                    {c.name}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>내 수강권 센터</div>
                <div className="center-pick-list">
                  {myCenters.length === 0 ? (
                    <div className="perm-guide" style={{ margin: "10px 0" }}>
                      위 검색으로 센터를 찾아 문의할 수 있어요.
                    </div>
                  ) : myCenters.map((c) => (
                    <button key={c.id} className="center-pick-row" onClick={() => startInquiry(c)}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </>
            )}

            <button className="ghost-btn" style={{ width: "100%", marginTop: 12 }} onClick={() => setPicker(false)}>닫기</button>
          </div>
        </div>
      )}

      <div style={{ height: 20 }} />
      <BottomNav />
    </div>
  );
}
