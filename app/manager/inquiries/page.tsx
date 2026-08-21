"use client";

/*
  매니저 1:1 문의
  - 자기 센터로 온 문의방 목록
  - 채팅방에서 답변 (사진/글, 실시간)
*/

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Loading from "../../components/Loading";
import InquiryChat from "../../components/InquiryChat";
import { fetchCenterThreads, type InquiryThread } from "../../../lib/inquiries";
import { fetchMyCenters, type ManagedCenter } from "../../../lib/manager";
import { fetchMyEffectivePermissionKeys, canSeeManagerMenu } from "../../../lib/roles";

export default function ManagerInquiriesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ManagerInquiriesPageContent />
    </Suspense>
  );
}

function ManagerInquiriesPageContent() {
  const [centers, setCenters] = useState<ManagedCenter[]>([]);
  const [threads, setThreads] = useState<InquiryThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<{ id: string; title: string; centerId: string } | null>(null);
  const [permsByCenter, setPermsByCenter] = useState<Record<string, Set<string>>>({});

  const searchParams = useSearchParams();

  // 센터마다 소속 역할이 다를 수 있어 관리 중인 센터별로 개인 유효 권한을 미리 계산해둔다
  // (오너인 센터는 계산 생략 — canSendForCenter에서 항상 true).
  useEffect(() => {
    const nonOwner = centers.filter((c) => !c.isOwner);
    if (nonOwner.length === 0) return;
    Promise.all(nonOwner.map((c) =>
      fetchMyEffectivePermissionKeys(c.managerCenterId, c.roleId).then((keys) => [c.id, keys] as const)
    )).then((pairs) => {
      setPermsByCenter(Object.fromEntries(pairs));
    }).catch(() => { /* 무시 — 실패 시 기본값(false)로 안전하게 처리됨 */ });
  }, [centers]);

  function canSendForCenter(centerId: string): boolean {
    const c = centers.find((x) => x.id === centerId);
    if (!c) return false;
    if (c.isOwner) return true;
    return permsByCenter[centerId]?.has("board.inquiry.comment") ?? false;
  }

  async function loadThreads() {
    const list = await fetchCenterThreads();
    setThreads(list);
    return list;
  }

  useEffect(() => {
    (async () => {
      const list = await fetchMyCenters();
      setCenters(list);
      if (list.length > 0) {
        const threadList = await loadThreads();
        // 신규 문의 알림에서 ?thread=<id>로 들어왔으면 목록이 아니라 그 스레드를 바로 연다(NOTIF-001 E-2)
        const threadParam = searchParams.get("thread");
        if (threadParam) {
          const found = threadList.find((t) => t.id === threadParam);
          if (found) setActive({ id: found.id, title: found.centerName + " · 회원 문의", centerId: found.centerId });
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function backToList() {
    setActive(null);
    await loadThreads();
  }

  if (centers.length === 0 && !loading) {
    return (
      <div className="app-shell">
        <div className="header">
          <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>1:1 문의</div>
        </div>
        <div className="daylist-empty" style={{ paddingTop: 80 }}>운영 중인 센터가 없어요</div>
      </div>
    );
  }

  if (loading) return <Loading />;

  if (active) {
    return (
      <div className="app-shell">
        <InquiryChat threadId={active.id} title={active.title} onBack={backToList} canSend={canSendForCenter(active.centerId)} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="header">
        <div className="title" style={{ fontSize: 20, fontWeight: 800 }}>1:1 문의</div>
      </div>

      {threads.length === 0 ? (
        <div className="empty-note" style={{ padding: "50px 20px", textAlign: "center", color: "var(--text-dim)" }}>
          아직 들어온 문의가 없어요.
        </div>
      ) : (
        <div className="thread-list">
          {threads.map((t) => (
            <button key={t.id} className="thread-row" onClick={() => setActive({ id: t.id, title: t.centerName + " · 회원 문의", centerId: t.centerId })}>
              <div className="thread-avatar">💬</div>
              <div className="thread-main">
                <div className="thread-top">
                  <span className="thread-name">{t.memberName ?? "회원"} - {t.centerName}</span>
                  {t.lastMessageAt && <span className="thread-time">{t.lastMessageAt}</span>}
                </div>
                <div className="thread-preview">{t.lastMessage ?? "새 문의"}</div>
              </div>
              {t.unread > 0 && <span className="thread-unread">{t.unread}</span>}
            </button>
          ))}
        </div>
      )}

      <div style={{ height: 20 }} />
    </div>
  );
}
