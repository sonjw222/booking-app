"use client";

/*
  회원 1:1 문의
  - 내 문의방 목록
  - 새 문의: 센터 선택(내 수강권 센터 + 검색) → 채팅방
  - 채팅방: 사진/글 전송, 실시간
*/

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Loading from "../components/Loading";
import InquiryChat from "../components/InquiryChat";
import EmptyState from "../components/EmptyState";
import {
  fetchMyThreads, openThread, fetchInquiryCenters, searchCentersForInquiry,
  type InquiryThread, type SelectableCenter,
} from "../../lib/inquiries";

export default function InquiriesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <InquiriesPageContent />
    </Suspense>
  );
}

function InquiriesPageContent() {
  const [threads, setThreads] = useState<InquiryThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<{ id: string; title: string } | null>(null);

  // 새 문의 시트
  const [picker, setPicker] = useState(false);
  const [myCenters, setMyCenters] = useState<SelectableCenter[]>([]);
  const [searchKw, setSearchKw] = useState("");
  const [searchResults, setSearchResults] = useState<SelectableCenter[]>([]);

  const searchParams = useSearchParams();

  async function loadThreads() {
    setThreads(await fetchMyThreads());
  }

  useEffect(() => {
    (async () => {
      const list = await fetchMyThreads();
      setThreads(list);
      // 문의 답변 알림에서 ?thread=<id>로 들어왔으면 목록이 아니라 그 스레드를 바로 연다(NOTIF-001 E-2)
      const threadParam = searchParams.get("thread");
      if (threadParam) {
        const found = list.find((t) => t.id === threadParam);
        if (found) setActive({ id: found.id, title: found.centerName });
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="app-shell member-inquiries">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">1:1 문의</div>
        <div className="side" />
      </div>

      <div className="inquiry-head">
        <p>센터와 나눈 대화를 확인하세요</p>
        <button className="primary-btn" style={{ width: "auto", padding: "8px 14px", fontSize: 13 }} onClick={openPicker}>
          새 문의
        </button>
      </div>

      {threads.length === 0 ? (
        <EmptyState icon="message" title="아직 문의가 없어요"
          description="센터에 궁금한 내용을 편하게 물어보세요."
          action={<button className="ghost-btn" onClick={openPicker}>새 문의 작성</button>} />
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
    </div>
  );
}
